// The COMPOSER (System 2) — answers by COMPOSING pre-evaluated concepts into a program. It does NO discovery.
// It SHARES the analyst's workspace and the SHARED program-authoring mechanics, so a composer-written program is
// identical in shape to an analyst-written one; it differs only in the brain (a cheap opencode model) and its
// instruction (compose from concepts via ./concepts/find.mjs; on any gap, ESCALATE to the analyst rather than
// guess). The engine runs the program it points at and stamps authoredBy.by='composer'.
import './generate-system.js'   // FIRST: (re)writes SYSTEM.md from generate-system.ts before it's read below
import { answerView } from '../../exec-program.js'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { AUTHORING_REFERENCE } from '../shared-prompts/authoring-reference.js'
import { loadPrompt } from '../../prompts.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { explainPrompt, explainAnswer } from '../../verbs/explain.js'
import type { ProgramTarget } from '../../verbs/index.js'
import { execProgram } from '../../exec-program.js'
import { PROGRAM_AUTHORING } from '../shared-prompts/program-authoring.js'   // SHARED single source (analyst + composer)
import { lintAnswer, repairInstruction, MAX_REPAIR_ROUNDS } from '../../answer-review.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const sysFile = () => loadPrompt(join(__dirname, 'SYSTEM.md'), 'composer/SYSTEM')
// The composer's instructions = its role (compose, don't discover) + the SHARED program-writing mechanics.
const fullSystem = () => [sysFile(), ...PROGRAM_AUTHORING].join('\n\n')

export interface ComposerOpts {
  root: string
  projectId: string
  managerUrl?: string
  ica?: { harness?: Harness; model?: string; provider?: string; baseUrl?: string }
}
// canonicalQuestions — what this program ANSWERS, in question form, written by whoever built it. This is the
// retrieval substrate: a new question is matched against these (question ↔ question), never against program
// source, so a near-miss can't pull program code into the matching agent's context.
export interface BuiltPtr { programDir: string; params?: any; terms?: any[]; followups?: string[]; canonicalQuestions?: string[] }
export interface ComposerResult {
  escalate?: { reason: string }        // set when concepts didn't cover it → engine hands off to the analyst
  answer?: any                         // the engine-run program output (when composed)
  built?: BuiltPtr                     // the program pointer (so the engine persists + stamps provenance)
  category?: string
  lastLines?: string
  ms: number
}
export interface ProgramCandidate { question: string; program?: string; score: number }
// The shape every verb uses — defined once in verbs/. Kept as an alias so existing call sites read naturally.
export type ModifyTarget = ProgramTarget

/** A program whose DECLARED canonical question is the one just asked, with this question's values already bound.
 *  Retrieval found it; the composer still decides — it is a strong lead, not a verdict. */
export interface CanonicalMatch { programDir: string; params: Record<string, unknown>; canonical: string }
export interface Composer {
  ask(question: string, handlers?: RunHandlers, opts?: { qid?: string; candidates?: ProgramCandidate[]; modify?: ModifyTarget; canonicalMatch?: CanonicalMatch; resolvedQuestion?: string; explain?: ProgramTarget; raw?: string; sid?: string; build?: string }): Promise<ComposerResult>
  session: Session
  cwd: string
}

