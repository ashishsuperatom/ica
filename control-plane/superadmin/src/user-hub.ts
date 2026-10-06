// ── A person's hub: every tab and device of theirs, in their own Durable Object ─────────────────────────────────────
//
// A person never connects to a project's Durable Object. The Worker sends each of their sockets (/_ws/<project>, with
// their sign-in) here; this keeps ONE link per project and surface to that ProjectDO (personLink / personMessage /
// personUnlink, by RPC) and the ProjectDO answers by RPC (deliver / closeLink). The protocol each tab speaks is the
// hub's own (clients/protocol.ts) — hello, envelopes {to, payload} — so no client knows the difference.
//
// What comes back goes only where it belongs, never to every tab:
//   • a reply to a request (reqId) → the tab that sent it; a reply that carries no reqId (the session list, the
//     inbox, a connector's stream, …) → the tab that sent the request it answers (REPLIES);
//   • an agent log (a log channel) → the tabs attached to that channel, and of those only the one that asked or that has
//     the log's session open (attaching says WHAT kind of log a tab wants, the session says WHOSE);
//   • an agent terminal (term:stream, <which>:chunk, a lane's events) → the tabs that attached to that terminal;
//   • an answer, or a session's news → the tab that asked, and every tab with that session open — so a person who asked
//     in the browser and opens the session on the phone gets it there too, and their other tabs do not;
//   • an error with no request → the tab that last sent something; the hub's own notices → every tab of the link.
// A tab's lanes (sessions it opened or asked in, logs and terminals it attached to) live on its socket so a hibernation
// wake finds them; who asked what is kept in `asked` (a reply can come long after its request).
//
// A large message comes as parts or as a parcel (clients/transport.ts), which hide its question and session: the hub
// joins them (reading a parcel from the bucket), decides from the whole message, and forwards the original frames —
// in order, one link at a time. It is also the person's INBOX (answer-buffer.ts, by project): questions as they leave,
// answers as they arrive; a device that was away pulls them (sync:req, answer:get, answer:ack) from here alone.

import { receiver } from '../../../clients/transport.js'
import { bucketStore } from './parcels.js'
import { AnswerBuffer } from './answer-buffer.js'

type Claims = { userId: string; email?: string; role?: string }
export interface Tab { tab: string; project: string; surface: 'runtime' | 'admin'; claims: Claims; wsId?: string; lanes: string[] }

const HUB = { id: 'hub', type: 'hub' }
const ASKED_TTL_MS = 6 * 3_600_000

/** The replies that carry no reqId, by the request they answer (a key ending in ':' is a prefix: a whole stream). */
const REPLIES: Record<string, string[]> = {
  'sessions:list': ['sessions:res'], 'session:load': ['session:load:res'], 'suggestions:req': ['suggestions:res'],
  'agents:list': ['agents:list:res'], 'session:reset': ['session:reset'], 'sync:req': ['sync:res'], 'answer:get': ['answer:res'],
  'turn:stop': ['turn:stopped'], 'index:build': ['index:'], 'connector:ask': ['connector:'], 'grounding:build': ['grounding:'],
  'analyst:sync': ['agent:hello', 'agent:events'],
}
const replyKeyOf = (t: string) => Object.values(REPLIES).flat().find((k) => (k.endsWith(':') ? t.startsWith(k) : t === k))
/** Which agent terminal a frame belongs to, if any. */
const terminalOf = (pl: any): string | undefined => {
  if (pl?.t === 'term:stream') return pl.which
  const m = typeof pl?.t === 'string' ? /^(analyst|connector|grounding):chunk$/.exec(pl.t) : null
  return m?.[1] ?? (typeof pl?.lane === 'string' && /^agent:/.test(String(pl?.t)) ? pl.lane : undefined)
}

/** The lanes a message belongs to (what a tab must have open to receive it), and who asked it. */
function laneOf(payload: any): { session?: string; lane?: string } {
  const session = payload?.session ?? payload?.sessionId ?? payload?.sid
  return { ...(typeof session === 'string' && session ? { session } : {}), ...(typeof payload?.lane === 'string' ? { lane: payload.lane } : {}) }
}

