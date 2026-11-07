// THE COMPOSER — a domain's agent in one conversation: the domain's knowledge (composed from the composition graph)
// is its whole system prompt, and it answers in markdown whose marker lines name the blocks it wrote.
//
// One composer per conversation, in the conversation's own directory, so follow-ups keep their memory there.

import { holdTicket } from '../../access.js'
import { readFile, writeFile, mkdir, rm, copyFile, chmod } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { agentConfig, type AgentOverride } from '../../config/index.js'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { toolUsage, keepOnlyTools } from '../../ica/workspace.js'
import { askSocket } from '../../tool-socket.js'
import { openStore } from '@superatom/composition-graph/node'

export interface ComposerOpts {
  /** The engine's socket for tools that need its answer during a turn (tool-socket.ts): a session's composer finds
   *  intents through it. */
  toolSocket?: string
  root: string
  projectId: string
  managerUrl?: string
  projectDir?: string
  /** The conversation this composer belongs to: its directory, and its data session. */
  sessionId?: string
  ica?: AgentOverride
  /** What this composer is to know from the start, beside its role: the memory of a domain, given in, never read. */
  reference?: string
  /** The tools this composer is left with, by name; every tool when not said. */
  tools?: string[]
  /** Which of the session's two agents this is (docs/intent-graph.md): the composer — the entry point, answering at
   *  intents already known — or the analyst, answering what is new. Both work in the session's one folder, one at a time. */
  role?: 'composer' | 'analyst'
}

/** What a turn said: markdown, in which a line `:::table <name>.json` (or `:::bar`, `:::line`) marks where a block
 *  belongs — the named file in the thread's folder, in the application's own block shape, so a table or a chart from
 *  an agent draws exactly as one from a capability. Each marker is resolved here; the marker lines stay in the
 *  markdown so the client can split at them. Only files the markdown names are ever read or sent. */
export interface Said { markdown: string | null; blocks: SaidBlock[]; periods: Period[]; queries: QueryRecord[]; ms: number; /** Why there is no answer, for operators (RunResult.failure). */ failure?: string
  /** What the agent decided about the message's intent (its `:::node` line). */
  decision?: { node: string | null }
  /** The question it sent to another of the session's agents (send-to-agent): that agent answers instead. */
  sent?: { agent: string; message: string } }

/** A turn's decision line, wherever in its messages it was said: `:::node <same | id | new | none>`. */
export function decisionIn(text: string): { node: string | null } {
  let node: string | null = null
  for (const line of text.split('\n')) { const m = /^[ \t]*:::node[ \t]+(\S+)[ \t]*$/.exec(line); if (m) node = m[1].toLowerCase() }
  return { node }
}
/** The answer without its decision line. */
const withoutDecision = (md: string) => md.split('\n').filter((l) => !/^[ \t]*:::node[ \t]+\S+[ \t]*$/.test(l)).join('\n').trim()
/** The time an answer covers, from its `:::period <when> · <what kind>` lines, in order: a comparison has one per period. */
export interface Period { label: string; detail?: string }
export function periodsIn(markdown: string | null): Period[] {
  const out: Period[] = []
  for (const line of (markdown ?? '').split('\n')) {
    const m = /^[ \t]*:::period[ \t]+(.+?)\s*$/.exec(line); if (!m) continue
    const [label, ...rest] = m[1].split(/\s+·\s+/)
    out.push({ label: label.trim(), ...(rest.length ? { detail: rest.join(' · ').trim() } : {}) })
  }
  return out
}
export type { SaidBlock } from '../../answer-card.js'
import { blocksOf, blockFixes, type SaidBlock } from '../../answer-card.js'
import { markerOf } from '@superatom/ui/cards'

/** The blocks a markdown names, read from the thread folder (answer-card.ts says what a marker means). A missing or
 *  malformed file is an error beside its marker. */
async function blocksNamedIn(markdown: string, cwd: string): Promise<SaidBlock[]> {
  return blocksOf(markdown, async (file) => JSON.parse(await readFile(join(cwd, file), 'utf8')))
}
/** The files an answer names, copied into its question folder: what the answer stands on cannot be changed by a
 *  later question writing a file of the same name. Returns the folder to resolve the answer's blocks from. */
async function keepNamed(markdown: string, cwd: string, qdir: string): Promise<string> {
  for (const line of markdown.split('\n')) {
    const m = markerOf(line.trim()); if (!m || m.problem) continue
    await mkdir(dirname(join(qdir, m.name)), { recursive: true }).catch(() => {})
    await copyFile(join(cwd, m.name), join(qdir, m.name)).catch(() => {})
  }
  return qdir
}