export async function createComposer(opts: ComposerOpts): Promise<Composer> {
  // pi on the ChatGPT subscription, which is what this agent is tuned against: the fastest to start (no CLI
  // process between us and the model) and the richest event stream, which is what puts real per-step timings
  // in the log. Overridable per project by ICA_COMPOSER_*.
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_COMPOSER_HARNESS as Harness) ?? 'pi'
  const model = opts.ica?.model ?? process.env.ICA_COMPOSER_MODEL ?? 'gpt-5.6-luna'
  const provider = opts.ica?.provider ?? process.env.ICA_COMPOSER_PROVIDER ?? undefined   // pi picks: codex when logged in
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl })
  // The composer's WHOLE instruction — its role + the authoritative authoring reference (contract + example +
  // mechanics) + the per-project data CONTEXT — installed into the agent's system prompt via systemReference.
  // The agent then never reads a file to learn how to write a program or what the data is. CONTEXT.md is written
  // into the workspace by prepareWorkspace; we fold its text in here.
  const context = (() => { try { return readFileSync(join(cwd, 'CONTEXT.md'), 'utf8') } catch { return '' } })()
  const systemReference = [sysFile(), AUTHORING_REFERENCE, context].filter(Boolean).join('\n\n')
  const session = createSession(harness, { cwd, model, provider, baseUrl: opts.ica?.baseUrl, systemReference })
  // ONE linear path: the composer's harnesses (opencode/claude/codex) all carry the reference in the system
  // prompt, so the agent never reads an instruction file. If a harness can't inject (pi/mock), fail LOUD here
  // rather than branch the whole flow — a misconfiguration is easier to debug than a silent second code path.
  if (session.referencePlacement !== 'in-context')
    console.warn(`[composer] harness "${harness}" cannot put the reference in the system prompt — instructions will be missing; use opencode/claude/codex`)

  const preamble =
    'Compose a PROGRAM the engine runs to answer the question. Your role, the program contract + example, and the ' +
    'data context are already in your instructions. Search concepts with `./find-concept "<phrase>"`; explore the ' +
    'data with `./query`/`./introspect`; escalate to the analyst on a hard problem (many composers share one analyst).'

  return {
    cwd,
    session,
    async ask(question, handlers, o = {}) {
      const t0 = Date.now()
      const dir = o.qid ? join(cwd, 'out', o.qid) : join(cwd, 'out')
      await mkdir(dir, { recursive: true })
      const builtRel    = o.qid ? `./out/${o.qid}/built.json`    : `./out/built.json`
      const escalateRel = o.qid ? `./out/${o.qid}/escalate.json` : `./out/escalate.json`
      const builtPath    = join(dir, 'built.json')
      const escalatePath = join(dir, 'escalate.json')
      const answerPath   = join(dir, 'answer.json')

      // ── EXPLAIN: say how the answer was reached, then stop. ─────────────────────────────────────────────
      // IT WRITES A MARKDOWN FILE. This took a reply instead for a while, because a file seemed to only delay
      // the words — but the words were not arriving sooner either way: the harness reports a COMPLETED message,
      // so a reply lands in one block at the end exactly as a file does. There was no streaming to trade the
      // quality for, and the quality is plainly better written as a document than said in a chat.
      //
      // The file is also the completion signal, which is what doneWhen wants — the same convention as
      // built.json and escalate.json. And if an agent answers in the reply instead of writing one, that reply
      // is taken, through the same filter that keeps machinery off a user's screen. All we want is the
      // explanation; the file is how we usually get the best one.
      // ONE file, always the same one. Explaining again rewrites it rather than leaving a folder of
      // explanations nobody will open. It is REMOVED first: doneWhen waits for a non-empty file, and a
      // previous explanation still sitting there would satisfy that instantly — the agent would appear to have
      // answered in no time, with the last question's answer.
      const explainRel  = `./out/explain.md`
      const explainPath = join(cwd, 'out', 'explain.md')
      if (o.explain) {
        await rm(explainPath, { force: true }).catch(() => {})
        const prompt = explainPrompt({ raw: o.raw ?? question, target: o.explain, mdRel: explainRel })
        const done = async () => { try { return (await readFile(explainPath, 'utf8')).trim().length > 0 } catch { return false } }
        const r = await session.run(prompt, { ...handlers, doneWhen: done })
        const body = await readFile(explainPath, 'utf8').catch(() => '')
        if (!body.trim()) return { answer: { status: 'cannot_answer', answer: 'I could not put together an explanation for that one.' }, category: 'analysis', lastLines: r.lastLines, ms: Date.now() - t0 }
        return { answer: explainAnswer(body, o.explain.programDir), category: 'analysis', lastLines: r.lastLines, ms: Date.now() - t0 }
      }

      const cands = (o.candidates ?? []).filter(c => c.program)
      const candBlock = cands.length
        ? 'Existing programs the engine matched to this question (score = similarity, higher = closer):\n' +
          cands.slice(0, 6).map(c => `- ${c.program} — "${c.question}" (${c.score.toFixed(2)})`).join('\n')
        : 'No existing program matched this question.'
      // SEARCH FOR THEM YOURSELF. The engine used to pre-search and hand over six concept names; it no longer
      // does, because the phrase YOU pick is a better cue than n-grams of the user's wording — it is your
      // current hypothesis, chosen after seeing the problem — and you can search again when the first phrase
      // misses, which a single pre-fire never could.
      //
      // ESCALATE NEEDS BOTH TO BE EMPTY. The first version of this said "no concept fits → escalate", which was
      // inherited from when the engine handed over the list: an empty list then meant the engine had searched
      // and found nothing. Now the composer does the searching, and a real search returns nothing far more
      // often — so that wording threw away perfectly good program matches. Observed immediately: a question
      // with an existing program at 0.87 similarity, which the agent had already recognised in its own words
      // ("an existing program already answers this exact question"), escalated to the analyst because no
      // CONCEPT matched. Reuse never needed a concept; the two are separate paths to an answer.
      const conceptBlock = '\nStart with what exists: `./find-concept "<phrase>"` (full-text, fast — search in your' +
        ' own words, and again with different words if the first misses), and open the ones that look right with' +
        ' `./get-concept "<name>"`. A fitting concept is the fastest correct route, and a program above may answer' +
        ' this already.\n' +
        // ESCALATE ON FINISHABILITY, not on the absence of a concept. This used to read "no program AND no concept
        // → escalate", which contradicted the system prompt the moment the composer stopped being forbidden to
        // discover: it has every tool the analyst has, so "nothing matched" is the start of the work, not the end
        // of it. What it cannot do is spend an analyst's worth of time — so the test is whether the question is
        // finishable from here, and escalating early is a good outcome, not a failure.
        `Where nothing fits, work it out yourself — every tool is available. ESCALATE when the question is not` +
        ` finishable from here: the data is not where you expected, the approach needs establishing from scratch,` +
        ` or you have tried and it is not coming out right. Then write ${escalateRel} = {"reason":"<what is` +
        ` missing or what you tried>"} and STOP. Escalating at ninety seconds beats a wrong answer at four` +
        ` minutes.\n`
      const m = o.modify
      // MODIFY: edit the SAME program in place (the engine supplies the current program — it may be from a
      // reuse, so it is NOT in your context). No new program, no escalate — just apply the edit and rerun.
      const modifyPrompt = m ? `${preamble}

The user wants to EDIT the CURRENT program — the SAME program, changed as they ask (a different calculation,
columns/outputs, a filter, or a top-N). Make the edit from what you ALREADY have: the program's own code plus the
concepts (\`./find-concept "<phrase>"\`). Do NOT discover raw data, and do NOT build a new program.

CURRENT PROGRAM: ./${m.programDir}${m.question ? `  (it answers: "${m.question}")` : ''}
THE EDIT: ${question}

OPEN and READ ./${m.programDir} (program.ts + its units). If the edit can be made from its code + the concepts you
can pull, EDIT it, RUN it (\`tsx run.mjs ${m.programDir}/program.ts '<json>'\`) until correct, then write
${builtRel} = {"programDir":"${m.programDir}","params":{…},"canonicalQuestions":["<the canonical form of THIS question>"]} as your final action, pointing at the SAME program (do NOT change
programDir). But if the edit needs something in NEITHER the program NOR any concept — you'd have to discover it —
write ${escalateRel} = {"reason":"<what's missing>"} and STOP; the analyst will handle it. Never explore raw
data. Do NOT write answer.json.${m.concepts?.length ? `

THIS PROGRAM WAS BUILT FROM: ${m.concepts.join(', ')}.
Ask where the fault actually IS. A program is usually wrong because something it was built from is wrong, and a
fix that stops at the program leaves that to be built from again — the next question inherits it. Read the ones
that bear on the correction (\`./get-concept "<name>"\`) and check them against what you are being told to fix:
a value stated in a concept's prose that should be a parameter, a rule the program contradicts, a definition
that has moved on. If the fault is in a concept, say so plainly in your commit note — name the concept and what
is wrong with it — as well as fixing the program.` : ''}` : ''

      // What the person typed, and — when their words pointed at the conversation — the same question with that
      // written in. Both, so nothing is hidden: they asked the first, they meant the second.
      const asked = `Question: ${question}` + (o.resolvedQuestion ? `\nIn full, with what it refers to written in: ${o.resolvedQuestion}` : '')
      const composePrompt = `${preamble}

${asked}

${candBlock}
${conceptBlock}
${o.canonicalMatch ? `ASKED BEFORE — this exact question was answered by \`${o.canonicalMatch.programDir}\` with ${JSON.stringify(o.canonicalMatch.params)}.
That is a starting point, not a verdict: it was written for the earlier asking and the data has moved since.
RUN it (\`tsx run.mjs ${o.canonicalMatch.programDir}/program.ts '${JSON.stringify(o.canonicalMatch.params)}'\`) and read the output as the person who asked would — nothing after you checks this. If it genuinely answers, COMMIT as your final action: write ${builtRel} = {"programDir":"${o.canonicalMatch.programDir}","params":${JSON.stringify(o.canonicalMatch.params)},"canonicalQuestions":["<the canonical form>"]} and stop. If it is empty, sidesteps the question, or the figures do not fit, carry on below.
` : ''}
1. Can a program above answer THIS question EXACTLY — the SAME measure, scope and grain, differing at most by a
   parameter (a date, a top-N)? Only then reuse it: pick it, run it, and COMMIT — write ${builtRel} = {"programDir":"<that program>","params":{…},"canonicalQuestions":["<the canonical form of THIS question>"]} as your final action. Reusing ADDS this question's form to the ones that program already answers — that is how it becomes findable for the next person who phrases it your way.
   A program built for a RELATED-but-different question is NOT a fit — "amount billed" is not "net spend", a header
   total is not a line-level breakdown, gross is not net. Do NOT adapt or force-fit a program; when it is not an
   EXACT match, go to step 2 and build from the CONCEPTS — never from a not-quite program. Accuracy over reuse.
2. Otherwise COMPOSE from the concepts (\`./find-concept "<phrase>"\` for names, \`./get-concept "<name>"\` for one concept's runnable query). If they
   don't fully cover it, do the work yourself — \`./query\`/\`./introspect\` the data, analyse, write the units +
   program. Run it (\`tsx run.mjs programs/<slug>/program.ts '<json>'\`), verify against the review checks, write
   Then COMMIT, as your final action — once everything else is finished and verified: write
   ${builtRel} = {"programDir":"programs/<slug>","params":{…},"canonicalQuestions":["…"]}. \`canonicalQuestions\` — the question this program answers, phrased so its parameters are
   visible ("… for customer <customer> in <period>"); add another only when it genuinely answers a differently-
   phrased question.
3. Escalate to the analyst when it's a hard problem or you can't figure it out. Write ${escalateRel} =
   {"reason":"<what's blocking you>"} and STOP. Many composers share one analyst, so do the rest yourself.`
      // `build` is a COMPLETE instruction, handed over whole — a view, and anything later that knows exactly
      // what it wants written. It bypasses the compose preamble and the concept block on purpose: that block
      // says "no concept fits this question, ESCALATE now" whenever no concepts were passed, so wrapping a
      // self-contained instruction in it made the agent give up in thirteen seconds without reading it.
      // Everything after this is shared — same built.json, same run, same result.
      const prompt = o.build ?? (m ? modifyPrompt : composePrompt)

      const hasBuilt     = async () => { try { return !!JSON.parse(await readFile(builtPath, 'utf8'))?.programDir } catch { return false } }
      const hasEscalated = async () => { try { return !!JSON.parse(await readFile(escalatePath, 'utf8')) } catch { return false } }
      const doneWhen = async () => (await hasBuilt()) || (await hasEscalated())
      const r = await session.run(prompt, { ...handlers, doneWhen })

      // Escalation wins if present — the composer judged the concepts insufficient; hand off to the analyst.
      if (await hasEscalated()) {
        let reason = 'concepts did not cover the question'
        try { reason = String(JSON.parse(await readFile(escalatePath, 'utf8'))?.reason || reason) } catch { /* keep default */ }
        return { escalate: { reason }, lastLines: r.lastLines, ms: Date.now() - t0 }
      }

      // Composed a program → the ENGINE runs it (same contract as the analyst): fresh subprocess, program output
      // is the answer. We never trust a pre-written answer.json.
      if (await hasBuilt()) {
        const built = JSON.parse(await readFile(builtPath, 'utf8')) as BuiltPtr
        let answer: any
        try {
          handlers?.onNarration?.('Running the numbers…')   // shown as a business beat (composer self-narrates)
          const rr = await execProgram(cwd, built.programDir, built.params ?? {}, { qid: o.qid, sid: o.sid })
          answer = answerView(rr.output)   // out of the unit envelope — see answerView
          // ── REPAIR, HERE, BECAUSE THE SESSION IS STILL OPEN ──────────────────────────────────────────
          // The agent that wrote this view unit is one turn away and still holds the whole trajectory. Handing
          // the defect back now costs a short turn; noticing it downstream would mean re-establishing all of
          // that context to fix a column tag. ERRORS only, at most MAX_REPAIR_ROUNDS attempts, and the answer
          // ships either way — a table with one unclickable column is a far better outcome than a turn that
          // loops until the user gives up. Delete this block to switch repair off; the lint still logs.
          for (let round = 1; round <= MAX_REPAIR_ROUNDS; round++) {
            // GUARDED, because this sits inside the try that turns a throw into "the program failed to run".
            // A bug in a lint rule must not convert a good answer into cannot_answer — the whole point of the
            // check is to make faults visible, not to invent one.
            let before: ReturnType<typeof lintAnswer> = []
            let fix: string | null = null
            try { before = lintAnswer(answer); fix = repairInstruction(before) }
            catch (e: any) { console.warn(`[answer] repair check FAILED (${String(e?.message ?? e).slice(0, 160)}) — shipping the answer as it is`); break }
            if (!fix) break
            const nBefore = before.filter((f) => f.severity === 'error').length
            try {
              await session.run(fix, handlers)
              answer = answerView((await execProgram(cwd, built.programDir, built.params ?? {}, { qid: o.qid, sid: o.sid })).output)
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
          await writeFile(answerPath, JSON.stringify(answer, null, 2)).catch(() => {})
        } catch (e: any) {
          answer = { status: 'cannot_answer', answer: `The composed program failed to run: ${String(e?.message ?? e).slice(0, 240)}` }
        }
        return { answer, built, category: answer?.category ?? 'analysis', lastLines: r.lastLines, ms: Date.now() - t0 }
      }

      // Neither built nor escalated (the model gave up mid-run) → treat as an escalation so the analyst covers it.
      return { escalate: { reason: 'composer produced neither a program nor an escalation' }, lastLines: r.lastLines, ms: Date.now() - t0 }
    },
  }
}

// Deterministic hash of the instruction the agent actually gets (role + the authoring reference) — the slot
// resumes a warm session only while this is unchanged, else starts fresh, so a reference edit takes effect.
export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(sysFile() + AUTHORING_REFERENCE).digest('hex').slice(0, 12)
}