export function personHub(ctx: DurableObjectState, env_: Env) {
  const env = env_
  const sql = ctx.storage.sql
  const inbox = new AnswerBuffer(sql)
  const chains = new Map<string, Promise<unknown>>()   // per link: what it sends is handled in order
  const joiners = new Map<string, { r: ReturnType<typeof receiver>; whole: any }>()   // per link: parts being joined
  const held = new Map<string, string[]>()   // per message being joined: its frames, to forward once it is whole
  const projectStub = (pid: string) => (env as any).PROJECT.get((env as any).PROJECT.idFromName(`proj:${pid}`))
  const tabOf = (ws: WebSocket) => ws.deserializeAttachment() as Tab | null
  const save = (ws: WebSocket, t: Tab) => ws.serializeAttachment(t)
  const tabs = () => ctx.getWebSockets().map((ws) => [ws, tabOf(ws)] as const).filter((x): x is readonly [WebSocket, Tab] => !!x[1])
  const linkTabs = (project: string, wsId: string) => tabs().filter(([, t]) => t.project === project && t.wsId === wsId)
  const send = (ws: WebSocket, envelope: unknown) => { try { ws.send(typeof envelope === 'string' ? envelope : JSON.stringify(envelope)) } catch { /* closing */ } }
  const remember = (key: string, tab: string) => {
    sql.exec('INSERT OR REPLACE INTO asked (key, tab, at) VALUES (?, ?, ?)', key, tab, Date.now())
    sql.exec('DELETE FROM asked WHERE at < ?', Date.now() - ASKED_TTL_MS)
  }
  const askedBy = (key: string) => ([...sql.exec('SELECT tab FROM asked WHERE key = ?', key)][0] as any)?.tab as string | undefined
  const addLane = (ws: WebSocket, t: Tab, lane: string) => { if (!t.lanes.includes(lane)) { t.lanes = [...t.lanes, lane].slice(-50); save(ws, t) } }

  /** Link this tab's project and surface (again): the ProjectDO admits the person as on any socket, then welcomes. */
  async function link(ws: WebSocket, t: Tab): Promise<boolean> {
    const r: any = await projectStub(t.project).personLink({ project: t.project, userId: t.claims.userId, email: t.claims.email, role: t.claims.role, surface: t.surface })
    if (!r?.ok) { try { ws.close(r?.code ?? 4001, r?.reason ?? 'refused') } catch { /* closed */ } ; return false }
    t.wsId = r.wsId; save(ws, t)
    send(ws, { from: HUB, to: { id: r.wsId, type: r.type }, payload: r.welcome })
    return true
  }

  /** A frame from the project: joined with its other parts first if it is a part or a parcel, then routed whole. */
  async function take(project: string, wsId: string, data: string) {
    let env: any
    try { env = JSON.parse(data) } catch { return }
    const pl = env?.payload
    if (!(pl?.t === 'part' || (pl && typeof pl === 'object' && 'parcel' in pl))) { route(project, wsId, env, [data]); return }
    const key = `${project}|${wsId}`
    const j = joiners.get(key) ?? { r: receiver({ deliver: (w) => { j.whole = w }, parcels: bucketStore((env_ as any).PACKAGES, project) }), whole: null }
    joiners.set(key, j)
    const id = `${key}|${pl.t === 'part' ? String(pl.id) : 'parcel'}`
    held.set(id, [...(held.get(id) ?? []), data])
    j.whole = null
    await j.r.receive(pl)
    if (!j.whole) return   // more parts to come
    const frames = held.get(id) ?? [data]
    held.delete(id)
    route(project, wsId, { ...env, payload: j.whole }, frames)
    j.whole = null
  }

  /** A whole message from the project, to the tabs it belongs to (its frames forwarded as they came). */
  function route(project: string, wsId: string, env: any, frames: string[]) {
    const on = linkTabs(project, wsId)
    if (!on.length) { void projectStub(project).personUnlink(project, wsId).catch(() => {}); return }
    const pl = env?.payload ?? {}
    const kind = String(pl.t ?? '')
    if (kind === 'analyst:answer' && pl.qid && !pl.replay) inbox.recordAnswer(pl)
    else if (kind === 'followups' && pl.qid) inbox.recordFollowups(pl)
    const to = (tabs: (readonly [WebSocket, Tab])[]) => { for (const [ws] of tabs) for (const f of frames) send(ws, f) }
    const has = (lane: string) => on.filter(([, t]) => t.lanes.includes(lane))
    const { session } = laneOf(pl)
    const asker = pl.qid ? askedBy(`q:${pl.qid}`) : undefined
    const mine = (tabs: (readonly [WebSocket, Tab])[]) => tabs.filter(([, t]) => t.tab === asker || (session && t.lanes.includes(`session:${session}`)))
    // A reply to a request: the tab that sent it (if it is still open; else nobody — it asked, it left).
    if (pl.reqId !== undefined && pl.reqId !== null) { const tab = askedBy(`r:${pl.reqId}`); if (tab) return to(on.filter(([, t]) => t.tab === tab)) }
    // An agent log: the tabs attached to its channel — of those, the one that asked or has its session open.
    const channel = env?.channel ?? (env?.to?.type === 'log' ? env.to.channel : undefined)
    if (channel) { const attached = has(`log:${channel}`); return to(asker || session ? mine(attached) : attached) }
    // An agent terminal: the tabs watching it, and the tab whose request it streams.
    const terminal = terminalOf(pl)
    const replyKey = replyKeyOf(kind)
    const requester = replyKey ? askedBy(`t:${replyKey}`) : undefined
    if (terminal) { const watching = on.filter(([, t]) => t.lanes.includes(`term:${terminal}`) || t.tab === requester); if (watching.length) return to(watching) }
    // A reply without a reqId: the tab that sent its request.
    if (requester) return to(on.filter(([, t]) => t.tab === requester))
    // An answer, or a session's news: whoever asked, and every tab with that session open.
    if (asker || session) return to(mine(on))
    // An error that answers no request: the tab that last sent something.
    if (kind === 'error') { const last = askedBy('last'); return to(on.filter(([, t]) => t.tab === last)) }
    // The hub's own notices, and anything addressed to the person as a whole.
    to(on)
  }

  return {
    /** A socket from the Worker, its sign-in already verified there. */
    accept(request: Request): Response {
      const project = request.headers.get('x-sa-project') ?? ''
      const claims = JSON.parse(request.headers.get('x-sa-claims') ?? 'null') as Claims | null
      if (!project || !claims?.userId) return new Response('who and which project', { status: 400 })
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
      ctx.acceptWebSocket(server)
      save(server, { tab: crypto.randomUUID().slice(0, 12), project, surface: 'runtime', claims, lanes: [] })
      return new Response(null, { status: 101, webSocket: client })
    },

    async message(ws: WebSocket, raw: string | ArrayBuffer) {
      const t = tabOf(ws); if (!t) return
      let msg: any
      try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) } catch { send(ws, { from: HUB, payload: { t: 'error', reason: 'Invalid JSON' } }); return }
      if (msg?.type === 'hello') { t.surface = msg.role === 'admin' ? 'admin' : 'runtime'; save(ws, t); await link(ws, t); return }
      if (msg?.type === 'bye') { try { ws.close(1000, 'bye') } catch { /* closed */ } ; return }
      if (!t.wsId) { try { ws.close(4001, 'Not authenticated — send { type: "hello", ... } first') } catch { /* closed */ } ; return }
      const pl = msg?.payload ?? {}
      const kind = String(pl.t ?? '')
      // The inbox answers from here: the project (and its engine) are not asked.
      const reply = (payload: unknown) => send(ws, { from: HUB, to: { id: t.wsId, type: t.surface }, payload })
      if (kind === 'sync:req') { reply(inbox.sync(t.project)); return }
      if (kind === 'answer:get') { reply(inbox.get(t.project, pl.qid)); return }
      if (kind === 'answer:ack') { inbox.ack(t.project, pl.qids); return }
      if (kind === 'analyse' && pl.questionId) inbox.recordPending(t.project, pl)
      // What this tab asked, and what it now has open.
      remember('last', t.tab)
      if (typeof pl.reqId === 'string' || typeof pl.reqId === 'number') remember(`r:${pl.reqId}`, t.tab)
      if (pl.questionId) remember(`q:${pl.questionId}`, t.tab)
      for (const k of REPLIES[kind] ?? []) remember(`t:${k}`, t.tab)
      const { session } = laneOf(pl)
      if (session && (kind === 'analyse' || kind.startsWith('session:') || kind.startsWith('artifact:') || kind.startsWith('decision:'))) addLane(ws, t, `session:${session}`)
      if (kind === 'log:attach' && typeof pl.channel === 'string') addLane(ws, t, `log:${pl.channel}`)
      if (kind === 'term:attach' && typeof pl.which === 'string') addLane(ws, t, `term:${pl.which}`)
      if ((kind === 'log:detach' && typeof pl.channel === 'string') || (kind === 'term:detach' && typeof pl.which === 'string')) {
        const lane = kind === 'log:detach' ? `log:${pl.channel}` : `term:${pl.which}`
        t.lanes = t.lanes.filter((l) => l !== lane); save(ws, t)
        if (linkTabs(t.project, t.wsId).some(([w, o]) => w !== ws && o.lanes.includes(lane))) return   // another tab still watches it
      }
      let r: any = await projectStub(t.project).personMessage(t.project, t.wsId, msg)
      if (r?.relink && await link(ws, t)) r = await projectStub(t.project).personMessage(t.project, t.wsId!, msg)
    },

    async closed(ws: WebSocket) {
      const t = tabOf(ws); if (!t?.wsId) return
      const rest = linkTabs(t.project, t.wsId).filter(([w]) => w !== ws)
      if (!rest.length) await projectStub(t.project).personUnlink(t.project, t.wsId).catch(() => {})
    },

    /** What the project sends this person, to the tabs it belongs to. No tab left on the link: it is gone. */
    deliver(project: string, wsId: string, data: string): { ok: true } | { gone: true } {
      if (!linkTabs(project, wsId).length) return { gone: true }
      const key = `${project}|${wsId}`
      chains.set(key, (chains.get(key) ?? Promise.resolve()).then(() => take(project, wsId, data)).catch(() => {}))
      return { ok: true }
    },

    /** The project ends the link (the person was refused, or removed): every tab on it closes. */
    closeLink(project: string, wsId: string, code: number, reason: string) {
      for (const [ws] of linkTabs(project, wsId)) { try { ws.close(code, reason) } catch { /* closed */ } }
    },
  }
}
