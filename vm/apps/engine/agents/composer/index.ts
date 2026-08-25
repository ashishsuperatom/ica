// The COMPOSER (System 2) — answers by COMPOSING pre-evaluated concepts into a program. It does NO discovery.
// It SHARES the analyst's workspace and the SHARED program-authoring mechanics, so a composer-written program is
// identical in shape to an analyst-written one; it differs only in the brain (a cheap opencode model) and its
// instruction (compose from concepts via ./concepts/find.mjs; on any gap, ESCALATE to the analyst rather than
// guess). The engine runs the program it points at and stamps authoredBy.by='composer'.
import './generate-system.js'   // FIRST: (re)writes SYSTEM.md from generate-system.ts before it's read below
import { readFile, writeFile, mkdir } from 'node:fs/promises'
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
export interface BuiltPtr { programDir: string; params?: any; terms?: any[]; followups?: string[] }
export interface ComposerResult {
  escalate?: { reason: string }        // set when concepts didn't cover it → engine hands off to the analyst
  answer?: any                         // the engine-run program output (when composed)
  built?: BuiltPtr                     // the program pointer (so the engine persists + stamps provenance)
  category?: string
  lastLines?: string
  ms: number
}
export interface ProgramCandidate { question: string; program?: string; score: number }
export interface Composer {
  ask(question: string, handlers?: RunHandlers, opts?: { qid?: string; candidates?: ProgramCandidate[] }): Promise<ComposerResult>
  session: Session
  cwd: string
}

export async function createComposer(opts: ComposerOpts): Promise<Composer> {
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_COMPOSER_HARNESS as Harness) ?? 'opencode'
  const model = opts.ica?.model ?? process.env.ICA_COMPOSER_MODEL ?? 'deepseek-v4-flash'
  const provider = opts.ica?.provider ?? process.env.ICA_COMPOSER_PROVIDER ?? 'opencode-go'
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl })
  const session = createSession(harness, { cwd, model, provider, baseUrl: opts.ica?.baseUrl })

  const preamble =
    'Read ./CONTEXT.md FIRST (environment: `node` for quick checks, `tsx` for programs; and the seams), then ' +
    './composer/COMPOSER.md (your instructions) — follow it exactly. Concepts are in ./concepts/find.mjs; you ' +
    'write a PROGRAM the engine runs. You do NOT explore raw data — you compose concepts, or you escalate.'

  return {
    cwd,
    session,
    async ask(question, handlers, o = {}) {
      const t0 = Date.now()
      await writeFile(join(cwd, 'composer/COMPOSER.md'), fullSystem())
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
      const prompt = `${preamble}

Question: ${question}

${candBlock}

1. Can any program above CORRECTLY answer this question — as-is or with different params? If one genuinely fits,
   pick it, run it to confirm, and write ${builtRel} = {"programDir":"<that program>","params":{…}}. If none
   truly answers it, do NOT force-fit one — build a new program from concepts (step 2). Accuracy over reuse.
2. Otherwise COMPOSE. \`findConcept('<phrase>')\` from ./concepts/find.mjs for the concepts this needs — each gives
   the data, runnable PRQL, representation, and review checks. REWRITE/ADAPT their PRQL into ONE program: adding a
   grouping/dimension, changing the window, or adding a filter over fields ALREADY in a concept's data is
   composing, not discovering. Run it (\`tsx run.mjs programs/<slug>/program.ts '<json>'\`), verify against the
   review checks, write ${builtRel}. The engine runs it — do NOT write answer.json or answer in chat.
3. Only if the underlying data/approach is in NO concept (you'd have to discover it, or two concepts contradict)
   → write ${escalateRel} = {"reason":"<what's missing>"} and STOP. Escalating is success; the analyst builds it.
   Never explore raw data or guess.`

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
          handlers?.onNarration?.(`Running program ${built.programDir}`)
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

// Deterministic hash of the instruction (role prompt + shared program-authoring) — the slot resumes a warm
// session only while this is unchanged, else starts fresh.
export async function promptVersion(): Promise<string> {
  return createHash('sha256').update(fullSystem()).digest('hex').slice(0, 12)
}
