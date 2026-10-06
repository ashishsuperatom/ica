// A PROJECT'S OWN APPLICATION. A project may carry an application of its own — a state machine over its domains'
// programs, its blocks — at <project>/app/server/index.mjs. It is not part of the platform and the platform
// knows nothing of its vocabulary: every payload whose `t` begins with `app:` is handed to it whole, with the seams
// it may use — the data manager, a domain's programs, who is asking, the composer for a question in prose — and a way to reply
// on the same envelope. Nothing else changes hands. A project without one gets the platform's default UI.
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createComposer, type Composer, type QueryRecord } from './agents/composer/index.js'
import { createNarrator, capResultData, isDataCall } from './agents/narrator/index.js'
import { pick, compose, place, remember, recordQuestion, placeForRunning, domainsOf } from './knowledge.js'
import type { AgentEvent } from './ica/session.js'
import { personOf } from './identity.js'

export interface AppSeamDeps {
  project: string
  projectDir: string
  datasource: string
  /** Reply on the wire: the wire decides how a large message travels. */
  send: (to: any, msg: Record<string, unknown>) => void
  /** The workspace root the threads' directories live under. */
  workspaceRoot: string
  /** The shared workspace the narrator runs in — the same one the composer's narration uses. */
  narratorCwd: string
  /** Something done, for the platform's warehouse (sent to the project's DO). */
  record?: (kind: string, key: string, data: unknown) => void
  /** The shared server every composer is a client of (cheap per session); left out, each makes its own. */
  icaBaseUrl?: string
  /** What the composer is built with now (harness/provider/model): a session's composer built with something else is
   *  made again at its next question — never mid-answer. */
  composerStamp?: () => string
  /** The asker's data access for the turn (access.ts readerFor). */
  readerFor?: (from: any) => Promise<import('./agents/composer/index.js').Reader>
}

export interface Said {
  markdown: string | null
  /** The blocks the markdown's marker lines name, resolved from the thread's folder. */
  blocks: unknown[]
  /** The graph calls the answer was read from. */
  calls: Array<{ id: string; canonical: string | null; ms: number; at: number; refused: boolean; error: string | null }>
  /** The queries the composer sent to sources itself, outside the graph: the parts that did not stand on the model. */
  queries: QueryRecord[]
  ms: number
  /** The turn was stopped (turn:stop) before it answered. */
  stopped?: boolean
  /** The agent that answered, and how the thread came to it. */
  agent?: { name: string | null; how: string; terms?: string[] }
}

/** A turn is capped: a question that takes longer than this is not being answered, it is being wandered. */
/** A last-resort cap, so a wedged agent cannot hold its session for good. */
const MAX_SAY_MS = Number(process.env.COMPOSER_MAX_TURN_MS) || 30 * 60_000
/** Composers idle this long are let go; the thread directory and its data session stay, so a later question resumes there. */
const IDLE_MS = 30 * 60_000