/** A query the composer sent to a source: recorded with the turn, so an answer can say what it read. */
export interface QueryRecord { source: string; query: string; rows: number; ms: number; at: number; error?: string }


export interface Composer {
  /** A question in prose, asked from a screen: the answer is markdown at out/<qid>/said.md. */
  say(text: string, context: string, handlers: RunHandlers | undefined, opts: { qid: string; ticket?: () => Promise<string>; person?: string; where?: string }): Promise<Said>
  session: Session
  cwd: string
  sessionId: string
}

/** A composer with no role given (the chat's): only a floor. */
const ROLE = `You answer a person's questions about their organisation's data, in markdown. Use the tools in this folder to
read the data; each explains itself with --help. Each question comes with today's date and its qid.`

/** WHO MAY HAND A QUESTION TO WHOM — the session's agents are a hierarchy, never a mesh: the composer hands to the analyst;
 *  the analyst hands to no one (it never opens the composer). An agent is given send-to-agent only when it may hand to
 *  someone, and the engine takes a hand-off only along these lines. */
export const HANDS_TO: Record<'composer' | 'analyst', readonly string[]> = { composer: ['analyst'], analyst: [] }
/** What may be sent: the engine fills it in — the agent never writes the question out again. Its role (the graph's
 *  concepts) says when to send it. */
export const SEND_TERMS = ['current-question'] as const

/** The line the tool says when a hand-off is made — the one signal the engine takes, from the turn's own events (a
 *  command's output, as every harness reports it): no file, nothing else to read. */
const SENT_LINE = (to: string, term: string) => `Sent ${term} to the ${to}: it answers the person. Your turn is over.`
const SENT_IN = /^Sent ([a-z-]+) to the ([a-z-]+): it answers the person\. Your turn is over\.$/m
/** A hand-off said in a turn's events, when it is one this agent may make; else null. */
export function handOffIn(output: string | undefined, from: 'composer' | 'analyst'): { agent: string; message: string } | null {
  const m = SENT_IN.exec(output ?? '')
  return m && HANDS_TO[from].includes(m[2]) && (SEND_TERMS as readonly string[]).includes(m[1]) ? { agent: m[2], message: m[1] } : null
}

/** The tool that hands the person's question to another of the session's agents (only those this one may hand to): it
 *  checks what it is given and says so; the engine sees that in the turn's events, ends the turn and starts the other. */
export const sendTool = (node: string, to: readonly string[]) => `#!${node}
// ./send-to-agent <${to.join('|')}> <${SEND_TERMS.join('|')}> — the person's question handed over (the engine fills it in).
const [agent, message] = process.argv.slice(2)
if (!agent || agent === '--help' || !message) { console.log('./send-to-agent <${to.join('|')}> <${SEND_TERMS.join('|')}>'); process.exit(agent === '--help' ? 0 : 1) }
if (!${JSON.stringify(to)}.includes(agent)) { console.log('you may send to: ${to.join(', ')}'); process.exit(1) }
if (!${JSON.stringify(SEND_TERMS)}.includes(message)) { console.log('send one of: ${SEND_TERMS.join(', ')} — the engine fills it in'); process.exit(1) }
console.log(${JSON.stringify(SENT_LINE('AGENT', 'TERM'))}.replace('AGENT', agent).replace('TERM', message))
`

/** The composer's tool that finds the intents a question may be, by the question spelled out in full (its role says how):
 *  the engine searches by those words and replies with the candidates and what is known of each; it keeps the words as
 *  what the question was understood to be. */
const findTool = (node: string, socket: string, folder: string) => `#!${node}
// ./find-intent "<the question, spelled out in full>" — the intents it may be, with what is known of each.
${askSocket(socket, folder)}
const q = process.argv.slice(2).join(' ').trim()
if (!q || q === '--help') { console.log('./find-intent "<the question, spelled out in full>" — the intents it may be, with what is known of each'); process.exit(q ? 0 : 1) }
ask('find-intent', { question: q }).then((r) => { if (r.error) { console.log(r.error); process.exit(1) } console.log(r.text) })
`

/** The date a question is asked on, in the organisation's time zone (settings.json \`timezone\`), else UTC — never the
 *  server's. An agent is not otherwise told what day it is. */
