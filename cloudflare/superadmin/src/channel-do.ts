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
        const r = await this.runTurn(projectId, serviceToken, question || 'which branches make money', 'selftest')
        return json({ ok: true, category: r.category, answer: r.answer })
      }

      // Real inbound: a parsed channel message. Run the turn, then reply to the channel.
      if (request.method === 'POST' && path === '/inbound') {
        const { projectId, channel, message } = await request.json() as { projectId: string; channel: string; message: InboundMessage }
        const adapter = channelAdapter(channel)
        if (!adapter) return json({ ok: false, error: `unknown channel ${channel}` }, 400)
        const cfg = (await this.state.storage.get<Config>('config')) ?? {}
        if (!cfg.serviceToken) return json({ ok: false, error: 'channel not configured (no serviceToken)' }, 409)
        const sessionId = `${channel}:${message.conversation.conversationId}`
        const secrets = cfg.secrets?.[channel] ?? {}
        const conv = message.conversation as ConversationRef
        // Typing indicator: post it immediately so the user knows the bot is working, and re-post on every
        // engine status/tick so it stays visible through a long build (a typing activity expires in a few
        // seconds). Fire-and-forget — a failed typing ping must never break the turn.
        const typing = () => { const s = adapter.renderStatus?.('working'); if (s) void adapter.sendReply(conv, s, secrets).catch(() => {}) }
        typing()
        const r = await this.runTurn(projectId, cfg.serviceToken, message.text, sessionId, typing)
        await adapter.sendReply(conv, adapter.renderAnswer(r.answer, r.category), secrets)
        return json({ ok: true })
      }

      return json({ ok: false, error: 'not found' }, 404)
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500)
    }
  }

  // Open an internal WS to the ProjectDO hub as a `runtime` client, ask one question,
  // resolve on analyst:answer. Event-driven; a timer is only the stall ceiling.
  private runTurn(projectId: string, serviceToken: string, question: string, sessionId: string, onStatus?: () => void):
    Promise<{ category?: string; answer: any }> {
    const stub = this.env.PROJECT.get(this.env.PROJECT.idFromName(`proj:${projectId}`))
    return stub.fetch(`https://do/_ws/${projectId}`, { headers: { Upgrade: 'websocket' } }).then((resp: Response) => {
      const ws = (resp as any).webSocket as WebSocket | undefined
      if (!ws) throw new Error('hub did not upgrade to a websocket')
      ws.accept()
      const qid = crypto.randomUUID()
      return new Promise<{ category?: string; answer: any }>((resolve, reject) => {
        let settled = false
        const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close() } catch { /* closing */ } fn() }
        const timer = setTimeout(() => done(() => reject(new Error('engine timed out'))), 6 * 60_000)
        ws.addEventListener('message', (evt: MessageEvent) => {
          let msg: any; try { msg = JSON.parse(evt.data as string) } catch { return }
          const p = msg?.payload ?? msg
          switch (p?.t) {
            case 'tick': case 'machine:waking': case 'analyst:status': onStatus?.(); return   // liveness / progress → keep typing alive
            case 'analyst:answer': return done(() => resolve({ category: p.category, answer: p.answer ?? {} }))
            case 'error': return done(() => reject(new Error(p.message ?? 'engine error')))
          }
        })
        ws.addEventListener('close', (e: CloseEvent) => done(() => reject(new Error(`hub closed (${e.code}${e.reason ? ': ' + e.reason : ''})`))))
        ws.addEventListener('error', () => done(() => reject(new Error('hub ws error'))))
        ws.send(JSON.stringify({ type: 'hello', role: 'runtime', token: serviceToken }))
        ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'analyse', question, projectId, sessionId, questionId: qid, role: 'user' } }))
      })
    })
  }
}
