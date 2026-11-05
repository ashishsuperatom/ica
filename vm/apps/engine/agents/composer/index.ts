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
import { openStore } from '@superatom/composition-graph/node'

export interface ComposerOpts {
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

// THE SESSION'S TWO AGENTS' OWN INSTRUCTIONS (docs/intent-graph.md) — the platform's, never a concept: first in what each
// is told, before any concept. What each knows about answering comes after, from the project's concepts.
/** What the composer may send: the engine fills it in — the composer never writes the question out again. */
export const SEND_TERMS = ['current-question'] as const
const SEND = `./send-to-agent analyst current-question`
const ROLES: Record<'composer' | 'analyst', string> = {
  composer: `You are a session's composer: every message the person sends comes to you first. You answer the questions whose
intent is known here, from that intent's knowledge.
A question that is a new intent — or the intent you are in, in a situation its knowledge does not cover — is answered by the
session's analyst: hand it the person's question with
  ${SEND}
and your turn is over: the analyst answers the person.`,
  analyst: `You are a session's analyst. A session is one person's conversation with their organisation's data: every answer
given in it (../ANSWER_HISTORY.jsonl), its STATE — what its programs show, as JSON (../STATE.json) — and the programs it runs.
The session's composer answers the questions whose intent is already known; the questions that are new here come to you,
each as the person asked it. You read the data with the tools in this folder and answer in markdown; the tables and charts
your answer names are files you write here.`,
}

/** The composer's tool that sends a question to another of the session's agents: it is written down for the engine, and
 *  the composer's turn ends there. */
const sendTool = (node: string) => `#!${node}
// ${SEND} — the person's question handed to the session's analyst (the engine fills it in); it answers the person and the
// composer's turn is over.
const { readFileSync, writeFileSync } = process.getBuiltinModule('node:fs')   // the same in a CommonJS or a module folder
const [agent, message] = process.argv.slice(2)
if (!agent || agent === '--help' || !message) { console.log('${SEND}'); process.exit(agent === '--help' ? 0 : 1) }
if (agent !== 'analyst') { console.log('the only agent to send to is the analyst'); process.exit(1) }
if (!${JSON.stringify(SEND_TERMS)}.includes(message)) { console.log('send one of: ${SEND_TERMS.join(', ')} — the engine fills it in'); process.exit(1) }
let turn = ''; try { turn = readFileSync('.turn', 'utf8').trim() } catch {}
writeFileSync('.send-to-agent.json', JSON.stringify({ agent, message, turn }))
console.log('Sent to the analyst: it answers the person. Your turn is over — write nothing more.')
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
  if (opts.tools) await keepOnlyTools(cwd, opts.tools)
  const usage = await toolUsage(cwd, opts.tools)
  // A composer given a domain IS that domain's agent: its reference is the whole of the instructions, with the usage
  // of the tools it was left. The chat composer's role, which names every tool, is for a composer without one.
  const toolLines = usage ? `The tools, each as it says of itself — run them as bash commands in this folder:\n${usage}` : ''
  // A session's agent: its own instructions and tools first, then what the project's concepts say. The chat's composer: the
  // reference it was given (a domain's), else the floor.
  const systemReference = opts.role ? [ROLES[opts.role], toolLines, opts.reference].filter(Boolean).join('\n\n')
    : opts.reference ? [opts.reference, toolLines].filter(Boolean).join('\n\n') : [ROLE, toolLines].filter(Boolean).join('\n\n')
  const SENT = join(cwd, '.send-to-agent.json')
  if (role === 'composer' && opts.role) { await writeFile(join(cwd, 'send-to-agent'), sendTool(process.execPath)); await chmod(join(cwd, 'send-to-agent'), 0o755) }
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
      await rm(SENT, { force: true })
      // A question sent to another agent ends the turn there (the composer's send-to-agent).
      const sentNow = () => { try { return JSON.parse(readFileSync(SENT, 'utf8')).turn === o.qid } catch { return false } }
      const r = await session.run(prompt, { ...handlers, forSession: opts.sessionId, forPerson: o.person, doneWhen: sentNow, onEvent: (ev) => {
        if (ev.kind === 'message' && ev.text?.trim()) {
          last = ev.text.trim(); said += `\n${last}`
          if (begun) take(last)
          else { const m = last.match(/^[ \t]*:::answer[ \t]*$/m); if (m) { begun = true; take(last.slice(m.index! + m[0].length)) } }
        }
        handlers?.onEvent?.(ev)
      } }).finally(release)
      await noteHarness()
      const decision = decisionIn(`${said}\n${r.lastLines ?? ''}`)
      let sent: { agent: string; message: string } | undefined
      try { const x = JSON.parse(readFileSync(SENT, 'utf8')); if (x.turn === o.qid && typeof x.message === 'string' && x.message.trim()) sent = { agent: String(x.agent), message: x.message.trim() } } catch { /* nothing sent */ }
      await rm(SENT, { force: true })
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
