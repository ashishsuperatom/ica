// ── Semantic-Model Agent ──────────────────────────────────────────────────────
// ONE agent whose only job is to build and refine the semantic model. It never answers user
// questions. It drives an ICA (default claude-code:sonnet5, any harness swappable) using the
// system prompt in ./SYSTEM.md, and reaches data ONLY through the data seam (query.mjs → the
// datasource-manager). The agent persists the model DIRECTLY to project.sqlite via ./model.mjs as it
// builds (upsertNode/upsertEdge) — the DB is the model's home, not a JSON file we import afterward.

import { readFile, writeFile, cp, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Deterministic hash of the modeler's instructions — changes → fresh session instead of a stale resume.
export async function promptVersion(): Promise<string> {
  return createHash('sha1').update(await readFile(join(__dirname, 'SYSTEM.md'), 'utf8').catch(() => '')).digest('hex').slice(0, 12)
}

export interface SemanticModellerOpts {
  root: string                                   // workspace root (a dir per project is created under here)
  projectId: string
  sources: string[]                              // data source ids to model, e.g. ['totalgroup']
  ica?: { harness?: Harness; model?: string; resumeId?: string }   // default claude-code:sonnet5; resumeId to resume a prior session
  managerUrl?: string                            // the data seam; default http://localhost:4000
}

export interface QaResult {
  question: string
  answer: string
  ui?: string
  usedNodes: string[]                            // semantic-model node ids the QA agent used
  correct: boolean                               // verdict → +1 good_use (true) or +1 bad_use (false)
}

export interface GapRequest {
  question: string                               // the user question the analyst could not answer — the modeler works from THIS alone
  qid?: string                                   // question id → result goes to ./out/gap-<qid>.json (scoped, no stale read)
}

// One finished analysis the offline consolidation pass studies. The analyst already answered it; the modeler
// reads the program it built to learn what concept/computation to fold into the model.
export interface ConsolidationItem {
  question: string
  status: string
  programDir?: string                            // ./programs/<slug> the analyst built — the real computation to study
  usedNodes?: string[]                           // model nodes the analyst REUSED (already-modeled concepts)
}

export interface SemanticModeller {
  buildFirstPass(handlers?: RunHandlers): Promise<{ lastLines: string; ms: number }>
  refine(qa: QaResult, handlers?: RunHandlers): Promise<{ lastLines: string; ms: number }>
  fillGap(gap: GapRequest, handlers?: RunHandlers): Promise<{ lastLines: string; ms: number; built: boolean; note: string }>
  consolidate(batch: ConsolidationItem[], batchId: string, handlers?: RunHandlers): Promise<{ lastLines: string; ms: number; note: string }>
  session: Session
  cwd: string
}

export async function createSemanticModeller(opts: SemanticModellerOpts): Promise<SemanticModeller> {
  const harness = opts.ica?.harness ?? 'claude-code'
  const model = opts.ica?.model ?? 'claude-sonnet-5'

  // Workspace: query.mjs (the data seam) + semantic/ units/ out/. Drop SYSTEM.md in so the ICA
  // reads its full-fidelity system prompt from a file (no prompt-line mangling).
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl })
  // Distinct filename (MODEL.md, not SYSTEM.md): the analyst SHARES this workspace and writes its own
  // ANALYST.md — separate files so neither clobbers the other.
  await cp(join(__dirname, 'SYSTEM.md'), join(cwd, 'MODEL.md'))

  const session = createSession(harness, { cwd, model, resumeId: opts.ica?.resumeId })

  const preamble = 'Read ./CONTEXT.md FIRST (the environment + the seams — where the model is stored, the datasources; nothing to install), then ./MODEL.md (your instructions) and follow it exactly. Explore and run code however you see fit. The ONLY data access is query.mjs (call sources() before writing queries; use the right dialect).'

  return {
    cwd,
    session,

    // One full first pass: introspect the sources → author the DAG + UNITs.
    async buildFirstPass(handlers) {
      const prompt = `${preamble}

Build the FIRST full pass of the semantic model for these data sources: ${opts.sources.join(', ')}.
Begin by calling sources() to get each source's kind/dialect, then introspect each source. Then
produce the semantic-model DAG (entities, dimensions, measures with additivity, relationships,
rules) and author the UNITs, following ./SYSTEM.md. Validate slice conservation. Print a summary.`
      return session.run(prompt, handlers)   // the agent persists the graph to project.sqlite itself (./model.mjs)
    },

    // Refine after a QA agent answered a question. TODO(project.sqlite): persist the +1 good/bad
    // counters on qa.usedNodes here once the schema step lands.
    async refine(qa, handlers) {
      const verdict = qa.correct ? 'CORRECT' : 'WRONG'
      const bump = qa.correct ? '+1 good_use' : '+1 bad_use'
      const prompt = `${preamble}

A question was just answered — verdict: ${verdict}.
Question: ${qa.question}
Answer: ${qa.answer}
Semantic-model nodes used: ${qa.usedNodes.join(', ') || '(none reported)'}

Record ${bump} on those nodes, then refine the semantic model per ./MODEL.md: add/merge/split
concepts, learn any parameter defaults this question revealed, add missing measures/rules, and fix
whatever produced a wrong answer. Print what you changed.`
      return session.run(prompt, handlers)
    },

    // Fill a GAP the analyst hit: a question whose answer the DATA supports but the MODEL didn't cover.
    // Extend the model for exactly this concept, verify against real data, and report back — then the
    // engine re-asks the analyst (same session) and the user gets the answer.
    async fillGap(gap, handlers) {
      await cp(join(__dirname, 'SYSTEM.md'), join(cwd, 'MODEL.md')).catch(() => {})
      // The modeler's report goes into the QUESTION FOLDER alongside the analyst's attempts:
      // ./out/<qid>/model.json — provenance of what was found/built for this question.
      const outDir = gap.qid ? join(cwd, 'out', gap.qid) : join(cwd, 'out')
      await mkdir(outDir, { recursive: true })
      const resultRel = gap.qid ? `./out/${gap.qid}/model.json` : `./out/model.json`
      const resultPath = join(outDir, 'model.json')
      const prompt = `${preamble}

A user asked this question and the ANALYST could not answer it from the current semantic model:

    "${gap.question}"

Work out from SCRATCH whether the DATA can answer it, and if so extend the model so it can. Do your OWN
analysis — you are NOT told (and must not assume) where the answer lives.

Following ./MODEL.md:
1. Be thorough before you conclude. Figure out which concept the question needs, then look widely for
   where the data could support it — don't settle for the first candidate, and don't confine yourself to
   one part of the data. A "can't answer" is usually just a source you haven't looked at yet.
2. Verify each candidate against the actual data: is it populated, and does the join hold? Never assert
   an unverified join, and never treat a sparsely-populated column as usable.
3. IF the data supports it → add exactly what this question needs (entity / dimension / measure /
   relationship) at proper quality (status / confidence / evidence / additivity) and persist via
   ./model.mjs. Do NOT re-model unrelated areas. IF nothing in the data supports it → invent nothing.
4. Write ${resultRel} exactly:
   { "built": true|false, "note": "<one paragraph for the analyst: what you added (node ids + how it
     computes) OR — only after looking widely — why it truly isn't buildable and what you ruled out>" }
5. Also print that same note.`
      // The modeler's report (model.json, written as its FINAL action, after persisting to project.sqlite)
      // is the true completion signal. We DON'T fast-complete on it (that could race ahead of the DB writes
      // flushing) — each turn runs to a real idle turn-end. But a turn can be TRUNCATED before the work is
      // done: claude-code auto-compaction (context full) ends the turn mid-modeling, so it returns to the
      // prompt with the concept unbuilt and NO report. The engine used to trust that turn-end and re-ask the
      // analyst with nothing built → a wrong "unknowable". So: if the turn ends WITHOUT the report, the work
      // is incomplete — nudge the modeler to CONTINUE until the report exists (bounded).
      const reportExists = async () => { try { return !!(await readFile(resultPath, 'utf8')).trim() } catch { return false } }
      let r = await session.run(prompt, handlers)
      for (let i = 0; i < 5 && !(await reportExists()); i++) {
        handlers?.onOutput?.(`\r\n[modeler: turn ended without a report — continuing (${i + 1})]\r\n`)
        r = await session.run(
          `Continue exactly where you left off and FINISH. Persist everything via ./model.mjs, then write ${resultRel} = ` +
          `{ "built": true|false, "note": "..." } as your FINAL action — set "built": false with the reason if the data ` +
          `truly cannot support it after looking widely. Do not stop until ${resultRel} exists.`,
          handlers)
      }
      let built = false, note = r.lastLines
      try {
        const raw = await readFile(resultPath, 'utf8')
        if (raw.trim()) { const g = JSON.parse(raw); built = !!g.built; note = g.note || note }
      } catch { /* still no report after nudges — assume built so the analyst at least re-tries */ built = true }
      return { ...r, built, note }
    },

    // OFFLINE CONSOLIDATION (System 4 — "sleep"). The analyst has been answering questions on its own; this
    // pass studies a BATCH of finished analyses — reading the programs the analyst built — and grows the
    // model so future answers reuse a modeled concept instead of re-deriving it. It NEVER answers questions
    // (they are already answered) and never blocks the analyst; it just consolidates behind the scenes.
    async consolidate(batch, batchId, handlers) {
      await cp(join(__dirname, 'SYSTEM.md'), join(cwd, 'MODEL.md')).catch(() => {})
      const outDir = join(cwd, 'out', 'consolidation', batchId)
      await mkdir(outDir, { recursive: true })
      const resultRel = `./out/consolidation/${batchId}/result.json`
      const resultPath = join(outDir, 'result.json')
      const list = batch.map((it, i) =>
        `${i + 1}. [${it.status}] "${it.question}"` +
        (it.programDir ? ` — program: ${it.programDir}` : '') +
        (it.usedNodes?.length ? ` — reused model nodes: ${it.usedNodes.join(', ')}` : '')
      ).join('\n')
      const prompt = `${preamble}

You are running an OFFLINE CONSOLIDATION pass (System 4 — "sleep"). The analyst has been answering questions
on its own, doing its own analysis where the model didn't cover them. Your job is to study what it did and
GROW the semantic model so future answers are faster and more consistent. You are NOT answering these
questions for the user (they are already answered) — but you ARE the reviewer, and you are more thorough than
the analyst. You have more time and must produce concrete, VERIFIED knowledge.

Analyses finished since the last consolidation:
${list}

Following ./MODEL.md:
1. READ the program each analysis built (./programs/<slug>/program.ts and its units/). That code is the
   analyst's real computation — the SQL it wrote, the joins it used, the concepts it computed from scratch.
   An analysis that reused model nodes needs little; one that computed everything fresh is the real signal.
2. **DO NOT TRUST IT — VERIFY IT.** The analyst works fast and can be wrong: a join that doesn't actually
   hold, a filter that quietly drops rows, a measure summed across a non-additive grain, a sentinel treated
   as data. Before you promote anything, RE-DERIVE it yourself against the real data (run your own queries,
   verify the joins, check cardinality / slice conservation / reconciliation). If the analyst's computation is
   WRONG, do NOT fold the mistake into the model — record the CORRECT concept, and note the discrepancy so
   the error does not propagate. A verified concept is worth promoting; an unverified one is not.
3. Find what RECURS and what is NOT yet modeled: a concept the analyst computed from scratch that should be a
   modeled entity / measure / relationship; a parameter default the usage reveals; a join it relied on. A
   concept asked repeatedly matters more — usage is the signal for what to promote.
3b. **An [unknowable] program is the HIGHEST-value item — try hardest there.** The analyst gave up, but you
   are more capable and have more time: work out from scratch whether the DATA can actually answer it (look
   widely — a "can't answer" is usually a source the analyst didn't reach). If YOU can, model exactly what it
   needs and note that the unknowable verdict can now be INVALIDATED (next time the question is asked it will
   be answerable). If after looking widely it truly is unknowable, say so and what you ruled out — don't
   invent a source.
4. Add/refine those in the model at proper quality (status / confidence / evidence / additivity — evidence
   being what YOU verified, not what the analyst claimed) and persist via ./model.mjs. MERGE with existing
   nodes — never duplicate a concept already modeled; invent nothing the data doesn't support. You may leave
   the model unchanged if these analyses revealed nothing new (or nothing that survived verification).
5. Write ${resultRel} exactly, as your FINAL action:
   { "changed": <number of nodes added/merged>, "note": "<one paragraph: what you consolidated — node ids
     added/merged, defaults learned, and any analyst computation you found WRONG and corrected — or why
     nothing needed changing>" }
   and print that same note.`
      // Same truncation guard as fillGap: a claude-code auto-compaction can end the turn mid-work with no
      // report. Nudge to CONTINUE until the report exists (bounded).
      const reportExists = async () => { try { return !!(await readFile(resultPath, 'utf8')).trim() } catch { return false } }
      let r = await session.run(prompt, handlers)
      for (let i = 0; i < 5 && !(await reportExists()); i++) {
        handlers?.onOutput?.(`\r\n[modeler: consolidation turn ended without a report — continuing (${i + 1})]\r\n`)
        r = await session.run(
          `Continue exactly where you left off and FINISH. Persist everything via ./model.mjs, then write ` +
          `${resultRel} = { "changed": <n>, "note": "..." } as your FINAL action. Do not stop until ${resultRel} exists.`,
          handlers)
      }
      let note = r.lastLines
      try { const raw = await readFile(resultPath, 'utf8'); if (raw.trim()) note = JSON.parse(raw).note || note } catch { /* no report */ }
      return { ...r, note }
    },
  }
}
