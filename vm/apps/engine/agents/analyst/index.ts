// ── Analyst Agent ─────────────────────────────────────────────────────────────
// ONE agent whose only job is to ANSWER a question (it never builds the model). It drives an ICA
// (default claude-code:sonnet5, swappable) using a per-CATEGORY system prompt — the classifier's
// label selects which instruction the agent gets, but it is always the same harness/model.
//
// It shares the SEMANTIC MODEL's workspace (same projectId dir): the model lives in ./db/project.sqlite
// and units accumulate in ./units/ — so a calculation is defined once and reused across questions.

import './generate-system.js'   // FIRST: (re)writes system/*.md from generate-system.ts before they're read below
import { answerView } from '../../exec-program.js'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { loadPrompt } from '../../prompts.js'
import { AUTHORING_SURFACE } from '../shared-prompts/authoring-reference.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import type { ProgramTarget } from '../../verbs/index.js'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { execProgram } from '../../exec-program.js'
import { CATEGORIES, type Category } from './classify.js'
import { lintAnswer, repairInstruction, MAX_REPAIR_ROUNDS } from '../../answer-lint.js'

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
  projectId: string                              // same projectId → same db/project.sqlite + units/
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
  modify?: ProgramTarget
  resolvedQuestion?: string   // the question with what it refers to written in (a follow-up made self-contained)
  reason?: string         // the composer's escalation note — a NON-authoritative hint of what was hard (the analyst re-derives from scratch)
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
  // The analyst's whole instruction into its system prompt (claude --append-system-prompt-file, so it APPENDS to
  // claude's own coding prompt): its generated system (already carries the mechanics) + the authoring SURFACE it
  // was missing (contract + example + rule) + the per-project data CONTEXT. Then it reads no instruction files.
  const context = (() => { try { return readFileSync(join(cwd, 'CONTEXT.md'), 'utf8') } catch { return '' } })()
  const systemReference = [await fullSystem(), AUTHORING_SURFACE, context].filter(Boolean).join('\n\n---\n\n')
  const session = createSession(harness, { cwd, model, resumeId: opts.ica?.resumeId, systemReference })
  // ONE linear path: claude appends the reference to its system prompt, so the analyst never reads an instruction
  // file. If a harness can't inject (pi/mock), fail LOUD rather than branch — a misconfiguration is easier to
  // debug than a silent second code path.
  if (session.referencePlacement !== 'in-context')
    console.warn(`[analyst] harness "${harness}" cannot put the reference in the system prompt — instructions will be missing; use claude-code/opencode/codex`)

  const preamble =
    'Your instructions, the program contract + example, and the data context are already in your system prompt. ' +
    'Search concepts with `./find-concept`, find where data lives with `./find-schema`, query with `./query` / `./sources` / ' +
    '`./introspect`, resolve names with `./resolve`. Your deliverable is a PROGRAM — the engine runs it and writes the answer.'

  return {
    cwd,
    session,

    async ask(question, handlers, opts = {}) {
      const t0 = Date.now()
      // The agent self-decides the category (no separate classifier); its instructions are in the system prompt,
      // so it reads no instruction file here.
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
      const reason = opts.reason
      const buildBody = `# Your task — a fresh, standalone question. A lighter agent tried it and could not finish; start from the beginning.
${reason ? `\nThe composer's note on why it couldn't — a HINT about what was hard, and it may be WRONG. Do NOT follow it as a direction; re-investigate independently and derive the answer yourself: "${reason}"\n` : ''}
Question: ${question}${opts.resolvedQuestion ? `\nIn full, with what it refers to written in: ${opts.resolvedQuestion}` : ''}
Build a program that answers it - follow your instructions (recon concepts first, then the data; every
question becomes a program). RUN it with \`tsx run.mjs programs/<slug>/program.ts '<jsonParams>'\` until correct.

Then COMMIT, as your final action: write ${builtRel} — once everything else is finished and verified.
  {"programDir":"programs/<slug>","params":{...}, "parent":"root" | "<a prior intent id>", "followups":["...","..."],
   "canonicalQuestions":["..."]}
\`canonicalQuestions\` — the question this program answers, phrased so its parameters are visible ("… for customer
<customer> in <period>"). Add another only when the program genuinely answers a differently-phrased question.
The ENGINE runs the program and writes the answer - the answer is its to write, never yours in chat.

`

      // MODIFY: edit the EXISTING program in place. The engine supplies the target (it may have been built long
      // ago / by a reuse, so it is NOT in your context) — everything you need is below; don't guess.
      const m = opts.modify
      const modifyBody = m ? `# Your task — MODIFY the current answer

The user wants to MODIFY the CURRENT answer — the SAME program, changed as they ask (a different calculation,
different columns/outputs, extra context, a different filter or top-N). Do NOT build a new program.

CURRENT PROGRAM: ./${m.programDir}  (it answers: "${m.question ?? '(the current question)'}")

THE USER'S CHANGE REQUEST: ${question}

First OPEN and READ ./${m.programDir} (program.ts + its units) to see exactly what it currently computes and
shows — that program IS the source of truth. Then EDIT its units/code to satisfy the request — change the
calculation, the output shape, or add the context they asked for. RUN it with \`tsx run.mjs ${m.programDir}/program.ts '<jsonParams>'\`
until correct. Then write ${builtRel} = {"programDir":"${m.programDir}","params":{...}, "followups":["…","…"]}
pointing at the SAME program (do NOT change programDir, do NOT set parent). \`followups\` = up to 3 FRESH
next questions for the CORRECTED answer (optional; vary them). The ENGINE runs it and writes the answer — do NOT write
${answerRel} yourself, and do NOT answer in chat.` : ''
      const taskRel = opts.qid ? `./out/${opts.qid}/task.md` : `./out/task.md`
      await writeFile(join(dir, 'task.md'), m ? modifyBody : buildBody)   // the long content lives in a FILE the analyst READS
      // The TYPED message stays SHORT so it is delivered reliably: a long line typed into the TUI can truncate
      // under load, which once sent the analyst a stray prompt fragment instead of the actual question.
      const prompt = `${preamble}

Your task is in ${taskRel} — read it and follow it exactly. ${m ? 'Modify the current program as it describes.' : 'It is a FRESH, standalone question — answer it from scratch; assume no earlier conversation.'}`

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
          let answer = answerView(rr.output)   // out of the unit envelope
          // Same repair round as the composer, for the same reason: the agent that wrote the view unit is one
          // turn away and still holds the trajectory. Errors only, capped, and the answer ships regardless.
          // Delete this block to switch repair off; the lint still logs.
          for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
            const before = lintAnswer(answer)
            const fix = repairInstruction(before)
            if (!fix) break
            const nBefore = before.filter((f) => f.severity === 'error').length
            try {
              await session.run(fix, handlers)
              answer = answerView((await execProgram(cwd, ptr.programDir, ptr.params ?? {})).output)
              // WAS THE ROUND WORTH IT — the only line that can answer "is the cap right?". A round that
              // fixes nothing is a round that should not exist; a round 2 that regularly finishes what round 1
              // started is the argument for keeping two. Without this the cap is a number someone picked.
              const after = lintAnswer(answer).filter((f) => f.severity === 'error').length
              console.log(`[answer] repair round ${round}/${MAX_REPAIR_ROUNDS}: ${nBefore} error(s) → ${after}` +
                (after === 0 ? ' — fixed' : after < nBefore ? ' — partly fixed' : ' — no change'))
            } catch (e: any) {
              console.warn(`[answer] repair round ${round} failed (${String(e?.message ?? e).slice(0, 120)}) — keeping the previous answer`)
              break
            }
          }
          await writeFile(answerPath, JSON.stringify(answer, null, 2))
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
