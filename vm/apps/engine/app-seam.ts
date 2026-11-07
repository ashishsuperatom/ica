// THE SESSION'S TWO AGENTS' SEAM (docs/intent-graph.md): a question in words, answered in its session by the session's
// composer — the entry point, answering at intents already known — or its analyst (made only when a new intent needs it),
// one at a time, with narration while it works, and the answer committed in the question's own place. Neither is built
// on a domain: each starts from the project's concepts for its role, and is given an intent's knowledge as it reaches it.
// (A project's own views are a library, @lib/views, that programs use — not a part of this seam.)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createComposer, type Composer, type QueryRecord } from './agents/composer/index.js'
import { createNarrator, capResultData, isDataCall } from './agents/narrator/index.js'
import { compose, composeLinks, domainFor, domainsOf, roleTools } from './knowledge.js'
import { agentConfig } from './config/index.js'
import type { AgentEvent } from './ica/session.js'
import { personOf } from './identity.js'

export type Role = 'composer' | 'analyst' | 'workbench'
/** Each of the session's agents: the concept of the project's graph that is its role (what it is, what it does, how it
 *  hands over) — given first, before its domain's concepts. Both are the graph's, editable like any concept. */
export const ROLE_CONCEPT: Record<Role, string> = { composer: 'role/composer', analyst: 'role/analyst', workbench: 'role/workbench' }

export interface AppSeamDeps {
  /** The engine's socket for agents' tools (tool-socket.ts). */
  toolSocket?: string
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
  /** What each agent is built with now (harness/provider/model): a session's agent built with something else is made
   *  again at its next question — never mid-answer. */
  agentStamp?: (role: Role) => string
  /** The asker's data access ticket for the turn (access.ts ticketFor). */
  ticketFor?: (from: any, agent?: string) => Promise<string>
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
  /** Why there is no answer, for operators (RunResult.failure). */
  failure?: string
  /** The turn was stopped (turn:stop) before it answered. */
  stopped?: boolean
  /** Which of the session's agents answered. */
  agent?: { name: Role; how: string }
  /** What the agent decided about the message's intent (agents/composer decisionIn). */
  decision?: { node: string | null }
  /** The question it sent to another of the session's agents (its send-to-agent tool). */
  sent?: { agent: string; message: string }
  /** What the narrator said while it was worked out (kept with the answer). */
  beats?: { text: string; at: number }[]
}

/** A turn is capped: a question that takes longer than this is not being answered, it is being wandered. */
/** A last-resort cap, so a wedged agent cannot hold its session for good. */
const MAX_SAY_MS = Number(process.env.COMPOSER_MAX_TURN_MS) || 30 * 60_000
/** Composers idle this long are let go; the thread directory and its data session stay, so a later question resumes there. */
const IDLE_MS = 30 * 60_000
/** How long an interrupted agent has to end its turn before it is closed outright. */
const STOP_GRACE_MS = 10_000

