// The COMPOSER (System 2) — answers by COMPOSING pre-evaluated concepts into a program. It does NO discovery.
// It SHARES the analyst's workspace and the SHARED program-authoring mechanics, so a composer-written program is
// identical in shape to an analyst-written one; it differs only in the brain (a cheap opencode model) and its
// instruction (compose from concepts via ./concepts/find.mjs; on any gap, ESCALATE to the analyst rather than
// guess). The engine runs the program it points at and stamps authoredBy.by='composer'.
import './generate-system.js'   // FIRST: (re)writes SYSTEM.md from generate-system.ts before it's read below
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { AUTHORING_REFERENCE } from '../shared-prompts/authoring-reference.js'
import { loadPrompt } from '../../prompts.js'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'
import { execProgram } from '../../exec-program.js'
import { PROGRAM_AUTHORING } from '../shared-prompts/program-authoring.js'   // SHARED single source (analyst + composer)

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
export interface ModifyTarget { programDir: string; prevQuestion?: string }

/** A program whose DECLARED canonical question is the one just asked, with this question's values already bound.
 *  Retrieval found it; the composer still decides — it is a strong lead, not a verdict. */
export interface CanonicalMatch { programDir: string; params: Record<string, unknown>; canonical: string }
export interface Composer {
  ask(question: string, handlers?: RunHandlers, opts?: { qid?: string; candidates?: ProgramCandidate[]; modify?: ModifyTarget; conceptNames?: string[]; canonicalMatch?: CanonicalMatch }): Promise<ComposerResult>
  session: Session
  cwd: string
}

export async function createComposer(opts: ComposerOpts): Promise<Composer> {
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_COMPOSER_HARNESS as Harness) ?? 'opencode'
  const model = opts.ica?.model ?? process.env.ICA_COMPOSER_MODEL ?? 'deepseek-v4-flash'
  const provider = opts.ica?.provider ?? process.env.ICA_COMPOSER_PROVIDER ?? 'opencode-go'
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

      const cands = (o.candidates ?? []).filter(c => c.program)
      const candBlock = cands.length
        ? 'Existing programs the engine matched to this question (score = similarity, higher = closer):\n' +
          cands.slice(0, 6).map(c => `- ${c.program} — "${c.question}" (${c.score.toFixed(2)})`).join('\n')
        : 'No existing program matched this question.'
      // Concept NAMES the engine surfaced for this question (names only — no method, so it can't bias you toward
      // a formula you might not use). Read the ones that look right with `./get-concept "<name>"`. This is
      // a head-start, NOT the whole set — find-concept is still live for anything else you need.
      const conceptBlock = (o.conceptNames ?? []).length
        ? '\nCandidate concepts for this question, most-relevant first — SOME MAY NOT FIT. Open the ones that look' +
          ' right with `./get-concept "<name>"`, use those, ignore the rest (find-concept stays available):\n' +
          (o.conceptNames ?? []).map(n => `- ${n}`).join('\n') + '\n'
        // No concept fits this question → nothing to compose from. That is fresh analysis, which is the analyst's
        // job — escalate immediately rather than attempt discovery yourself.
        : `\nNo concept fits this question — there is nothing to compose from. ESCALATE now: write ${escalateRel} = {"reason":"no relevant concept — needs fresh analysis"} and STOP. Do not do the discovery yourself.\n`
      const m = o.modify
      // MODIFY: edit the SAME program in place (the engine supplies the current program — it may be from a
      // reuse, so it is NOT in your context). No new program, no escalate — just apply the edit and rerun.
      const modifyPrompt = m ? `${preamble}

The user wants to EDIT the CURRENT program — the SAME program, changed as they ask (a different calculation,
columns/outputs, a filter, or a top-N). Make the edit from what you ALREADY have: the program's own code plus the
concepts (\`./find-concept "<phrase>"\`). Do NOT discover raw data, and do NOT build a new program.

CURRENT PROGRAM: ./${m.programDir}${m.prevQuestion ? `  (it answers: "${m.prevQuestion}")` : ''}
THE EDIT: ${question}

OPEN and READ ./${m.programDir} (program.ts + its units). If the edit can be made from its code + the concepts you
can pull, EDIT it, RUN it (\`tsx run.mjs ${m.programDir}/program.ts '<json>'\`) until correct, then write
${builtRel} = {"programDir":"${m.programDir}","params":{…}} as your final action, pointing at the SAME program (do NOT change
programDir). But if the edit needs something in NEITHER the program NOR any concept — you'd have to discover it —
write ${escalateRel} = {"reason":"<what's missing>"} and STOP; the analyst will handle it. Never explore raw
data. Do NOT write answer.json.` : ''

      const composePrompt = `${preamble}

Question: ${question}

${candBlock}
${conceptBlock}
${o.canonicalMatch ? `MATCHED PROGRAM — \`${o.canonicalMatch.programDir}\` declares that it answers "${o.canonicalMatch.canonical}", which is this question with its values filled in: ${JSON.stringify(o.canonicalMatch.params)}.
Start here: run it with those values (\`tsx run.mjs ${o.canonicalMatch.programDir}/program.ts '${JSON.stringify(o.canonicalMatch.params)}'\`) and read the output as the person who asked would. If it answers them, COMMIT as your final action: write ${builtRel} = {"programDir":"${o.canonicalMatch.programDir}","params":${JSON.stringify(o.canonicalMatch.params)}} and stop. If it does not, carry on below.
` : ''}
1. Can a program above answer THIS question EXACTLY — the SAME measure, scope and grain, differing at most by a
   parameter (a date, a top-N)? Only then reuse it: pick it, run it, and COMMIT — write ${builtRel} = {"programDir":"<that program>","params":{…}} as your final action.
   A program built for a RELATED-but-different question is NOT a fit — "amount billed" is not "net spend", a header
   total is not a line-level breakdown, gross is not net. Do NOT adapt or force-fit a program; when it is not an
   EXACT match, go to step 2 and build from the CONCEPTS — never from a not-quite program. Accuracy over reuse.
2. Otherwise COMPOSE from the concepts (\`./find-concept "<phrase>"\` for names, \`./get-concept "<name>"\` for one concept's runnable query). If they
   don't fully cover it, do the work yourself — \`./query\`/\`./introspect\` the data, analyse, write the units +
   program. Run it (\`tsx run.mjs programs/<slug>/program.ts '<json>'\`), verify against the review checks, write
   Then COMMIT, as your final action: write ${builtRel} = {"programDir":"programs/<slug>","params":{…},"canonicalQuestions":["…"]}.
   The engine runs the program the moment that file appears, so write it once everything else is finished and verified. \`canonicalQuestions\` — the question this program answers, phrased so its parameters are
   visible ("… for customer <customer> in <period>"); add another only when it genuinely answers a differently-
   phrased question.
3. Escalate to the analyst when it's a hard problem or you can't figure it out. Write ${escalateRel} =
   {"reason":"<what's blocking you>"} and STOP. Many composers share one analyst, so do the rest yourself.`
      const prompt = m ? modifyPrompt : composePrompt

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
          const rr = await execProgram(cwd, built.programDir, built.params ?? {})
          const out = rr.output as any
          answer = { ...out, status: out?.status ?? 'answered' }
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
