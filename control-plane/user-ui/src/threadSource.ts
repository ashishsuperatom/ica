// WHERE A THREAD IS KEPT ("Views and sessions — one thread, two homes", docs/platform-architecture.md). The workspace draws
// one thing — a thread of steps — and asks its source for every change. Two sources, the same shape:
//
//   a session   kept by the platform: the answer history, unchangeable; every step written there
//   a view      kept by this browser: the steps' STATE in the history (Back and Forward walk them), the current one in
//               the address; the engine computes each step from the STATE it is given and keeps nothing. A view becomes
//               a session when something must be kept — a question to the agent, a decision recorded — by replaying
//               exactly what was done (its opening, each step's intent, each change made in place).

export type Request = (payload: Record<string, unknown>, onProgress?: (m: any) => void) => Promise<any>
export interface Answer_ { id: string; block: string; cause: string; markdown: string; blocks?: Record<string, unknown>; at: string }
export interface Intent_ { id: string; kind: 'structured' | 'language'; text?: string; ops?: any[]; call?: any; action?: any; to?: string; block?: string; at: string }
export interface View {
  id: string; agent: string; user: string; leaf: string; created: string
  blocks: { id: string; parent: string | null; answer: string | null; stateHash: string }[]
  states: Record<string, Record<string, unknown>>; answers: Answer_[]; intents: Intent_[]
}
export interface ProgramUIRef { package: string; hash: string; entry: string; blocks: string[]; head?: string[] }
export interface SessionMsg { t: string; reason?: string; view?: View; uis?: ProgramUIRef[]; actions?: { package: string; label: string; intent: any }[]; functions?: Record<string, string[]>; result?: { block: string; opened: boolean; stale?: boolean } }

export interface ThreadSource {
  kind: 'session' | 'view'
  /** The thread as it is now (a session from the platform; a view from the history, the address, or its agent's start). */
  load(): Promise<SessionMsg>
  /** A structured intent (ops, a call, an action) from a step: changes it in place, or opens a step below it. */
  intent(payload: Record<string, unknown>): Promise<SessionMsg>
  /** Make another step the current one. */
  goto(block: string): Promise<SessionMsg>
  /** Words to the agent: on a view, the view is kept first; `session` names the session the thread now is. */
  ask(text: string, block: string | undefined, onProgress: (m: any) => void): Promise<{ msg: SessionMsg; session?: string }>
  /** Keep the thread as a session (to record on it): the session and its current step. A session is kept already. */
  keep(): Promise<{ session: string; leaf: string; msg: SessionMsg }>
  /** What the decision memory has learned from a step like this one. */
  paths(view: View, block: string): Promise<any>
}

const newSessionId = () => `ses-${crypto.randomUUID()}`

export function sessionSource(request: Request, session: string): ThreadSource {
  return {
    kind: 'session',
    load: () => request({ t: 'session:get', session }),
    intent: (payload) => request({ t: 'session:intent', session, ...payload }),
    goto: (block) => request({ t: 'session:goto', session, block }),
    ask: async (text, block, onProgress) => ({ msg: await request({ t: 'session:intent', session, kind: 'language', text, ...(block ? { block } : {}) }, onProgress) }),
    keep: async () => { const msg = await request({ t: 'session:get', session }); return { session, leaf: msg?.view?.leaf ?? '', msg } },
    paths: (_v, block) => request({ t: 'decision:paths', session, block }),
  }
}

// ── A view: the thread in this browser ──────────────────────────────────────────────────────────────────────────────

/** What was done to make a step: its opening (the root) or the intent that opened it, then each change made in place. */
interface Made { open?: { startAt?: string; state?: Record<string, unknown> }; intent?: Record<string, unknown>; edits: Record<string, unknown>[] }
interface Local { view: View; extras: Omit<SessionMsg, 't' | 'view'>; made: Record<string, Made> }
const KEY = 'sa-view'

