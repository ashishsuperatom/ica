// ── Analyst Agent ─────────────────────────────────────────────────────────────
// ONE agent whose only job is to ANSWER a question (it never builds the model). It drives an ICA
// (default claude-code:sonnet5, swappable) using a per-CATEGORY system prompt — the classifier's
// label selects which instruction the agent gets, but it is always the same harness/model.
//
// It shares the SEMANTIC MODEL's workspace (same projectId dir): the model lives in ./project.sqlite
// and units accumulate in ./units/ — so a calculation is defined once and reused across questions.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { loadPrompt } from '../../prompts.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { execProgram } from '../../exec-program.js'
import { CATEGORIES, type Category } from './classify.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// Analyst prompt files via the override layer (volume override for the current image → baked fallback).
const sysFile = (f: string) => loadPrompt(join(__dirname, 'system', f), 'analyst/system/' + f)

// Deterministic hash of the analyst's instruction files. When it changes, the engine starts a fresh
// session instead of resuming one whose in-context behaviour predates the new instructions.
export async function promptVersion(): Promise<string> {
  const files = ['base.md', 'program_authoring.md', 'simple_lookup.md', 'complex_lookup.md', 'comparison.md', 'causal.md', 'counterfactual.md', 'analysis.md']
  const h = createHash('sha1')
  for (const f of files) h.update(sysFile(f))
  return h.digest('hex').slice(0, 12)
}

export interface AnalystOpts {
  root: string                                   // workspace root — MUST be the same the modeller used
  projectId: string                              // same projectId → same project.sqlite + units/
  sources: string[]
  ica?: { harness?: Harness; model?: string; resumeId?: string }   // default claude-code:sonnet5; resumeId to resume a prior session
  managerUrl?: string
}

export interface Answer {
  status: 'answered' | 'gap' | 'unknowable' | 'cannot_answer'   // cannot_answer kept for back-compat
  category?: Category                       // the agent's own read of the question's answer-shape (for the UI chip)
  answer: string
  period?: string                           // the time window in plain words (single-period answers)
  periods?: Array<{ label: string; detail: string }>   // the compared scopes (comparison answers)
  scope?: string                            // non-time filters only
  headline?: { label: string; display: string; value?: number }   // the one key number, labelled + human-formatted
  figures?: Array<{ label: string; display: string; sub?: string; value?: number; neg?: boolean }>   // a KPI strip (several key numbers) — rendered across the top of the card
  source?: string                           // one-line provenance ("AR ledger, snapshot 3 Jun 2026")
  value?: number                            // raw number (back-compat / programmatic)
  table?: { columns: string[]; rows: any[][]; total?: any[]; totalRows?: number }   // total = agent footer row; totalRows = true match count before the display cap
  caveat?: string                           // short "how to read this" warning
  usedNodes?: string[]
  gap?: { need: string; basis?: string }   // status 'gap' → hand to the model-builder, then re-ask
  missing?: string                          // status 'unknowable' → no source in the data
}

export interface AskResult {
  category: Category
  classifyMs: number
  answer: Answer | null                          // parsed from out/answer.json (null if the agent wrote none)
  lastLines: string                              // the agent's tail (fallback if no JSON)
  ms: number
}

export interface AskOpts {
  qid?: string             // question id → the agent writes into its folder ./out/<qid>/
  category?: Category      // skip re-classification (same question) — pass the known category
  // MODIFY: the user wants the CURRENT answer changed, not a new one. The engine passes only the QUESTION it
  // answers + the program's location (the id) — the analyst OPENS and READS the program itself (that is the
  // source of truth), so we never pass a stale answer string around.
  modify?: { programDir: string; prevQuestion?: string }
}

export interface Analyst {
  ask(question: string, handlers?: RunHandlers & { onCategory?: (c: Category) => void }, opts?: AskOpts): Promise<AskResult>
  session: Session
  cwd: string
}

// The analyst's full instructions: the base + EVERY answer-shape. We no longer pre-classify — the agent
// decides which category fits THIS question and follows that shape, then reports it. (classify.ts is kept
// for future pre-agent guardrails; it just isn't used to route here.)
async function fullSystem(): Promise<string> {
  const base = sysFile('base.md')
  const authoring = sysFile('program_authoring.md')
  let shapes = ''
  for (const c of CATEGORIES) {
    const s = sysFile(`${c}.md`)
    if (s.trim()) shapes += '\n\n' + s.trim()
  }
  return `${base}\n\n---\n\n${authoring.trim()}\n\n---\n\n# Answer shapes — decide which fits THIS question, follow its shape, and report it as \`category\`\n${shapes}`
}

