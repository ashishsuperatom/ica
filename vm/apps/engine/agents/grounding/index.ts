// ── Grounding Agent ───────────────────────────────────────────────────────────
// ONE agent whose only job is to build this project's GROUNDING indexes — the maps that turn a fuzzy human
// reference (a name, a place, an id) into concrete structured ids. It never answers user questions and never
// touches the semantic model. It drives an ICA (default claude-code:sonnet-5, harness swappable) using the
// system prompt in ./SYSTEM.md, reaches data ONLY through the data seam (query.mjs → the datasource-manager),
// and persists what it discovers by calling build(config) on the grounding seam (grounding.mjs). It is COLD:
// spun up only when the admin triggers it, never warmed at boot. Its role file is copied in as ./GROUNDING.md
// so it never clobbers the analyst/modeler/connector role files that share the workspace.

import { readFile, cp, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Deterministic hash of the agent's instructions — changes → fresh session instead of a stale resume.
export async function promptVersion(): Promise<string> {
  return createHash('sha1').update(await readFile(join(__dirname, 'SYSTEM.md'), 'utf8').catch(() => '')).digest('hex').slice(0, 12)
}

export interface GroundingAgentOpts {
  root: string                                   // workspace root (a dir per project is created under here)
  projectId: string
  sources: string[]                              // the data source ids to ground (whatever this project has)
  ica?: { harness?: Harness; model?: string; resumeId?: string }   // default claude-code:sonnet-5
  managerUrl?: string                            // the data seam; default http://localhost:4000
}

export interface GroundingAgent {
  build(handlers?: RunHandlers): Promise<{ lastLines: string; ms: number; note: string }>
  session: Session
  cwd: string
}

export async function createGroundingAgent(opts: GroundingAgentOpts): Promise<GroundingAgent> {
  const harness = opts.ica?.harness ?? 'claude-code'
  const model = opts.ica?.model ?? 'claude-sonnet-5'
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl })
  // Distinct filename so it never clobbers the analyst/modeler/connector role files in the shared workspace.
  await cp(join(__dirname, 'SYSTEM.md'), join(cwd, 'GROUNDING.md'))

  const session = createSession(harness, { cwd, model, resumeId: opts.ica?.resumeId })
  const preamble = 'Read ./CONTEXT.md FIRST (the environment + the seams — where things are stored, the datasources; nothing to install), then ./GROUNDING.md (your instructions) and follow it exactly. The ONLY data access is query.mjs (call sources() before writing queries; use the right dialect). You PERSIST what you discover by calling build(config) on ./grounding.mjs.'

  return {
    cwd,
    session,

    // One full grounding pass over the sources: introspect → decide which columns are resolvable entities,
    // which hierarchies exist (derived from the data, not assumed), which value patterns identify a thing →
    // build(config) → verify by resolving. The agent writes ./out/grounding/result.json as its FINAL action;
    // that report is the completion signal we trust (a truncated turn is nudged to continue until it exists).
    async build(handlers) {
      await cp(join(__dirname, 'SYSTEM.md'), join(cwd, 'GROUNDING.md')).catch(() => {})
      const outDir = join(cwd, 'out', 'grounding')
      await mkdir(outDir, { recursive: true })
      const resultRel = './out/grounding/result.json'
      const resultPath = join(outDir, 'result.json')
      const prompt = `${preamble}

Build the GROUNDING indexes for these data sources: ${opts.sources.join(', ')}.
Begin by calling sources() to get each source's kind/dialect, then explore each source's real data. Following
./GROUNDING.md, discover which columns hold resolvable ENTITY values, which HIERARCHIES connect entities (a
hierarchy may be DERIVED from transactions, not a clean foreign key — verify it against real rows), and which
value PATTERNS identify a thing. Persist everything by calling build(config) on ./grounding.mjs, then VERIFY
by resolving a handful of real references (call the resolvers and check the ids that come back). Write
${resultRel} exactly, as your FINAL action:
  { "note": "<one paragraph: the entity types you grounded (with row counts), the hierarchies you built (with
     cardinality) and the patterns, plus the sample references you resolved to prove it works>" }
and print that same note.`
      // Completion signal: the report file. A turn can be TRUNCATED (claude-code auto-compaction on a full
      // context) before the work is done, returning to the prompt with nothing built and NO report. So if the
      // turn ends WITHOUT the report, nudge to CONTINUE until it exists (bounded).
      const reportExists = async () => { try { return !!(await readFile(resultPath, 'utf8')).trim() } catch { return false } }
      let r = await session.run(prompt, handlers)
      for (let i = 0; i < 5 && !(await reportExists()); i++) {
        handlers?.onOutput?.(`\r\n[grounding: turn ended without a report — continuing (${i + 1})]\r\n`)
        r = await session.run(
          `Continue exactly where you left off and FINISH. Persist everything via build(config) on ./grounding.mjs, ` +
          `then write ${resultRel} = { "note": "..." } as your FINAL action. Do not stop until ${resultRel} exists.`,
          handlers)
      }
      let note = r.lastLines
      try { const raw = await readFile(resultPath, 'utf8'); if (raw.trim()) note = JSON.parse(raw).note || note } catch { /* no report after nudges */ }
      return { ...r, note }
    },
  }
}