const toB64url = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
async function squeeze(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return toB64url(new Uint8Array(await new Response(stream).arrayBuffer()))
}
async function unsqueeze(s: string): Promise<string> {
  const stream = new Blob([fromB64url(s) as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Response(stream).text()
}
/** The address carries the current step's STATE when it is small enough to share; the history carries the thread. */
const ADDRESS_MAX = 6000

let counter = 0
const blockId = () => `vb${Date.now().toString(36)}${(counter++).toString(36)}`

export function viewSource(request: Request, agent: string, startAt: string | null): ThreadSource {
  let local: Local | null = null
  let opening: Promise<SessionMsg> | null = null
  const here = () => location.pathname
  const msgOf = (l: Local): SessionMsg => ({ t: 'session:view', view: l.view, ...l.extras })

  /** Keep the thread in the history entry (a new entry for a new step, the same one for a change in place), and the
   *  current step's STATE in the address when it fits. */
  const save = async (push: boolean) => {
    if (!local) return
    const snapshot = local
    const state = { ...(history.state ?? {}), [KEY]: { path: here(), local: snapshot } }
    let search = ''
    try { const v = await squeeze(JSON.stringify(snapshot.view.states[snapshot.view.leaf])); if (v.length <= ADDRESS_MAX) search = `?v=${v}` } catch { /* no compression here: the history keeps it */ }
    const url = `${here()}${search}`
    if (push) history.pushState(state, '', url); else history.replaceState(state, '', url)
  }
  const fromReply = (r: SessionMsg, made: Made): Local => {
    const v = r.view!
    return { view: v, extras: { uis: r.uis, actions: r.actions, functions: r.functions }, made: { [v.leaf]: made } }
  }

  // Back and Forward walk the thread: the history entry holds it.
  const restore = (): Local | null => { const h = history.state?.[KEY]; return h && h.path === here() ? h.local as Local : null }

  /** The first look at the view: from the STATE in the address (a link, a reload elsewhere), else the agent's start. */
  const firstLook = async (): Promise<SessionMsg> => {
    const v = new URLSearchParams(location.search).get('v')
    let state: Record<string, unknown> | undefined
    if (v) { try { state = JSON.parse(await unsqueeze(v)) } catch { state = undefined } }
    const r: SessionMsg = await request({ t: 'view:open', agent, ...(state ? { state } : startAt ? { startAt } : {}) })
    if (r?.t !== 'view:view' || !r.view) return r
    local = fromReply(r, { open: state ? { state } : startAt ? { startAt } : {}, edits: [] })
    await save(false)
    return msgOf(local)
  }

  return {
    kind: 'view',
    async load() {
      const saved = restore()
      if (saved) { local = saved; return msgOf(saved) }
      return (opening ??= firstLook().finally(() => { opening = null }))
    },
    async intent(payload) {
      if (!local) throw new Error('the view is not open')
      const v = local.view
      const base = String(payload.block ?? v.leaf)
      const opens = payload.to === 'new' || base !== v.leaf
      const did: Record<string, unknown> = { ...(payload.ops ? { ops: payload.ops } : {}), ...(payload.call ? { call: payload.call } : {}), ...(payload.action ? { action: payload.action } : {}) }
      const r: SessionMsg = await request({ t: 'view:intent', agent, state: v.states[base], ...did })
      if (r?.t !== 'view:view' || !r.view) return r
      const got = r.view
      const answer = got.answers[got.answers.length - 1]
      const intent = got.intents[got.intents.length - 1]
      const state = got.states[got.leaf]
      const hash = got.blocks.find((b) => b.id === got.leaf)?.stateHash ?? ''
      const id = opens ? blockId() : v.leaf
      const ans = answer ? { ...answer, id: `${answer.id}_${id}`, block: id } : null
      const next: View = {
        ...v, leaf: id,
        blocks: opens ? [...v.blocks, { id, parent: base, answer: ans?.id ?? null, stateHash: hash }] : v.blocks.map((b) => (b.id === id ? { ...b, answer: ans?.id ?? b.answer, stateHash: hash } : b)),
        states: { ...v.states, [id]: state },
        answers: ans ? [...v.answers, ans] : v.answers,
        intents: intent ? [...v.intents, { ...intent, ...(ans ? { id: ans.cause } : {}) }] : v.intents,
      }
      const made = opens ? { ...local.made, [id]: { intent: did, edits: [] } } : { ...local.made, [id]: { ...local.made[id], edits: [...(local.made[id]?.edits ?? []), did] } }
      local = { view: next, extras: { uis: r.uis ?? local.extras.uis, actions: r.actions ?? local.extras.actions, functions: r.functions ?? local.extras.functions }, made }
      await save(opens)
      return { ...msgOf(local), result: { block: id, opened: opens } }
    },
    async goto(block) {
      if (!local) throw new Error('the view is not open')
      local = { ...local, view: { ...local.view, leaf: block } }
      await save(true)
      return msgOf(local)
    },
    async ask(text, block, onProgress) {
      const k = await this.keep()
      if (k.msg?.t !== 'session:view') return { msg: k.msg }
      const msg = await request({ t: 'session:intent', session: k.session, kind: 'language', text, block: k.leaf }, onProgress)
      return { msg, session: k.session }
    },
    async keep() {
      if (!local) throw new Error('the view is not open')
      const v = local.view
      // The path down to the current step, each with what made it.
      const path: string[] = []
      for (let id: string | null = v.leaf; id; id = v.blocks.find((b) => b.id === id)?.parent ?? null) path.unshift(id)
      const steps = path.map((id, i) => (i === 0 ? { open: local!.made[id]?.open ?? {}, edits: local!.made[id]?.edits ?? [] } : { intent: local!.made[id]?.intent ?? {}, edits: local!.made[id]?.edits ?? [] }))
      const session = newSessionId()
      const msg: SessionMsg = await request({ t: 'session:keep', session, agent, path: steps })
      return { session, leaf: msg?.view?.leaf ?? '', msg }
    },
    paths(v, block) {
      const b = v.blocks.find((x) => x.id === block)
      const answer = b?.answer ? v.answers.find((a) => a.id === b.answer) : undefined
      return request({ t: 'decision:paths', view: { agent, state: v.states[block], stateHash: b?.stateHash ?? '', answer } })
    },
  }
}

/** A view's history entry changed under it (Back, Forward): the thread it holds, if it is this view's. */
export function viewFromHistory(state: any): SessionMsg | null {
  const h = state?.[KEY]
  return h && h.path === location.pathname ? { t: 'session:view', view: h.local.view, ...h.local.extras } : null
}
