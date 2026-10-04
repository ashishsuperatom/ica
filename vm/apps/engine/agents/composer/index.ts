// THE COMPOSER — a domain's agent in one conversation: the domain's knowledge (composed from the composition graph)
// is its whole system prompt, and it answers in markdown whose marker lines name the blocks it wrote.
//
// One composer per conversation, in the conversation's own directory, so follow-ups keep their memory there.

import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentConfig, type AgentOverride } from '../../config/index.js'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { toolUsage, keepOnlyTools } from '../../ica/workspace.js'
import { projectSettings } from '../../settings.js'

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
}

/** What a turn said: markdown, in which a line `:::table <name>.json` (or `:::bar`, `:::line`) marks where a block
 *  belongs — the named file in the thread's folder, in the application's own block shape, so a table or a chart from
 *  an agent draws exactly as one from a capability. Each marker is resolved here; the marker lines stay in the
 *  markdown so the client can split at them. Only files the markdown names are ever read or sent. */
export interface Said { markdown: string | null; blocks: SaidBlock[]; periods: Period[]; queries: QueryRecord[]; ms: number }
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
import { blocksOf, MARKER, type SaidBlock } from '../../answer-card.js'

/** The blocks a markdown names, read from the thread folder (answer-card.ts says what a marker means). A missing or
 *  malformed file is an error beside its marker. */
async function blocksNamedIn(markdown: string, cwd: string): Promise<SaidBlock[]> {
  return blocksOf(markdown, async (file) => JSON.parse(await readFile(join(cwd, file), 'utf8')))
}
/** The files an answer names, copied into its question folder: what the answer stands on cannot be changed by a
 *  later question writing a file of the same name. Returns the folder to resolve the answer's blocks from. */
async function keepNamed(markdown: string, cwd: string, qdir: string): Promise<string> {
  for (const line of markdown.split('\n')) {
    const m = MARKER.exec(line.trim()); if (!m) continue
    await copyFile(join(cwd, m[2]), join(qdir, m[2])).catch(() => {})
  }
  return qdir
}

/** A query the composer sent to a source: recorded with the turn, so an answer can say what it read. */
export interface QueryRecord { source: string; query: string; rows: number; ms: number; at: number; error?: string }

/** Whose turn it is, for data access: the asker's resolved policies per source, or that they could not be checked. */
export type Reader = { principal: string; policies: Record<string, unknown[]> } | { unchecked: true }

export interface Composer {
  /** A question in prose, asked from a screen: the answer is markdown at out/<qid>/said.md. */
  say(text: string, context: string, handlers: RunHandlers | undefined, opts: { qid: string; reader?: Reader; person?: string }): Promise<Said>
  session: Session
  cwd: string
  sessionId: string
}

/** A composer without a domain's knowledge. The engine gives every conversation a domain; this is only a floor. */
const ROLE = `You answer a person's questions about their organisation's data, in markdown. Use the tools in this folder to
read the data; each explains itself with --help. Each question comes with today's date and its qid.`

/** The date a question is asked on, in the organisation's time zone (settings.json \`timezone\`), else UTC — never the
 *  server's. An agent is not otherwise told what day it is. */
export function todayIn(projectDir?: string): string {
  const zone = zoneOf(projectDir)
  return `${dayIn(zone)} (${zone})`
}
const zoneOf = (projectDir?: string) => (projectDir ? projectSettings(projectDir).timezone : undefined) as string | undefined ?? 'UTC'
const dayIn = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
/** The date alone, as a program's ctx.today reads it. */
export const dayOf = (projectDir?: string) => dayIn(zoneOf(projectDir))