export function todayIn(projectDir?: string): string {
  const zone = zoneOf(projectDir)
  return `${dayIn(zone)} (${zone})`
}
// The organisation's time zone: the graph's setting "timezone" (held by the platform; this reads the engine's replica), else UTC.
const zoneOf = (projectDir?: string) => {
  const file = projectDir ? join(projectDir, 'db', 'composition.sqlite') : ''
  if (!file || !existsSync(file)) return 'UTC'
  const s = openStore(file)
  try { const v = (s.get<any>('timezone')?.body?.value); return typeof v === 'string' && v ? v : 'UTC' } catch { return 'UTC' } finally { s.close() }
}
const dayIn = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
/** The date alone, as a program's ctx.today reads it. */
export const dayOf = (projectDir?: string) => dayIn(zoneOf(projectDir))

export async function createComposer(opts: ComposerOpts): Promise<Composer> {
  const role = opts.role ?? 'composer'
  const cfg = agentConfig(role)
  const harness: Harness = opts.ica?.harness ?? cfg.harness
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl, projectDir: opts.projectDir, sessionId: opts.sessionId, tools: 'conversation' })
  // A session's two agents share one folder: each is told its own tools (its role's), and the engine answers it only for
  // those — the folder keeps them all. Any other composer is left only the tools it is given.
  if (opts.tools && !opts.role) await keepOnlyTools(cwd, opts.tools)
  const usage = await toolUsage(cwd, opts.tools)
  // A composer given a domain IS that domain's agent: its reference is the whole of the instructions, with the usage
  // of the tools it was left. The chat composer's role, which names every tool, is for a composer without one.
  const toolLines = usage ? `The tools, each as it says of itself — run them as bash commands in this folder:\n${usage}` : ''
  // What it knows (a session's agent: its role and its domain's concepts, all the graph's), then its tools; else the floor.
  const systemReference = opts.reference ? [opts.reference, toolLines].filter(Boolean).join('\n\n') : [ROLE, toolLines].filter(Boolean).join('\n\n')
  if (opts.role && HANDS_TO[role].length) { await writeFile(join(cwd, 'send-to-agent'), sendTool(process.execPath, HANDS_TO[role])); await chmod(join(cwd, 'send-to-agent'), 0o755) }
  if (role === 'composer' && opts.role && opts.toolSocket) { await writeFile(join(cwd, 'find-intent'), findTool(process.execPath, opts.toolSocket, cwd)); await chmod(join(cwd, 'find-intent'), 0o755) }
  // THE CONVERSATION OUTLIVES THE PROCESS. The harness session file is noted in the folder after every real turn
  // (never before one: a session with no turn has no file to resume), and a composer rebuilt from the folder —
  // after a restart, after an idle timeout — takes the conversation up where it was, not from nothing.
  const HARNESS_NOTE = join(cwd, role === 'composer' ? '.harness-session' : `.harness-session-${role}`)
  const noted = await readFile(HARNESS_NOTE, 'utf8').then((t) => t.trim()).catch(() => '')
  const resumeId = opts.ica?.resumeId ?? (noted && existsSync(noted) ? noted : undefined)
  const session = createSession(harness, { cwd, model: opts.ica?.model ?? cfg.model, provider: opts.ica?.provider ?? cfg.provider, thinking: opts.ica?.thinking ?? cfg.thinking, baseUrl: opts.ica?.baseUrl,
                                           resumeId, systemReference })
  if (resumeId) console.log(`[${role}] ${opts.sessionId?.slice(0, 8) ?? '?'} resumes its conversation`)
  const noteHarness = async () => { try { const id = session.sessionId?.(); if (id) await writeFile(HARNESS_NOTE, id) } catch { /* best-effort */ } }
  await writeFile(join(cwd, role === 'composer' ? '.system-prompt.md' : `.system-prompt-${role}.md`), systemReference)   // what this agent was told, verbatim, for anyone to read
  console.log(`[${role}] ${opts.sessionId?.slice(0, 8) ?? '?'} ${harness} prompt ${systemReference.length} chars · tools ${opts.tools ? opts.tools.join(', ') : 'all'} · first line: ${systemReference.split('\n')[0].slice(0, 90)}`)
  if (session.referencePlacement !== 'in-context') console.warn(`[composer] harness "${harness}" cannot put the reference in the system prompt — use opencode/claude/codex`)

  const queriesOf = async (qid: string): Promise<QueryRecord[]> => {
    try { return (await readFile(join(cwd, 'out', qid, 'queries.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] }
  }
  return {
    cwd, session, sessionId: opts.sessionId ?? '',
    async say(text, context, handlers, o) {
      const t0 = Date.now()
      const dir = join(cwd, 'out', o.qid)
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      await mkdir(dir, { recursive: true })
      await writeFile(join(cwd, '.turn'), o.qid)
      await writeFile(join(cwd, '.session'), opts.sessionId ?? '')
      await writeFile(join(cwd, '.agent'), role)
      // The asker's data access ticket, for every read this turn makes (the data seam sends it): held for the turn and
      // emptied after it, so no asker's ever lingers — no ticket, nothing read.
      const release = await holdTicket(join(cwd, '.ticket'), o.ticket ?? (async () => ''))
      // THE ANSWER IS THE AGENT'S FINAL MESSAGE. A model finishes by saying its answer, so that is what is taken —
      // not a file it was asked to write, which invited shell and shipped the first slip. The turn ends when the
      // agent ends it; the last message, with its marker lines, is the reading, and it is kept in the question's
      // folder for the record.
      // THE ANSWER STARTS WITH A LINE `:::answer`. What the agent says before it is working aloud; what it says
      // from that line on is the answer, handed on piece by piece as each message arrives. An agent that writes
      // no marker is taken at its final message.
      let last = '', answer = '', begun = false, said = ''
      const take = (whole: string) => {
        const piece = withoutDecision(whole)
        if (!piece.trim()) return
        answer = answer ? `${answer}\n${piece}` : piece
        // A marker line in the piece names a file the script has already written: resolved now, carried with the piece.
        if (/^[ \t]*:::\S+[ \t]+\S+/m.test(piece)) void blocksNamedIn(piece, cwd).then((blocks) => handlers?.onAnswer?.(piece, blocks)).catch(() => handlers?.onAnswer?.(piece))
        else handlers?.onAnswer?.(piece)
      }
      const prompt = `${context.trim() ? `What the person is looking at:\n${context}\n\n` : ''}${o.where ? `Where they read the answer: ${o.where}\n\n` : ''}Their question: ${text}\n\ntoday: ${todayIn(opts.projectDir)}\nqid: ${o.qid}`
      // A HAND-OFF ENDS THE TURN: the tool's line in a command's output (this turn's own events) — the engine stops the turn
      // there (every harness ends a turn when doneWhen holds) and the other agent answers.
      let sent: { agent: string; message: string } | null = null
      const r = await session.run(prompt, { ...handlers, forSession: opts.sessionId, forPerson: o.person, doneWhen: () => sent !== null, onEvent: (ev) => {
        if (!sent && ev.kind === 'command' && ev.output) sent = handOffIn(ev.output, role)
        if (ev.kind === 'message' && ev.text?.trim()) {
          last = ev.text.trim(); said += `\n${last}`
          if (begun) take(last)
          else { const m = last.match(/^[ \t]*:::answer[ \t]*$/m); if (m) { begun = true; take(last.slice(m.index! + m[0].length)) } }
        }
        handlers?.onEvent?.(ev)
      } }).finally(release)
      await noteHarness()
      const decision = decisionIn(`${said}\n${r.lastLines ?? ''}`)
      if (sent) { await noteHarness(); return { markdown: null, blocks: [], periods: [], queries: await queriesOf(o.qid), ms: Date.now() - t0, decision, sent } }
      const markdown = withoutDecision(begun ? answer.trim() : (last || r.lastLines?.trim() || '')) || null
      if (markdown) await writeFile(join(dir, 'said.md'), markdown).catch(() => {})
      let blocks = markdown ? await blocksNamedIn(markdown, await keepNamed(markdown, cwd, dir)) : []
      // A BLOCK THAT CANNOT BE DRAWN AS WRITTEN is told to the agent, once, in the same conversation: it writes those
      // files again (the same names — the answer's words stand) and they are read again. Never drawn as empty.
      const fixes = blockFixes(blocks)
      if (markdown && fixes) {
        console.warn(`[composer] ${o.qid}: blocks to write again:\n${fixes.split('\n\n')[0]}`)
        const again = await holdTicket(join(cwd, '.ticket'), o.ticket ?? (async () => ''))
        await session.run(`These files your answer names cannot be drawn as written:\n${fixes}\n\nWrite them again with the same names, then reply only: done`, { forSession: opts.sessionId, forPerson: o.person, onEvent: (ev) => handlers?.onEvent?.(ev) }).catch(() => null).finally(again)
        await noteHarness()
        blocks = await blocksNamedIn(markdown, await keepNamed(markdown, cwd, dir))
        if (blockFixes(blocks)) console.warn(`[composer] ${o.qid}: still not drawable after one try: ${blocks.filter((b) => b.error).map((b) => b.error).join(' | ')}`)
      }
      return { markdown, blocks, periods: periodsIn(markdown), queries: await queriesOf(o.qid), ms: Date.now() - t0, decision, ...(!markdown && r.failure ? { failure: r.failure } : {}) }
    },
  }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE).digest('hex').slice(0, 12)
}
