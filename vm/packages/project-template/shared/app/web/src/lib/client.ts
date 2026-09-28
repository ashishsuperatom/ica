// The one way the browser reaches the application: a request in, its reply back, matched by reqId.
//
// Two clients share the interface. `HubClient` speaks to the engine through the hub over a WebSocket (the only
// transport allowed — the UI never talks to the engine directly). `MockClient` serves the recorded answers under
// public/mock/ without a socket, so the whole UI can be exercised without the hub.

import { readReply, readSaid, type Reply, type Request } from './wire'
import { isPart, receiver, sender, type Parcel } from '@superatom/transport'
import { Pending } from './pending'

export type Status = 'connecting' | 'open' | 'closed' | 'rejected' | 'mock'

export interface RequestOptions {
  /** A narrated line about this request, as the agent works — the latest, to show. Never a reply. */
  onBeat?: (text: string) => void
  /** A piece of the answer to this request, as the agent says it, before the reading lands. */
  onPart?: (text: string, blocks?: unknown[]) => void
}

export interface Client {
  status(): Status
  /** What to tell the person about the connection: empty when nothing is wrong. */
  message(): string
  onStatus(cb: () => void): () => void
  request(payload: Request, options?: RequestOptions): Promise<Reply>
  connect(): void
}

/** How long silence is tolerated: a part of a reply, a narrated line or an agent's frame about the request restarts the clock. A typed
 * question is read by an agent that can take minutes and says so as it goes; everything else answers in seconds. */
const REQUEST_MS = 90_000
const SAY_MS = 600_000
export const timeoutFor = (t: Request['t']) => (t === 'app:say' ? SAY_MS : REQUEST_MS)

export const config = (() => {
  const g = globalThis as { __HUB_URL__?: unknown; __PROJECT_ID__?: unknown }
  const hub = typeof g.__HUB_URL__ === 'string' ? g.__HUB_URL__ : (import.meta.env.VITE_HUB_URL as string | undefined) ?? ''
  const projectId = typeof g.__PROJECT_ID__ === 'string' ? g.__PROJECT_ID__ : (import.meta.env.VITE_PROJECT_ID as string | undefined) ?? ''
  const search = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
  const mock = import.meta.env.VITE_MOCK === '1' || search.get('mock') === '1'
  return { hub, projectId, mock }
})()

/** The token: localStorage['sa-token'], else ?token= (stored, then stripped from the address). */
export function readToken(): string {
  let token = ''
  try { token = localStorage.getItem('sa-token') ?? '' } catch { /* storage blocked */ }
  const url = new URL(location.href)
  const fromQuery = url.searchParams.get('token')
  if (fromQuery) {
    token = fromQuery
    try { localStorage.setItem('sa-token', token) } catch { /* storage blocked */ }
    url.searchParams.delete('token')
    history.replaceState(history.state, '', url.toString())
  }
  return token
}

