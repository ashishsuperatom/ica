// ── Concept Modeller (System 4 — "sleep") ─────────────────────────────────────
// ONE agent whose only job is OFFLINE CONSOLIDATION: study a batch of finished analyses and distill the
// reusable knowledge each one paid for into CONCEPTS. It never answers user questions. It drives an ICA
// (default claude-code:sonnet5, harness swappable), reaches data ONLY through the seam (./sources /
// ./introspect / ./query), and WRITES concepts directly to db/project.sqlite via ./model/model.mjs's
// concept() API — concepts are time-versioned, so re-writing one keeps the old version for time-travel.
import './generate-system.js'   // FIRST: (re)writes ./SYSTEM.md from generate-system.ts before it's read below
import { readFile, cp, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Deterministic hash of the modeller's instructions — changes → fresh session instead of a stale resume.
export async function promptVersion(): Promise<string> {
  return createHash('sha1').update(await readFile(join(__dirname, 'SYSTEM.md'), 'utf8').catch(() => '')).digest('hex').slice(0, 12)
}

export interface ConceptModellerOpts {
  root: string
  projectId: string
  sources: string[]
  ica?: { harness?: Harness; model?: string; resumeId?: string }
  managerUrl?: string
}

// One finished analysis the consolidation pass studies. The analyst already answered it; the modeller reads
// the program it built to learn what concept to distil.
export interface ConsolidationItem {
  question: string
  status: string
  programDir?: string                            // ./programs/<slug> the analyst built — the real computation
  usedNodes?: string[]                           // concepts the analyst REUSED (already modelled)
}

export interface ConceptModeller {
  consolidate(batch: ConsolidationItem[], batchId: string, handlers?: RunHandlers): Promise<{ lastLines: string; ms: number; note: string; changed: number }>
  session: Session
  cwd: string
}

export async function createConceptModeller(opts: ConceptModellerOpts): Promise<ConceptModeller> {
  const harness = opts.ica?.harness ?? 'claude-code'
  const model = opts.ica?.model ?? 'claude-sonnet-5'
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl })
  // Distinct filename (model/MODEL.md): the analyst SHARES this workspace and writes its own analyst/ANALYST.md.
  await cp(join(__dirname, 'SYSTEM.md'), join(cwd, 'model/MODEL.md')).catch(() => {})
  const session = createSession(harness, { cwd, model, resumeId: opts.ica?.resumeId })

  const preamble = 'Read ./CONTEXT.md FIRST (the tools + seams), then ./model/MODEL.md (your instructions) and ' +
    'follow it exactly. Read data with `./sources` / `./introspect` / `./query`, search concepts with ' +
    '`./find-concept`, and WRITE concepts through ./model/model.mjs (concept(name, props, meta)).'

  return {
    cwd,
    session,

    // OFFLINE CONSOLIDATION (System 4). Study a batch of finished analyses — reading the programs the analyst
    // built — and distil verified, reusable CONCEPTS so future answers reuse them instead of re-deriving.
    async consolidate(batch, batchId, handlers) {
      await cp(join(__dirname, 'SYSTEM.md'), join(cwd, 'model/MODEL.md')).catch(() => {})
      const outDir = join(cwd, 'out', 'consolidation', batchId)
      await mkdir(outDir, { recursive: true })
      const resultRel = `./out/consolidation/${batchId}/result.json`
      const resultPath = join(outDir, 'result.json')
      const list = batch.map((it, i) =>
        `${i + 1}. [${it.status}] "${it.question}"` +
        (it.programDir ? ` — program: ${it.programDir}` : '') +
        (it.usedNodes?.length ? ` — reused concepts: ${it.usedNodes.join(', ')}` : '')
      ).join('\n')
      const prompt = `${preamble}

You are running an OFFLINE CONSOLIDATION pass (System 4 — "sleep"). The analyst has been answering questions on
its own; study what it did and distil the reusable knowledge into CONCEPTS so future answers are faster and more
consistent. These questions are ALREADY answered — you are the more-thorough reviewer, not the answerer.

Analyses finished since the last consolidation:
${list}

Follow ./model/MODEL.md exactly: READ each program, VERIFY its computation against the real data (re-derive it
yourself — do not trust the analyst), MERGE into existing concepts (search with ./find-concept first, never
duplicate), and write clean, general concepts via ./model/model.mjs with meta.changedBy='consolidator'. An
[unknowable] program is the highest-value item — try hardest to work out whether the data can actually answer it.
Compute recipes are runnable queries against the source. Then write ${resultRel} as your FINAL action.`
      // Truncation guard: a claude-code auto-compaction can end the turn mid-work with no report. Nudge to
      // CONTINUE until the report exists (bounded).
      const reportExists = async () => { try { return !!(await readFile(resultPath, 'utf8')).trim() } catch { return false } }
      let r = await session.run(prompt, handlers)
      for (let i = 0; i < 5 && !(await reportExists()); i++) {
        handlers?.onOutput?.(`\r\n[concept-modeller: turn ended without a report — continuing (${i + 1})]\r\n`)
        r = await session.run(
          `Continue exactly where you left off and FINISH. Persist every concept via ./model/model.mjs, then write ` +
          `${resultRel} = { "changed": <n>, "note": "..." } as your FINAL action. Do not stop until ${resultRel} exists.`,
          handlers)
      }
      let note = r.lastLines, changed = 0
      try { const raw = await readFile(resultPath, 'utf8'); if (raw.trim()) { const j = JSON.parse(raw); note = j.note || note; changed = Number(j.changed) || 0 } } catch { /* no report */ }
      return { ...r, note, changed }
    },
  }
}