export function createAppSeam(d: AppSeamDeps) {
  // ONE COMPOSER AND ONE ANALYST PER SESSION, each made when first needed, in the session's one folder: the session id is
  // their thread, so a follow-up lands where the earlier question was answered. Idle ones are let go; their folder and
  // conversations stay, so a later question resumes there.
  const composers = new Map<string, { composer: Promise<Composer>; role: Role; lastUsed: number; builtWith: string }>()
  const keyOf = (sid: string, role: Role) => `${sid}|${role}`
  const composerFor = async (sid: string, role: Role, graph?: string, domainName?: string) => {
    const key = keyOf(sid, role)
    let e = composers.get(key)
    const want = `${role}:${d.agentStamp?.(role) ?? ''}`
    if (e && e.builtWith !== want) {
      console.log(`[app] thread ${sid.slice(0, 8)}: the ${role}'s profile changed (${e.builtWith} → ${want}) — a fresh one`)
      const old = e.composer; composers.delete(key); e = undefined
      old.then((c) => { try { c.session.stop() } catch { /* gone */ } }).catch(() => {})
    }
    if (!e) {
      const composer = (async () => {
        // A SESSION'S SYSTEM PROMPT IS ITS OWN, FROM ITS START: its role, then the concepts of the domain the session is on —
        // put together the first time the session's agent is made, kept in the session, and given as it is every time that
        // agent is made again (an engine restart, an idle one let go). What changes in the graph later reaches new sessions;
        // an intent's knowledge, given with each question, is what stays live.
        const kept = join(d.projectDir, 'sessions', sid, `system-prompt.${role}.md`)
        let reference = await readFile(kept, 'utf8').catch(() => '')
        if (!reference) {
          const domain = domainName ? (await domainsOf(d.projectDir, graph).catch(() => [])).find((x) => x.name === domainName) ?? null : await domainFor(d.projectDir, graph)
          const own = await composeLinks(d.projectDir, [{ kind: 'concept', name: ROLE_CONCEPT[role] }], graph).catch(() => '')
          const shared = domain ? await compose(d.projectDir, domain, graph).then((k) => k.text).catch((err) => { console.warn(`[app] the domain ${domain.name} could not be composed: ${err?.message ?? err}`); return '' }) : ''
          if (!own) console.warn(`[app] the concept ${ROLE_CONCEPT[role]} is not in the graph — the ${role} starts without its role`)
          reference = [own, shared].filter(Boolean).join('\n\n')
          if (reference) await mkdir(dirname(kept), { recursive: true }).then(() => writeFile(kept, reference)).catch(() => {})
        }
        const domain = domainName ? (await domainsOf(d.projectDir, graph).catch(() => [])).find((x) => x.name === domainName) ?? null : await domainFor(d.projectDir, graph)
        const c = await createComposer({ root: d.workspaceRoot, projectId: d.project, managerUrl: d.datasource, projectDir: d.projectDir, sessionId: sid, role, reference: reference || undefined, ...(d.toolSocket ? { toolSocket: d.toolSocket } : {}), ...((): { tools?: string[] } => { const t = roleTools(d.projectDir, ROLE_CONCEPT[role], graph) ?? domain?.tools; return t ? { tools: t } : {} })(), ...(role === 'composer' && d.icaBaseUrl ? { ica: { baseUrl: d.icaBaseUrl } } : {}) })
        console.log(`[app] thread ${sid.slice(0, 8)} · ${role} on the domain "${domain?.name ?? '—'}" · ${reference.length} chars`)
        // The version it reads, for its tools too (find-concept searches the same version the prompt was composed from).
        await writeFile(join(c.cwd, '.graph.json'), JSON.stringify({ graph: graph ?? null })).catch(() => {})
        return c
      })()
      e = { composer, role, lastUsed: Date.now(), builtWith: want }; composers.set(key, e)
    }
    e.lastUsed = Date.now()
    return e
  }
  /** The conversation of a session's agent, for a clone of it (ica/clone.ts); null when it was never made. */
  async function conversationOf(sid: string, role: Role) {
    const e = composers.get(keyOf(sid, role)); if (!e) return null
    const c = await e.composer
    const cfg = agentConfig(role)
    return { harness: cfg.harness, ref: c.session.sessionId?.(), cwd: c.cwd, model: cfg.model, provider: cfg.provider, thinking: cfg.thinking }
  }
  setInterval(() => { const now = Date.now(); for (const [sid, e] of composers) if (now - e.lastUsed > IDLE_MS) { composers.delete(sid); e.composer.then((c) => { try { c.session.stop() } catch { /* gone */ } }).catch(() => {}) } }, 60_000).unref()

  /** A question in prose, asked from a screen of the application: the composer of that thread answers it. While it
   *  works, what it does goes back as beats — to the asking page, which shows the last line and keeps waiting, and to
   *  the project's agent log on the composer's lane, so the work can be watched where every agent's work is watched. */
  // THE TURN IN EACH SESSION: one at a time (a second question waits for the first, or is told so), and stoppable.
  const turning = new Map<string, { qid: string; stop: (why: string) => void; ended: Promise<void> }>()

  /** Stop the turn running in a session (turn:stop): resolves once it has ENDED — the agent interrupted and its turn over
   *  (closed outright if it has not ended within STOP_GRACE_MS) — with whether there was one. */
  async function stop(threadId: string, why = 'stopped by the person'): Promise<boolean> {
    const t = turning.get(threadId); if (!t) return false
    t.stop(why); await t.ended; return true
  }

  async function say(text: string, context: string, o: { qid: string; threadId: string; role?: Role; reqId?: string; from?: any; channel?: string; graph?: string; /** The agent's own domain (the workbench's), else the default. */ domain?: string }): Promise<Said> {
    const t0 = Date.now()
    if (turning.has(o.threadId)) throw new Error('Already answering a question in this session — one at a time.')
    let stopped: string | null = null
    let stopNow: () => void = () => {}
    let ended: () => void = () => {}
    turning.set(o.threadId, { qid: o.qid, stop: (why) => { if (stopped) return; stopped = why; stopNow() }, ended: new Promise<void>((r) => { ended = r }) })
    // LIVENESS: a tick every few seconds, so whoever asked knows the turn is alive through a long silence.
    const tick = setInterval(() => { if (o.from) d.send(o.from, { t: 'tick', sid: o.threadId, qid: o.qid }) }, 8000)
    try {
    const role: Role = o.role ?? 'composer'
    const entry = await composerFor(o.threadId, role, o.graph, o.domain)
    const composer = await entry.composer
    const agent = { name: role, how: 'session' }
    // PROGRESS GOES OUT EXACTLY AS A CHAT TURN'S DOES. The raw work — output and events — travels on the agent
    // log channel under the composer's lane, for whoever watches agents work. What a person reads while waiting is
    // the narrator's: every few seconds it turns the activity since the last beat into one line, sent as
    // `narration` to the page that asked (with the request id, so the page knows which reading it belongs to) and
    // to the owner's narration channel, which survives a reconnect.
    const log = (frame: Record<string, unknown>) => d.send({ type: 'log', channel: 'composer-log' }, { ...frame, lane: role, qid: o.qid, sid: o.threadId, agent: role })
    const beats: { text: string; at: number; agent: Role }[] = []
    // Each line says which agent was working — the engine knows it (this turn's role); the page colours by it.
    const beat = (text: string) => {
      beats.push({ text, at: Date.now(), agent: role })
      console.log(`[beat] ${o.qid.slice(0, 8)} → ${o.from?.id ?? 'no page'}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`)
      const frame = { t: 'narration', text, qid: o.qid, sid: o.threadId, reqId: o.reqId, agent: role }
      if (o.from) d.send(o.from, frame)
      d.send({ type: 'log', channel: 'narration' }, frame)
      if (o.channel) d.send({ type: 'channel' }, { t: 'channel:narration', channel: o.channel, qid: o.qid, text })   // Teams and other chat channels
    }
    log({ t: 'agent:event', ev: { kind: 'user', id: o.qid, text, done: true } })
    // THE WORKBENCH SHOWS ITS OWN WORK: what it says and what it runs, as it happens — no narrator stands between. The
    // session's composer and analyst are narrated (a person reads one line, not the work).
    const own = role === 'workbench'
    if (!own) beat(role === 'analyst' ? 'The analyst is working it out…' : 'Looking into your question…')
    const narrator = createNarrator({ cwd: d.narratorCwd })
    const activity: string[] = []
    let answering = false, recent: string[] = []
    let narrating = false
    const narration = setInterval(async () => {
      if (own || narrating || !activity.length) return
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
        // The workbench's work, as it does it: each thing it says before its answer, and each command it starts.
        if (own && !answering) {
          if (ev.kind === 'message' && ev.text?.trim()) { const t = String(ev.text), m = t.match(/^[ \t]*:::answer[ \t]*$/m); const before = (m ? t.slice(0, m.index) : t).trim(); if (before) beat(before) }
          else if (ev.kind === 'command' && ev.command && ev.status !== 'completed' && !ev.done) beat(`\`${String(ev.command).replace(/\s+/g, ' ').slice(0, 240)}\``)
        }
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
    let timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined
    const said = await Promise.race([
      composer.say(text, context, handlers, { qid: o.qid, person: personOf(o.from), ...(o.channel ? { where: `a ${o.channel} chat. A few short lines answer it best; the full report is attached to them.` } : {}), ...(d.ticketFor ? { ticket: () => d.ticketFor!(o.from, role) } : {}) }).finally(() => { clearInterval(narration); try { narrator.stop() } catch { /* best-effort */ } }),
      new Promise<Said>((res) => { timer = setTimeout(() => { try { composer.session.stop() } catch { /* best effort */ }; res({ markdown: null, blocks: [], calls: [], queries: [], ms: Date.now() - t0 }) }, MAX_SAY_MS) }),
      // STOP: the agent is interrupted — its turn ends, its conversation is kept (the next question goes on from it); one
      // that has not ended within STOP_GRACE_MS is closed outright. Either way the turn is over before stop() resolves.
      new Promise<Said>((res) => { stopNow = () => {
        console.log(`[${role}] ${o.threadId.slice(0, 12)} · ${o.qid} · stopped by the person — interrupting`)
        try { composer.session.interrupt() } catch { /* best effort */ }
        grace = setTimeout(() => { console.warn(`[${role}] ${o.qid} did not end within ${STOP_GRACE_MS / 1000}s of being interrupted — closed`); try { composer.session.stop() } catch { /* best effort */ }; res({ markdown: null, blocks: [], calls: [], queries: [], ms: Date.now() - t0, stopped: true }) }, STOP_GRACE_MS)
      } }),
    ])
    if (timer) clearTimeout(timer)
    if (grace) clearTimeout(grace)
    // Stopped: no answer, whatever the agent said before it ended.
    if (stopped) { said.markdown = null; (said as any).blocks = [] }
    // THE ANSWER IS COMMITTED IN ITS QUESTION'S OWN PLACE — <session>/<qid>/answer.md — and what is sent is that file,
    // read back: never a session-wide file a previous question could have left. The engine writes it from the answer
    // the composer committed (its `:::answer` message), once its work is finished.
    const committed = await commit(o.threadId, o.qid, said)
    if (committed !== undefined) said.markdown = committed
    // The turn to the platform's warehouse (through the project's DO): who asked what on which screen, the answer, the queries.
    d.record?.('agent.turn', o.qid, { qid: o.qid, session: o.threadId, asker: o.from?.userId ?? null, question: text, context, agent: role, via: 'app',
      queries: said.queries ?? [], answer: said.markdown, ms: Date.now() - t0 })
    return { markdown: said.markdown, blocks: said.blocks ?? [], calls: [], queries: said.queries ?? [], ms: Date.now() - t0, agent, beats, ...((said as any).decision ? { decision: (said as any).decision } : {}), ...((said as any).sent ? { sent: (said as any).sent } : {}), ...(stopped ? { stopped: true } : {}), ...(!said.markdown && said.failure ? { failure: said.failure } : {}) }
    } finally { clearInterval(tick); turning.delete(o.threadId); ended() }
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

  /** Every conversation's composer let go (an agent's restart): each starts a fresh session with its next question. */
  const reset = (): number => { const n = composers.size; for (const [sid, e] of composers) { composers.delete(sid); e.composer.then((c) => { try { c.session.stop() } catch { /* gone */ } }).catch(() => {}) } return n }
  return { say, stop, reset, conversationOf, busy: () => turning.size, open: () => composers.size }
}