const uuid = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`)

export class HubClient implements Client {
  private ws: WebSocket | null = null
  private state: Status = 'closed'
  private note = ''
  private listeners = new Set<() => void>()
  private pending = new Pending()
  private queue: string[] = []
  private retryMs = 2000
  private stopped = false

  private hub: string
  private projectId: string
  private token: string
  constructor(hub: string, projectId: string, token: string) { this.hub = hub; this.projectId = projectId; this.token = token }

  // The transport (parts and parcels) is @superatom/transport's, shared with the engine: this client only ever
  // sends and receives whole messages. Outgoing frames are wrapped in the hub envelope; incoming frames are joined
  // and resolved before `deliver` sees them.
  private out = sender({ send: (frame) => this.sendFrame(JSON.stringify({ to: { type: 'code-engine' }, payload: frame })) })
  private inn = receiver({
    deliver: (msg) => this.deliver(msg),
    parcels: { get: (p) => this.fetchParcel(p) },
  })

  /** A parcel's body, from the hub's HTTP side (the hub address with wss→https). */
  private async fetchParcel(p: Parcel): Promise<string> {
    const apiBase = this.hub.replace(/^ws(s?):/, 'http$1:')
    const res = await fetch(`${apiBase}/api/projects/${encodeURIComponent(this.projectId)}/parcels/${encodeURIComponent(p.hash)}?ticket=${encodeURIComponent(p.ticket)}`)
    if (!res.ok) throw new Error(`the parcel could not be fetched (${res.status})`)
    return res.text()
  }

  private sendFrame(frame: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame)
    else { this.queue.push(frame); this.connect() }
  }

  status() { return this.state }
  message() { return this.note }
  onStatus(cb: () => void) { this.listeners.add(cb); return () => { this.listeners.delete(cb) } }
  private set(state: Status, note = '') { this.state = state; this.note = note; for (const l of this.listeners) l() }

  connect() {
    if (this.stopped || this.ws) return
    if (!this.hub || !this.projectId) return this.set('rejected', 'No hub address or project id is configured.')
    if (!this.token) return this.set('rejected', 'No sign-in token. Open this page from the host, or add ?token= to the address.')
    this.set('connecting', this.note)
    const ws = new WebSocket(`${this.hub}/_ws/${this.projectId}?token=${encodeURIComponent(this.token)}`)
    this.ws = ws
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', token: this.token, role: 'runtime' }))
      // The channels the platform's user UI reads — narration (what an agent says as it works) and the composer's
      // log — fanned to this person's devices by the hub. They must be attached again on every reconnect.
      for (const channel of ['narration', 'composer-log']) ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t: 'log:attach', channel } }))
      this.retryMs = 2000
      this.set('open')
      for (const frame of this.queue.splice(0)) ws.send(frame)
    }
    ws.onmessage = (e) => {
      let raw: unknown
      try { raw = JSON.parse(String(e.data)) } catch { return }
      const frame = raw as { payload?: unknown }
      const payload = frame && typeof frame === 'object' && 'payload' in frame ? frame.payload : raw
      if (!payload || typeof payload !== 'object') return
      // A reply still arriving (the transport's `isPart`, the only look this client takes at a frame) restarts its
      // request's clock; the transport delivers the whole message when the last piece is in.
      if (isPart(payload)) this.pending.arm(payload.id)
      // Progress a person reads: a narrated line about a pending request (matched by reqId, or by the qid the request
      // was seen with — the channel's copy after a reconnect may carry the qid alone). The clock restarts and the
      // line goes to the placeholder, once. An agent's own frames (hello / event / chunk) are the raw work: they
      // restart the clock when they are about a pending request and are otherwise ignored. None is ever a reply.
      const f = payload as { t?: unknown; reqId?: unknown; qid?: unknown; text?: unknown }
      const reqId = typeof f.reqId === 'string' ? f.reqId : undefined
      const qid = typeof f.qid === 'string' ? f.qid : undefined
      if (f.t === 'narration') { this.pending.beat(reqId, typeof f.text === 'string' ? f.text : '', qid); return }
      if (f.t === 'app:said:part') { const g = payload as { blocks?: unknown }; this.pending.part(reqId, typeof f.text === 'string' ? f.text : '', qid, Array.isArray(g.blocks) ? g.blocks : undefined); return }
      if (f.t === 'agent:hello' || f.t === 'agent:event' || f.t === 'agent:chunk' || f.t === 'agent:status') { this.pending.touch(reqId, qid); return }
      if (f.t === 'log:attached' || f.t === 'log:line') return
      void this.inn.receive(payload)
    }
    ws.onerror = () => ws.close()
    ws.onclose = (e) => {
      this.ws = null
      this.inn.reset()
      // 4001 and 4003 are the hub's rejections: a dead token, or no access. Neither is worth retrying blindly.
      if (e.code === 4001) { this.stopped = true; this.fail('Your session was rejected (sign in again).'); return this.set('rejected', 'Your session was rejected. Sign in again from the host page.') }
      if (e.code === 4003) { this.stopped = true; this.fail('This account has no access to this project.'); return this.set('rejected', 'This account does not have access to this project.') }
      this.fail('The connection dropped before the reply arrived.')
      this.set('closed', 'Reconnecting…')
      setTimeout(() => this.connect(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 20_000)
    }
  }

  /** One whole payload from the hub: a control frame, or a reply for a waiting request. */
  private deliver(payload: unknown) {
    if (!payload || typeof payload !== 'object') return
    const p = payload as { t?: unknown; reqId?: unknown; parcelError?: unknown }
    if (p.t === 'machine:waking') { this.note = 'Starting the engine…'; for (const l of this.listeners) l(); return }
    if (p.t === 'welcome') { this.note = ''; for (const l of this.listeners) l(); return }
    const reqId = typeof p.reqId === 'string' ? p.reqId : null
    if (!reqId) return
    // Only a reply the client knows settles a request. Anything else carrying the request id — a frame this build
    // does not know yet, a stray copy — leaves the request waiting; it is never a failure.
    const reply = typeof p.parcelError === 'string' ? { t: 'app:error' as const, error: `The reply could not be fetched: ${p.parcelError}` } : readReply(payload)
    if (!reply) { this.pending.touch(reqId, undefined); return }
    const waiting = this.pending.take(reqId)
    if (waiting) waiting.resolve(reply)
  }

  private fail(why: string) { this.pending.failAll(why) }

  request(payload: Request, options: RequestOptions = {}): Promise<Reply> {
    if (this.state === 'rejected') return Promise.reject(new Error(this.note))
    const reqId = uuid()
    return new Promise<Reply>((resolve, reject) => {
      this.pending.add(reqId, { resolve, reject, timeoutMs: timeoutFor(payload.t), onBeat: options.onBeat, onPart: options.onPart })
      // The message, whole, with its id; the transport decides how it travels.
      void this.out.send({ ...payload, reqId })
    })
  }
}

/**
 * The recorded answers as an application: `app:catalog` from mock/catalog.json, and any start/move/ask from
 * mock/<focus>.json — the fixture for the requested focus with the requested question echoed, nothing applied.
 */
export class MockClient implements Client {
  private cache = new Map<string, Promise<unknown>>()
  status(): Status { return 'mock' }
  message() { return 'Mock data — recorded answers, nothing is live.' }
  onStatus() { return () => {} }
  connect() {}

  private fixture(name: string): Promise<unknown> {
    if (!this.cache.has(name)) {
      const base = import.meta.env.BASE_URL.replace(/\/?$/, '/')
      this.cache.set(name, fetch(`${base}mock/${encodeURIComponent(name)}.json`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`no fixture for "${name}"`)))))
    }
    return this.cache.get(name)!
  }

  async request(payload: Request, options: RequestOptions = {}): Promise<Reply> {
    await new Promise((r) => setTimeout(r, 120))
    if (payload.t === 'app:catalog') return readReply(await this.fixture('catalog')) ?? { t: 'app:error', error: 'bad catalog fixture' }
    if (payload.t === 'app:about') return readReply(await this.fixture('about')) ?? { t: 'app:error', error: 'bad about fixture' }
    if (payload.t === 'app:say') {
      // Two narrated lines, as `narration` frames would bring them, then the reading.
      await new Promise((r) => setTimeout(r, 600)); options.onBeat?.('Looking into your question…')
      await new Promise((r) => setTimeout(r, 600)); options.onBeat?.('Asking the graph for projects by RAG in the window.')
      await new Promise((r) => setTimeout(r, 300)); options.onPart?.('Reading the numbers now.')
      const now = new Date().toISOString()
      if (/cannot|can't|impossible/i.test(payload.text)) return { t: 'app:refused', reason: 'The reader wrote nothing in time (mock).' }
      return { t: 'app:said', said: readSaid({ text: payload.text, qid: 'mock', ms: 1500, question: payload.question, markdown: `**On "${payload.text}"** — read from *${payload.title || payload.question.focus}* (mock; nothing was computed).\n\n- The window and filters of the block above were kept.\n- Two figures were looked up on the graph.\n\n| what | value |\n|---|---|\n| first | 1,234 |\n| second | 56.7% |\n\nA reading is prose: it stands on the calls below, and a person moves on from the block above it.`, calls: [{ id: 'c1', canonical: 'projects by rag in the window', ms: 412, at: now }, { id: 'c2', canonical: 'remaining budget by pillar', ms: 388, at: now, refused: 'remaining budget is not summable across currencies' }] }) }
    }
    if (payload.t === 'app:members') {
      const typed = payload.typed.toLowerCase()
      // Grouped by label, as the server does: 'Closed' is recorded once per subsidiary, under a key of its own.
      const names = ['Alex Morgan', 'Priya Nair', 'Sam Whitlock', 'Chen Wei', 'Kristy Chong', 'Jorge Iriarte', 'Barbara Rees', 'Hayley-Fern Fraser', 'Closed', 'Closed', 'Closed', 'In Progress']
      const byLabel = new Map<string, string[]>()
      names.forEach((n, i) => { if (n.toLowerCase().includes(typed)) byLabel.set(n, [...(byLabel.get(n) ?? []), String(1000 + i)]) })
      return { t: 'app:members', dim: payload.dim, matches: [...byLabel].map(([label, keys]) => ({ key: keys.length === 1 ? keys[0] : keys, keys, label, ...(keys.length > 1 ? { recorded: keys.length } : {}) })) }
    }
    let focus: string
    let question: unknown
    // A start keeps the fixture's own opening filters unless the request names some, as the server's `asking` does.
    if (payload.t === 'app:start') { focus = payload.focus; question = payload.where ? { focus, where: payload.where } : { focus } }
    else if (payload.t === 'app:ask') { focus = payload.question.focus; question = payload.question }
    else {
      const f = payload.ops.find((o): o is Extract<typeof o, { op: 'focus' }> => o.op === 'focus')
      focus = f ? f.on : payload.question.focus
      question = { ...payload.question, focus }
    }
    let raw: unknown
    try { raw = await this.fixture(focus) } catch (e) { return { t: 'app:refused', reason: e instanceof Error ? e.message : String(e) } }
    const reply = readReply(raw)
    if (!reply) return { t: 'app:error', error: `bad fixture for "${focus}"` }
    if (reply.t !== 'app:answer') return reply
    const said = payload.t === 'app:start' ? `opened ${reply.answer.label.toLowerCase()}` : payload.t === 'app:move' ? `applied ${payload.ops.map((o) => o.op).join(', ')} (mock: not applied)` : undefined
    return { t: 'app:answer', answer: { ...reply.answer, question: { ...reply.answer.question, ...(question as object) }, ...(said ? { said } : {}) } }
  }
}

export function makeClient(): Client {
  if (config.mock) return new MockClient()
  return new HubClient(config.hub, config.projectId, readToken())
}