export function createAppSeam(d: AppSeamDeps) {
  let app: Promise<{ handle: (payload: any, ctx: any) => Promise<unknown> } | null> | null = null
  const file = join(d.projectDir, 'app', 'server', 'index.mjs')
  const present = () => existsSync(file)
  async function load(fresh = false) {
    if (!present()) return null
    const mod = await import(`${pathToFileURL(file).href}${fresh ? `?t=${Date.now()}` : ''}`)
    return typeof mod.handle === 'function' ? mod : (typeof mod.default?.handle === 'function' ? mod.default : null)
  }
  if (present()) console.log(`[app] this project carries an application (${file}); app:* payloads go to it`)

  // ONE COMPOSER PER THREAD, as the chat has one per conversation: the thread id is its session, so a follow-up
  // lands where the earlier question was answered. Idle composers are let go; their directories stay.
  const composers = new Map<string, { composer: Promise<Composer>; domain: string | null; lastUsed: number; routed?: unknown; builtWith: string }>()
  // The thread's FIRST question picks its agent by its words (knowledge.ts pick — the same router the chat uses), and
  // the thread keeps that agent: what a person asks next follows from what they asked first, whatever screen it is
  // typed on.
  const composerFor = async (sid: string, question: string, domainName?: string | null) => {
    let e = composers.get(sid)
    const want = d.composerStamp?.() ?? ''
    if (e && e.builtWith !== want) {
      console.log(`[app] thread ${sid.slice(0, 8)}: the agent profile changed (${e.builtWith} → ${want}) — a fresh composer`)
      const old = e.composer; composers.delete(sid); e = undefined
      old.then((c) => { try { c.session.stop() } catch { /* gone */ } }).catch(() => {})
    }
    if (!e) {
      // An agent's session is on its agent's domain; otherwise the thread's first question picks it.
      const fixed = domainName ? (await domainsOf(d.projectDir)).find((x) => x.name === domainName) ?? null : null
      const picked = fixed ? { domain: fixed, route: null } : await pick(d.projectDir, question)
      const domain = picked.domain
      const composer = (async () => {
        const k = domain ? await compose(d.projectDir, domain) : null
        const c = await createComposer({ root: d.workspaceRoot, projectId: d.project, managerUrl: d.datasource, projectDir: d.projectDir, sessionId: sid, reference: k?.text, tools: domain?.tools, ...(d.icaBaseUrl ? { ica: { baseUrl: d.icaBaseUrl } } : {}) })
        // What the session was made from, noted in its folder (which domain, the hashes it read): the inspector's sessions and drift read it.
        if (k && domain) await remember(k, domain, c.cwd, picked.route).catch(() => {})
        if (k) { await place(k, c.cwd); console.log(`[app] thread ${sid.slice(0, 8)} is "${k.domain}" (${k.text.length} chars) · routed ${picked.route?.ranked.slice(0, 2).map((x) => `${x.domain} ${x.score}`).join(' · ') ?? '—'}`) }
        return c
      })()
      e = { composer, domain: domain?.name ?? null, lastUsed: Date.now(), routed: picked.route, builtWith: want }; composers.set(sid, e)
    }
    e.lastUsed = Date.now()
    return e
  }
  setInterval(() => { const now = Date.now(); for (const [sid, e] of composers) if (now - e.lastUsed > IDLE_MS) { composers.delete(sid); e.composer.then((c) => { try { c.session.stop() } catch { /* gone */ } }).catch(() => {}) } }, 60_000).unref()

  /** A question in prose, asked from a screen of the application: the composer of that thread answers it. While it
   *  works, what it does goes back as beats — to the asking page, which shows the last line and keeps waiting, and to
   *  the project's agent log on the composer's lane, so the work can be watched where every agent's work is watched. */
  // THE TURN IN EACH SESSION: one at a time (a second question waits for the first, or is told so), and stoppable.
  const turning = new Map<string, { qid: string; stop: (why: string) => void }>()

  /** Stop the turn running in a session (turn:stop); whether there was one. */
  function stop(threadId: string, why = 'stopped by the person'): boolean {
    const t = turning.get(threadId); if (!t) return false
    t.stop(why); return true
  }

  async function say(text: string, context: string, o: { qid: string; threadId: string; focus?: string | null; reqId?: string; from?: any; domain?: string | null; keepContext?: boolean; channel?: string }): Promise<Said> {
    const t0 = Date.now()
    if (turning.has(o.threadId)) throw new Error('Already answering a question in this session — one at a time.')
    let stopped: string | null = null
    let stopNow: () => void = () => {}
    turning.set(o.threadId, { qid: o.qid, stop: (why) => { if (stopped) return; stopped = why; stopNow() } })
    // LIVENESS: a tick every few seconds, so whoever asked knows the turn is alive through a long silence.
    const tick = setInterval(() => { if (o.from) d.send(o.from, { t: 'tick', sid: o.threadId, qid: o.qid }) }, 8000)
    try {
    const entry = await composerFor(o.threadId, text, o.domain)
    const composer = await entry.composer
    const routedNow = entry.routed as { ranked: { domain: string; terms: string[] }[] } | undefined
    recordQuestion(d.projectDir, { session: o.threadId, qid: o.qid, question: text, domain: entry.domain, how: routedNow ? 'routed' : 'session', ...(routedNow ? { ranked: routedNow.ranked } : {}) })
    entry.routed = undefined
    const agent = { name: entry.domain, how: routedNow ? 'routed' : 'session', ...(routedNow?.ranked?.[0]?.terms ? { terms: routedNow.ranked[0].terms.slice(0, 6) } : {}) }
    // A thread that knows a domain answers the question as asked, in the domain's own terms: the screen is not
    // passed in, so its wording can neither help nor mislead. A thread without a domain is given the screen.
    if (entry.domain && !o.keepContext) context = 'None: the question stands on its own.'
    // PROGRESS GOES OUT EXACTLY AS A CHAT TURN'S DOES. The raw work — output and events — travels on the agent
    // log channel under the composer's lane, for whoever watches agents work. What a person reads while waiting is
    // the narrator's: every few seconds it turns the activity since the last beat into one line, sent as
    // `narration` to the page that asked (with the request id, so the page knows which reading it belongs to) and
    // to the owner's narration channel, which survives a reconnect.
    const log = (frame: Record<string, unknown>) => d.send({ type: 'log', channel: 'composer-log' }, { ...frame, lane: 'composer', qid: o.qid, sid: o.threadId, agent: 'composer' })
    const beat = (text: string) => {
      console.log(`[beat] ${o.qid.slice(0, 8)} → ${o.from?.id ?? 'no page'}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
      const frame = { t: 'narration', text, qid: o.qid, sid: o.threadId, reqId: o.reqId }
      if (o.from) d.send(o.from, frame)
      d.send({ type: 'log', channel: 'narration' }, frame)
      if (o.channel) d.send({ type: 'channel' }, { t: 'channel:narration', channel: o.channel, qid: o.qid, text })   // Teams and other chat channels
    }
    log({ t: 'agent:event', ev: { kind: 'user', id: o.qid, text, done: true } })
    beat('Looking into your question…')
    const narrator = createNarrator({ cwd: d.narratorCwd })
    const activity: string[] = []
    let answering = false, recent: string[] = []
    let narrating = false
    const narration = setInterval(async () => {
      if (narrating || !activity.length) return
      narrating = true
      const since = activity.splice(0).join('\n')
      try {
        const line = await Promise.race([narrator.narrate(text, since, recent.slice(-3), { session: o.threadId, person: personOf(o.from) }), new Promise<null>((res) => setTimeout(() => res(null), 20_000))])
        if (line) { recent.push(line); beat(line) }
        else console.log(`[beat] ${o.qid.slice(0, 8)}: the narrator said nothing for ${since.length} chars of activity`)
      } catch (e: any) { console.log(`[beat] ${o.qid.slice(0, 8)}: the narrator failed — ${e?.message ?? e}`) } finally { narrating = false }
    }, 4000)
    const handlers = {
      onOutput: (chunk: string) => { activity.push(chunk); log({ t: 'agent:chunk', text: chunk }) },
      // A piece of the answer, as the agent says it, to the page that asked — before the whole reading lands.
      onAnswer: (text: string, blocks?: unknown[]) => { if (o.from) d.send(o.from, { t: 'app:said:part', text, qid: o.qid, sid: o.threadId, reqId: o.reqId, ...(blocks?.length ? { blocks } : {}) }) },
      onEvent: (ev: AgentEvent) => {
        ev.at ??= Date.now()
        // The narrator tells what the agent is doing, never the answer: once `:::answer` is said, what follows is not work.
        if (ev.kind === 'command') activity.push(String(ev.command ?? ''))
        else if (ev.kind === 'message' && !answering) {
          const t = String(ev.text ?? ''), m = t.match(/^[ \t]*:::answer[ \t]*$/m)
          if (m) answering = true
          const before = (m ? t.slice(0, m.index) : t).trim(); if (before) activity.push(before)
        }
        // What a data call RETURNED is what the narrator can say something with; a listing or a read is machinery.
        if (ev.kind === 'command' && ev.output?.trim() && isDataCall(ev.command)) activity.push(('RESULT: ' + capResultData(ev.output)).slice(0, 1800))
        log({ t: 'agent:event', ev })
      },
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const said = await Promise.race([
      composer.say(text, context, handlers, { qid: o.qid, person: personOf(o.from), ...(o.channel ? { where: `a ${o.channel} chat. A few short lines answer it best; the full report is attached to them.` } : {}), ...(d.readerFor ? { reader: await d.readerFor(o.from) } : {}) }).finally(() => { clearInterval(narration); try { narrator.stop() } catch { /* best-effort */ } }),
      new Promise<Said>((res) => { timer = setTimeout(() => { try { composer.session.stop() } catch { /* best effort */ }; res({ markdown: null, blocks: [], calls: [], queries: [], ms: Date.now() - t0 }) }, MAX_SAY_MS) }),
      new Promise<Said>((res) => { stopNow = () => { try { composer.session.stop() } catch { /* best effort */ }; res({ markdown: null, blocks: [], calls: [], queries: [], ms: Date.now() - t0, stopped: true }) } }),
    ])
    if (timer) clearTimeout(timer)
    // THE ANSWER IS COMMITTED IN ITS QUESTION'S OWN PLACE — <session>/<qid>/answer.md — and what is sent is that file,
    // read back: never a session-wide file a previous question could have left. The engine writes it from the answer
    // the composer committed (its `:::answer` message), once its work is finished.
    const committed = await commit(o.threadId, o.qid, said)
    if (committed !== undefined) said.markdown = committed
    // The turn to the platform's warehouse (through the project's DO): who asked what on which screen, the answer, the queries.
    d.record?.('agent.turn', o.qid, { qid: o.qid, session: o.threadId, asker: o.from?.userId ?? null, question: text, context, agent: 'composer', via: 'app', domain: agent?.name ?? null,
      queries: said.queries ?? [], answer: said.markdown, ms: Date.now() - t0 })
    return { markdown: said.markdown, blocks: said.blocks ?? [], calls: [], queries: said.queries ?? [], ms: Date.now() - t0, agent, ...(stopped ? { stopped: true } : {}) }
    } finally { clearInterval(tick); turning.delete(o.threadId) }
  }

  /** Commit a turn's answer at <projectDir>/sessions/<session>/<qid>/ (answer.md, and the blocks its markers name), and
   *  read it back: what is sent is what was written. undefined: there was nothing to commit, or the place is not valid. */
  async function commit(session: string, qid: string, said: { markdown: string | null; blocks?: unknown[]; queries?: unknown[] }): Promise<string | undefined> {
    if (said.markdown == null || !/^[\w-]{1,80}$/.test(session) || !/^[\w-]{1,80}$/.test(qid)) return undefined
    const dir = join(d.projectDir, 'sessions', session, qid)
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'answer.md'), said.markdown)
      if (said.blocks?.length) await writeFile(join(dir, 'blocks.json'), JSON.stringify(said.blocks))
      if (said.queries?.length) await writeFile(join(dir, 'queries.jsonl'), said.queries.map((q) => JSON.stringify(q)).join('\n') + '\n')
      return await readFile(join(dir, 'answer.md'), 'utf8')
    } catch (e: any) { console.warn(`[app] ${qid}: the answer was not committed: ${e?.message ?? e}`); return undefined }
  }

  async function handle(payload: any, from: any, deliver: (msg: Record<string, unknown>) => void = (msg) => d.send(from, msg)) {
    if (payload.t === 'app:reload') { app = load(true); const a = await app; deliver({ t: 'app:reloaded', ok: !!a }); return }
    const a = await (app ??= load())
    if (!a) { deliver({ t: 'app:error', error: 'this project has no application', reqId: payload.reqId }); return }
    const ctx = {
      project: d.project, projectDir: d.projectDir, who: from?.userId ?? null,
      query: async (source: string, sql: string, params: Record<string, unknown> = {}) => {
        const r = await fetch(`${d.datasource}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: source, sql, params }) })
        const body: any = await r.json().catch(() => ({}))
        if (!r.ok || body.error) throw new Error(`${source}: ${body.error ?? `the manager answered ${r.status}`}`)
        return { rows: body.rows ?? [], notes: body.notes ?? null }
      },
      /** A domain's programs, placed in the application's own folder and kept to the graph as it is now: { dir, used }. */
      domain: (name: string) => placeForRunning(d.projectDir, name, join(d.projectDir, 'app', '.domains', name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')), d.datasource),
      sources: async () => { const r = await fetch(`${d.datasource}/sources`); const body: any = await r.json().catch(() => ({})); return body.sources ?? [] },
      say: (text: string, context: string, o: { qid: string; threadId: string; focus?: string | null }) => say(text, context, { ...o, reqId: payload.reqId, from }),
      reply: (msg: Record<string, unknown>) => {
        const out = { ...msg, t: String(msg.t ?? 'app:res'), reqId: payload.reqId }
        console.log(`[app] → ${out.t} ${payload.reqId ?? ''} ${JSON.stringify(out).length} bytes · ${Date.now() - t0} ms · to ${from?.id ?? '?'}`)
        deliver(out)
      },
    }
    const t0 = Date.now()
    console.log(`[app] ← ${payload.t} ${payload.reqId ?? ''}${payload.focus ? ` ${payload.focus}` : ''} from ${from?.id ?? '?'}`)
    try { await a.handle(payload, ctx) }
    catch (e: any) { console.warn(`[app] ✗ ${payload.t} ${payload.reqId ?? ''}: ${e?.message ?? e}`); deliver({ t: 'app:error', error: e?.message ?? String(e), reqId: payload.reqId }) }
  }

  /** The application's reply to one payload, as a value — how a program asks the project's application (services.app). */
  function call(payload: Record<string, unknown>, from: any): Promise<any> {
    return new Promise((resolve) => { let done = false; void handle(payload, from, (m) => { if (!done) { done = true; resolve(m) } }).then(() => { if (!done) resolve({ t: 'app:error', error: 'the application did not answer' }) }) })
  }

  return { handle, present, say, call, stop, busy: () => turning.size, open: () => composers.size }
}