export async function createAnalyst(opts: AnalystOpts): Promise<Analyst> {
  const harness = opts.ica?.harness ?? 'claude-code'
  const model = opts.ica?.model ?? 'claude-sonnet-5'

  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl })
  const session = createSession(harness, { cwd, model, resumeId: opts.ica?.resumeId })

  const preamble =
    'Read ./CONTEXT.md FIRST (environment: `node` for quick checks/probes, `tsx` for units/programs; and the seams), then ./ANALYST.md ' +
    '(your instructions) — follow it exactly. The semantic model is ./model.mjs; data is ONLY ./query.mjs / ' +
    './introspect.mjs. Your deliverable is a PROGRAM (see below) — the engine runs it and writes the answer.'

  return {
    cwd,
    session,

    async ask(question, handlers, opts = {}) {
      const t0 = Date.now()
      // The agent self-decides the category (no separate classifier). Full instructions → ./ANALYST.md
      // (a distinct filename so the modeller, which SHARES this workspace, never clobbers it).
      await writeFile(join(cwd, 'ANALYST.md'), await fullSystem())
      // Each question gets its OWN FOLDER (./out/<qid>/), with files named by MEANING:
      //   built.json   — a pointer to the program the analyst built (the engine runs it → answer.json)
      //   answer.json  — the FINAL answer (engine-written from the program output, or an unknowable direct)
      // A fresh qid folder each time → never a stale read; nothing deleted (full provenance).
      const dir = opts.qid ? join(cwd, 'out', opts.qid) : join(cwd, 'out')
      await mkdir(dir, { recursive: true })
      const answerRel = opts.qid ? `./out/${opts.qid}/answer.json` : `./out/answer.json`
      const builtRel  = opts.qid ? `./out/${opts.qid}/built.json`  : `./out/built.json`
      const answerPath = join(dir, 'answer.json')
      const builtPath  = join(dir, 'built.json')

      // Answer the question fresh (self-contained — never "continue the last one"; the queue means the
      // session may have moved on). The analyst is self-sufficient: it ALWAYS produces an answer — it never
      // defers to the model-builder (that is now an offline consolidation pass, not something in this path).
      const buildPrompt = `${preamble}

Question: ${question}

There is ONE path: BUILD A PROGRAM. Every question becomes a program — no exceptions. This includes a
greeting, small talk, or a question about you / the system / whether data sources are connected: for those,
build a small program whose output IS your reply. Whatever you would say goes INTO the program's output
(which becomes the answer card + UI) — never into chat.

1. Decide which answer-shape (\`category\`) from ./ANALYST.md fits THIS question, and report it as \`category\`.
2. RECON THE MODEL FIRST — before touching raw data. Decide what this question needs (entity, measure, grain,
   filters), then PROBE the model for it with a few targeted queries: ./model.mjs — \`find('term','term'…)\`,
   \`concepts()\`, \`intents()\`, \`getConcept(name)\`. Inspect what comes back; if a concept / unit / past program
   CONFIDENTLY fits, reuse or compose it — deterministic, and it carries the corrections we've made. ONLY if
   nothing confidently fits, analyze the raw data yourself (./query.mjs / ./introspect.mjs). Probe, judge, move
   on — never force an ill-fitting unit. Always PRODUCE AN ANSWER.
3. Write ${builtRel} = {"programDir":"programs/<slug>","params":{...the params...}, "parent":"root" | "<a prior intent id>"}
   pointing at the program you built, and RUN it with \`tsx run.mjs programs/<slug>/program.ts '<jsonParams>'\` until
   it is correct. Reuse an existing ./programs/ program if one fits. \`parent\` PLACES this question in the intent
   graph: "root" for a NEW topic, or the id of a prior intent (from \`intents()\`) if this FOLLOWS UP that
   question. Omit \`parent\` if unsure (it stays in the current thread).

The ENGINE runs your program and writes the answer from its REAL output — so the user sees the program's
result, never a figure or reply you typed. Do NOT write ${answerRel} yourself, and do NOT answer in chat. A
genuine unknowable (needs an assumption recorded NOWHERE in the data) is STILL a program: one that verifies
the gap against the data and outputs status "unknowable" + a \`missing\` reason.`

      // MODIFY: edit the EXISTING program in place. The engine supplies the target (it may have been built long
      // ago / by a reuse, so it is NOT in your context) — everything you need is below; don't guess.
      const m = opts.modify
      const modifyPrompt = m ? `${preamble}

The user wants to MODIFY the CURRENT answer — the SAME program, changed as they ask (a different calculation,
different columns/outputs, extra context, a different filter or top-N). Do NOT build a new program.

CURRENT PROGRAM: ./${m.programDir}  (it answers: "${m.prevQuestion ?? '(the current question)'}")

THE USER'S CHANGE REQUEST: ${question}

First OPEN and READ ./${m.programDir} (program.ts + its units) to see exactly what it currently computes and
shows — that program IS the source of truth. Then EDIT its units/code to satisfy the request — change the
calculation, the output shape, or add the context they asked for. RUN it with \`tsx run.mjs ${m.programDir}/program.ts '<jsonParams>'\`
until correct. Then write ${builtRel} = {"programDir":"${m.programDir}","params":{...}} pointing at the SAME
program (do NOT change programDir, do NOT set parent). The ENGINE runs it and writes the answer — do NOT write
${answerRel} yourself, and do NOT answer in chat.` : ''
      const prompt = m ? modifyPrompt : buildPrompt

      // Completion: the analyst either points at a built program (built.json) or writes an unknowable answer.json.
      const hasBuilt  = async () => { try { return !!JSON.parse(await readFile(builtPath, 'utf8'))?.programDir } catch { return false } }
      // A directly-written answer.json ends the turn ONLY when it is a NON-answered terminal (unknowable/gap —
      // those have no program). We never complete on an "answered" file: a real answer comes solely from the
      // ENGINE running the program, so an agent-left "answered" answer.json is stale scaffolding to ignore, not
      // a completion signal — else it would end the turn before built.json and short-circuit the run.
      const unknowableWritten = async () => { try { const s = JSON.parse(await readFile(answerPath, 'utf8'))?.status; return typeof s === 'string' && s !== 'answered' } catch { return false } }
      const doneWhen = async () => (await hasBuilt()) || (await unknowableWritten())
      const r = await session.run(prompt, { ...handlers, doneWhen })

      // THE ENGINE RUNS THE PROGRAM whenever the agent built one (wrote built.json) — ALWAYS, overwriting any
      // answer.json. A program IS the answer: re-running it is the point (the data may have changed, the params
      // may differ, this may be a modify of an existing program), so we NEVER trust a pre-existing answer.json
      // when a program exists — the agent must not be able to short-circuit the run by leaving a stale answer.
      // Only when there is NO program (the GAP / unknowable path wrote answer.json directly) do we leave it as-is.
      if (await hasBuilt()) {
        try {
          const ptr = JSON.parse(await readFile(builtPath, 'utf8'))
          handlers?.onNarration?.(`Running program ${ptr.programDir}`)
          // FRESH SUBPROCESS (not in-process): the long-lived engine runs under tsx, which caches modules by
          // path and ignores the kernel's `?t=` cache-bust — so an in-process re-run after an edit would execute
          // the STALE cached program. execProgram spawns run.mjs anew, guaranteeing the CURRENT code runs.
          const rr = await execProgram(cwd, ptr.programDir, ptr.params ?? {})
          // Keep the program's OWN status (an unknowable program outputs status:"unknowable"); default to
          // "answered" only when the program didn't declare one.
          const out = rr.output as any
          await writeFile(answerPath, JSON.stringify({ ...out, status: out?.status ?? 'answered' }, null, 2))
        } catch (e: any) {
          await writeFile(answerPath, JSON.stringify({ status: 'cannot_answer',
            answer: `The program was built but failed to run: ${String(e?.message ?? e).slice(0, 240)}` }, null, 2)).catch(() => {})
        }
      }

      // Read the analyst's final answer.json (the ENGINE fills it from the program output, or the agent
      // wrote an unknowable directly).
      let answer: Answer | null = null
      try { const raw = await readFile(answerPath, 'utf8'); if (raw.trim()) answer = JSON.parse(raw) } catch { /* none */ }

      // The agent decides + reports the category. Surface it (for the UI chip) when present.
      const category = (answer?.category as Category) ?? opts.category ?? 'analysis'
      handlers?.onCategory?.(category)
      return { category, classifyMs: 0, answer, lastLines: r.lastLines, ms: Date.now() - t0 }
    },
  }
}