export async function createComposer(opts: ComposerOpts): Promise<Composer> {
  const cfg = agentConfig('composer')
  const harness: Harness = opts.ica?.harness ?? cfg.harness
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl, projectDir: opts.projectDir, sessionId: opts.sessionId, tools: 'conversation' })
  if (opts.tools) await keepOnlyTools(cwd, opts.tools)
  const usage = await toolUsage(cwd, opts.tools)
  // A composer given a domain IS that domain's agent: its reference is the whole of the instructions, with the usage
  // of the tools it was left. The chat composer's role, which names every tool, is for a composer without one.
  const toolLines = usage ? `The tools, each as it says of itself — run them as bash commands in this folder:\n${usage}` : ''
  const systemReference = opts.reference ? [opts.reference, toolLines].filter(Boolean).join('\n\n') : [ROLE, toolLines].filter(Boolean).join('\n\n')
  // THE CONVERSATION OUTLIVES THE PROCESS. The harness session file is noted in the folder after every real turn
  // (never before one: a session with no turn has no file to resume), and a composer rebuilt from the folder —
  // after a restart, after an idle timeout — takes the conversation up where it was, not from nothing.
  const HARNESS_NOTE = join(cwd, '.harness-session')
  const noted = await readFile(HARNESS_NOTE, 'utf8').then((t) => t.trim()).catch(() => '')
  const resumeId = opts.ica?.resumeId ?? (noted && existsSync(noted) ? noted : undefined)
  const session = createSession(harness, { cwd, model: opts.ica?.model ?? cfg.model, provider: opts.ica?.provider ?? cfg.provider, thinking: opts.ica?.thinking ?? cfg.thinking, baseUrl: opts.ica?.baseUrl,
                                           resumeId, systemReference })
  if (resumeId) console.log(`[composer] ${opts.sessionId?.slice(0, 8) ?? '?'} resumes its conversation`)
  const noteHarness = async () => { try { const id = session.sessionId?.(); if (id) await writeFile(HARNESS_NOTE, id) } catch { /* best-effort */ } }
  await writeFile(join(cwd, '.system-prompt.md'), systemReference)   // what this agent was told, verbatim, for anyone to read
  console.log(`[composer] ${opts.sessionId?.slice(0, 8) ?? '?'} prompt ${systemReference.length} chars · tools ${opts.tools ? opts.tools.join(', ') : 'all'} · first line: ${systemReference.split('\n')[0].slice(0, 90)}`)
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
      await writeFile(join(cwd, '.agent'), 'composer')
      // The asker's data access, for every query this turn makes (the data seam reads it); always written, so a previous
      // asker's never lingers.
      await writeFile(join(cwd, '.reader.json'), JSON.stringify(o.reader ?? { principal: 'platform', policies: {} }))
      // THE ANSWER IS THE AGENT'S FINAL MESSAGE. A model finishes by saying its answer, so that is what is taken —
      // not a file it was asked to write, which invited shell and shipped the first slip. The turn ends when the
      // agent ends it; the last message, with its marker lines, is the reading, and it is kept in the question's
      // folder for the record.
      // THE ANSWER STARTS WITH A LINE `:::answer`. What the agent says before it is working aloud; what it says
      // from that line on is the answer, handed on piece by piece as each message arrives. An agent that writes
      // no marker is taken at its final message.
      let last = '', answer = '', begun = false
      const take = (piece: string) => {
        if (!piece.trim()) return
        answer = answer ? `${answer}\n${piece}` : piece
        // A marker line in the piece names a file the script has already written: resolved now, carried with the piece.
        if (/^[ \t]*:::\S+[ \t]+\S+/m.test(piece)) void blocksNamedIn(piece, cwd).then((blocks) => handlers?.onAnswer?.(piece, blocks)).catch(() => handlers?.onAnswer?.(piece))
        else handlers?.onAnswer?.(piece)
      }
      const prompt = `What the person is looking at:\n${context}\n\nTheir question: ${text}\n\ntoday: ${todayIn(opts.projectDir)}\nqid: ${o.qid}`
      const r = await session.run(prompt, { ...handlers, forSession: opts.sessionId, forPerson: o.person, onEvent: (ev) => {
        if (ev.kind === 'message' && ev.text?.trim()) {
          last = ev.text.trim()
          if (begun) take(last)
          else { const m = last.match(/^[ \t]*:::answer[ \t]*$/m); if (m) { begun = true; take(last.slice(m.index! + m[0].length)) } }
        }
        handlers?.onEvent?.(ev)
      } })
      await noteHarness()
      const markdown = (begun ? answer.trim() : (last || r.lastLines?.trim() || '')) || null
      if (markdown) await writeFile(join(dir, 'said.md'), markdown).catch(() => {})
      return { markdown, blocks: markdown ? await blocksNamedIn(markdown, await keepNamed(markdown, cwd, dir)) : [], periods: periodsIn(markdown), queries: await queriesOf(o.qid), ms: Date.now() - t0 }
    },
  }
}

export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(ROLE).digest('hex').slice(0, 12)
}
