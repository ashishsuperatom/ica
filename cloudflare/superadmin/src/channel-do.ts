// ── ChannelDO — the messaging turn, isolated from the ProjectDO ───────────────
// One per project (chan:<projectId>). It owns ALL channel logic so the ProjectDO
// (the WS hub) stays untouched: the ChannelDO connects to that hub as an ordinary
// `runtime` client over an INTERNAL DO→DO WebSocket, asks the engine, and — because
// a DO can hold a socket for minutes — receives the answer as a WS EVENT (never a
// timer) and posts it back to the channel via the adapter's reply API.
//
//   Worker ingress ──▶ ChannelDO ──WS(runtime)──▶ ProjectDO hub ◀──▶ code-engine
//                       • holds ConversationRef
//                       • on analyst:answer → adapter.renderAnswer → adapter.sendReply
//
// Config (per project) is stored in DO state: the hub service token + per-channel
// secrets (bot appId/secret). Set once at onboarding via /config.

import { channelAdapter, type ChannelSecrets, type ConversationRef, type InboundMessage } from '../../../clients/messaging/index.js'

type Config = { serviceToken?: string; secrets?: Record<string, ChannelSecrets> }
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const retryable = (e: Error) => Object.assign(e, { retryable: true })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ChannelDO {
  constructor(private state: DurableObjectState, private env: any) {}

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    try {
      // Store per-project config (hub service token + channel secrets). Onboarding only.
      if (request.method === 'POST' && path === '/config') {
        const body = await request.json() as Config
        const cur = (await this.state.storage.get<Config>('config')) ?? {}
        await this.state.storage.put('config', { ...cur, ...body, secrets: { ...(cur.secrets ?? {}), ...(body.secrets ?? {}) } })
        return json({ ok: true })
      }

      // TEST-ONLY: run one engine turn synchronously and return the answer JSON — no
      // channel reply. Proves the DO↔hub↔engine loop in Cloudflare without Azure.
      // The service token is supplied in the body (it IS the credential).
      if (request.method === 'POST' && path === '/selftest') {
        const { projectId, serviceToken, question } = await request.json() as any
        if (!projectId || !serviceToken) return json({ ok: false, error: 'projectId + serviceToken required' }, 400)
        const r = await this.runTurnRetrying(projectId, serviceToken, question || 'which branches make money', 'selftest', crypto.randomUUID())
        return json({ ok: true, category: r.category, answer: r.answer })
      }

      // Real inbound: a parsed channel message. Verify authenticity, run the turn, reply to the channel.
      if (request.method === 'POST' && path === '/inbound') {
        const { projectId, channel, message, authToken } = await request.json() as { projectId: string; channel: string; message: InboundMessage; authToken: string | null }
        const adapter = channelAdapter(channel)
        if (!adapter) return json({ ok: false, error: `unknown channel ${channel}` }, 400)
        const cfg = (await this.state.storage.get<Config>('config')) ?? {}
        if (!cfg.serviceToken) return json({ ok: false, error: 'channel not configured (no serviceToken)' }, 409)
        const secrets = cfg.secrets?.[channel] ?? {}
        // Verify the request really came from the channel for THIS bot — BEFORE touching the hub, so a forged
        // request never wakes the engine or gets a reply.
        if (!(await adapter.verifyInbound(authToken ?? null, secrets))) return json({ ok: false, error: 'unauthorized' }, 401)
        // Register the pending turn (qid → conversation ref) in DO storage: a durable queue so we always know
        // which conversation to answer when the result lands, and so the reply happens exactly once. NEVER wait
        // on the reflex/analyst here — a turn can take minutes; ack (200) immediately and reply in the background.
        const qid = crypto.randomUUID()
        await this.state.storage.put(`pending:${qid}`, { channel, conv: message.conversation, question: message.text, createdAt: Date.now() })
        void this.handleTurn(qid, projectId, cfg.serviceToken, channel, message, secrets)
        return json({ ok: true })
      }

      return json({ ok: false, error: 'not found' }, 404)
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500)
    }
  }

  // Own one turn's whole lifecycle OFF the request path: keep the typing indicator alive, wait for the engine
  // (up to a ceiling well ABOVE any engine timeout, so we never give up before it does), then reply to the
  // stored conversation — or an error card if it truly failed. Idempotent via the pending record: we reply only
  // if this qid is still pending, then clear it, so a turn is answered exactly once.
  private async handleTurn(qid: string, projectId: string, serviceToken: string, channel: string, message: InboundMessage, secrets: ChannelSecrets): Promise<void> {
    const adapter = channelAdapter(channel)!
    const conv = message.conversation as ConversationRef
    const sessionId = `${channel}:${conv.conversationId}`
    const typing = () => { const s = adapter.renderStatus?.('working'); if (s) void adapter.sendReply(conv, s, secrets).catch(() => {}) }
    typing()
    let reply: unknown
    try {
      const r = await this.runTurnRetrying(projectId, serviceToken, message.text, sessionId, qid, typing)
      reply = adapter.renderAnswer(r.answer, r.category)
    } catch (err: any) {
      reply = adapter.renderAnswer({ status: 'error', answer: `Sorry — I couldn't finish that. (${String(err?.message ?? err).slice(0, 160)})` } as any)
    }
    if (await this.state.storage.get(`pending:${qid}`)) {       // reply once
      await this.state.storage.delete(`pending:${qid}`)
      await adapter.sendReply(conv, reply, secrets).catch(() => {})
    }
  }

  // Ask one question, retrying a connection drop (the cold-wake case): the first attempt starts the machine
  // waking, and by the second attempt (~12-20s later) the engine is up and answers fast. onStatus keeps the
  // typing indicator alive across attempts. Only connection-level failures retry; an engine error does not.
  private async runTurnRetrying(projectId: string, serviceToken: string, question: string, sessionId: string, qid: string, onStatus?: () => void):
    Promise<{ category?: string; answer: any }> {
    const delays = [0, 12_000, 20_000]   // attempt 1 immediate; then wait for the wake to finish
    let lastErr: any
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) { onStatus?.(); await sleep(delays[i]) }
      try { return await this.runTurn(projectId, serviceToken, question, sessionId, qid, onStatus) }
      catch (e: any) { lastErr = e; if (!e?.retryable) throw e }
    }
    throw lastErr
  }

  // Open an internal WS to the ProjectDO hub as a `runtime` client, ask one question,
  // resolve on analyst:answer. Event-driven; a timer is only the stall ceiling.
  private runTurn(projectId: string, serviceToken: string, question: string, sessionId: string, qid: string, onStatus?: () => void):
    Promise<{ category?: string; answer: any }> {
    const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${projectId}`))
    return stub.fetch(`https://do/_ws/${projectId}`, { headers: { Upgrade: 'websocket' } }).then((resp: Response) => {
      const ws = (resp as any).webSocket as WebSocket | undefined
      if (!ws) throw new Error('hub did not upgrade to a websocket')
      ws.accept()
      return new Promise<{ category?: string; answer: any }>((resolve, reject) => {
        let settled = false
        const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close() } catch { /* closing */ } fn() }
        // Ceiling well ABOVE any engine timeout, so we never give up before the engine does (the engine's own
        // timeout may be raised or made dynamic). A close/error before this fires is the cold-wake case (retried).
        const timer = setTimeout(() => done(() => reject(new Error('engine timed out'))), 15 * 60_000)
        ws.addEventListener('message', (evt: MessageEvent) => {
          let msg: any; try { msg = JSON.parse(evt.data as string) } catch { return }
          const p = msg?.payload ?? msg
          switch (p?.t) {
            case 'tick': case 'machine:waking': case 'analyst:status': onStatus?.(); return   // liveness / progress → keep typing alive
            case 'analyst:answer': return done(() => resolve({ category: p.category, answer: p.answer ?? {} }))
            case 'error': return done(() => reject(new Error(p.message ?? 'engine error')))
          }
        })
        // A close/error before an answer is almost always the internal WS dropping during a ~30s cold machine
        // wake (the socket goes silent while the engine boots, and an intermediary cuts it). Mark these
        // RETRYABLE — the caller reconnects after the machine is up and gets a fast answer. A timeout is NOT
        // retryable (that's a genuinely long build, not a wake).
        ws.addEventListener('close', (e: CloseEvent) => done(() => reject(retryable(new Error(`hub closed (${e.code}${e.reason ? ': ' + e.reason : ''})`)))))
        ws.addEventListener('error', () => done(() => reject(retryable(new Error('hub ws error')))))
        ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token: serviceToken }))
        ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'analyse', question, projectId, sessionId, questionId: qid, role: 'user' } }))
      })
    })
  }
}
