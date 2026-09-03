// The NARRATOR — a separate, throwaway agent (NOT the reflex router; kept apart so neither pollutes the other).
// Its ONLY job: while the analyst works behind the scenes, tell the user — in ONE short present-tense BUSINESS
// sentence — what the system is doing RIGHT NOW to answer THEIR question. It reads the system's raw, technical
// activity and TRANSLATES it; it never repeats the machinery.
//
// A FRESH narrator per question, created when the work starts and discarded when the answer lands — nothing is
// carried between questions, because narrating this question has nothing to learn from the last one. Within a
// question there are two ways of carrying context and BOTH are live; see the strategies below. Cheap model
// (deepseek-v4-flash) — the terse one-line output keeps deliberation minimal.
import { createSession, type Harness, type Session } from '../../ica/index.js'
import { agentProse, hasToolMarkup } from '../../ica/prose.js'

const NARRATE = `You narrate a data analysis AS IT HAPPENS, for the person who asked. A short, live, plain-English
update on what is happening right now — so they follow along and never feel like they are just waiting.

SAY WHAT WAS FOUND, NOT THAT WORK IS HAPPENING
- Lead with the SUBSTANCE in front of you — the figure, the count, the name, the period. "31,560 jobs, 214 of
  them billed this quarter" tells them something; "analysing the data" tells them nothing they didn't know.
- If this tick's activity contains no finding yet, say the concrete thing being looked at in a few words and
  stop. Do not pad it into a sentence that sounds like progress.
- Each update moves FORWARD from the last. When the calculation is done, say so plainly and let the answer follow.

PLAIN, PROFESSIONAL LANGUAGE
- Write as you would to a client in a business update: simple, common words, said professionally.
- Name things with the words the question and the data already use.
- Never mention programs, code, queries, SQL, files, tables/columns, tools, or "the analyst". Output ONLY the
  update sentence(s) — no tool call, command, code, XML, or file path (you have no tools).
- Very short: one or two sentences; **bold** a key figure or name. A short bullet list only for a set of items.

FAILURES: ONE IS NOISE, MANY ARE NEWS
- A single failed step that is retried immediately is normal and not worth a word. Skip it and carry on.
- But when the SAME thing keeps failing across the activity you are shown, say so once, plainly and without
  alarm ("The revenue figures still aren't coming back — trying another way"). Silence while something is stuck
  reads as the system having died, which is worse than the setback itself.

SAY WHAT IS HAPPENING — NEVER THAT IT IS RIGHT
- Report only what the activity actually shows: never invent a number, and never claim a check that is not in
  front of you. You cannot see one. Words like verified, confirmed, reconciled, validated, cross-checked,
  "matches the proven figures", "ties out" and "all correct" assert that something was tested — and a reader
  acts on a number differently when told it was. Say what is being done ("totalling revenue by month"), not
  that it came out right.
- Nothing has been "built before" or "already proven" unless the activity says so in those terms. A list of
  candidate programs is not a proven answer.
- Progress notes, not the final answer.`

// Cap the data we feed the narrator. Query results can be huge (long lists/tables, possibly NESTED — the array
// may not be at the top). The narrator only needs a SAMPLE to summarise, so keep the first N items of every
// array (recursively), or the first few lines of a plain-text dump. Big input → smaller + cheaper, same shape.
export function capResultData(s: string, n = 8): string {
  const t = (s ?? '').trim()
  if (!t) return t
  const trim = (v: any): any =>
    Array.isArray(v) ? [...v.slice(0, n).map(trim), ...(v.length > n ? [`…(+${v.length - n} more)`] : [])]
    : (v && typeof v === 'object') ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)]))
    : v
  if (t[0] === '{' || t[0] === '[') { try { return JSON.stringify(trim(JSON.parse(t))) } catch { /* not clean JSON — fall through */ } }
  const lines = t.split('\n')
  return lines.length > n + 2 ? lines.slice(0, n + 1).join('\n') + `\n…(+${lines.length - n - 1} more lines)` : t
}

// Markers of MACHINERY — code, diffs, file paths, program-source keys. A narration beat is business prose; if any
// of these appear the model has echoed its input instead of translating, so the beat is dropped rather than shown.
// (This is the safety net that keeps raw agent internals — like a program diff — from ever reaching the user.)
const MACHINERY = [
  /programs?\//i, /\.(ts|tsx|js|mjs|json|sql|py)\b/i,        // paths / filenames
  /^\s*[+-]\s|\n\s*[+-]\s/, /^\s*\d+\s*[-+]\s/m,             // diff hunks
  /\b(dataSources?|inputs|logic|source|params|units?)\s*:/i, // program-source keys (name:, source:, dataSources:)
  // CODE — but only shapes that cannot be ordinary prose. `return` was in this list, and it is an everyday
  // word in project finance ("returns", "return on budget"), so real beats were deleted as source code.
  /=>|\bfunction\s+\w+\s*\(|\bconst\s+\w+\s*=|\bawait\s+\w+\(/,
  /❯|●|⏺|Combobulating|Ran \d+ shell/i,                      // TUI chrome / spinner
  /```|<\/?\w+>/,                                            // fenced code / xml
]
// Strip fenced code blocks and drop lines that are mostly code, so the narrator only ever SEES findings — never
// program source. Returns '' when nothing business-meaningful survives.
// The narrator's view of an agent's output is the same view every reader needs, so it is not defined here.
// See ica/prose.ts — one rule, so switching harness cannot change what a reader gets.
export const stripCode = agentProse
// A finished narration beat must READ like a business update. Reject anything that smells of machinery or is too
// long to be one (an echo of the raw activity). A dropped beat is invisible; a leaked one is the bug — so when in
// doubt, drop.
/** Why a beat was rejected, or '' if it is fine. Named so a drop can be REPORTED rather than just happening —
 *  a filter that silently deletes its input is indistinguishable from an agent that produced nothing, and that
 *  cost a full day of looking in the wrong place. */
export function beatRejection(s: string): string {
  const t = (s ?? '').trim()
  if (!t) return 'empty'
  if (t.length > 700) return `too long (${t.length} chars)`   // 320 dropped every closing summary; the machinery check is the real guard
  const hit = MACHINERY.find((re) => re.test(t))
  return hit ? `matched ${hit}` : ''
}

export function isCleanBeat(s: string): boolean { return !beatRejection(s) }

export interface NarratorOpts {
  cwd: string
  ica?: { harness?: Harness; model?: string; provider?: string; baseUrl?: string }
  /** Which context strategy to run. Omitted ⇒ ICA_NARRATOR_CONTEXT, else 'stateless'. */
  context?: NarratorContext
}

// ── THE TWO WAYS OF CARRYING CONTEXT, SIDE BY SIDE ─────────────────────────────────────────────────────────
// Both are live. This is an A/B we intend to keep running for a while, so neither is "the old one": each is
// meant to be improved on its own terms until we can see which reads better, and switching is a variable, not
// a revert. Only the CONTEXT differs — the system prompt is shared, so a comparison is about the thing being
// compared and not about who got the better instructions.
//
//   stateful   the session keeps every beat, so the model sees the whole turn as one conversation. Continuity
//              is free and the cached prefix keeps growing with it. The cost is that a long turn accumulates
//              hundreds of stale RESULT blocks that cannot help write the next line.
//   stateless  each beat is a single shot: the session is reset and the last few beats are passed back in as
//              "already said". Context stays small and constant, the system prompt stays the cached prefix.
//              The bet is that a narrator needs the last few lines, not the whole history.
export type NarratorContext = 'stateful' | 'stateless'

interface ContextStrategy {
  /** Called before each run. May abandon the session so the next run starts clean. */
  prepare(session: Session): void
  /** The per-beat user message. */
  prompt(question: string, activity: string, recent: string[]): string
}

const ACTIVITY = (activity: string) =>
  `\n\nRECENT SYSTEM ACTIVITY (raw + technical — TRANSLATE it, never repeat it):\n${activity}\n\nThe one line:`

const STRATEGIES: Record<NarratorContext, ContextStrategy> = {
  stateful: {
    prepare() { /* keep the session — the history IS the continuity */ },
    prompt: (question, activity) => `USER QUESTION: ${question}${ACTIVITY(activity)}`,
  },
  stateless: {
    prepare(session) { session.reset?.() },
    prompt: (question, activity, recent) => {
      const said = recent.length
        ? `\n\nALREADY SAID — carry on from these, do not repeat them:\n${recent.map(s => `- ${s}`).join('\n')}`
        : ''
      return `USER QUESTION: ${question}${said}${ACTIVITY(activity)}`
    },
  },
}

/** What a narrator is, stated rather than inferred. Left to inference, a caller holding one as
 *  `ReturnType<typeof createNarrator> | null` had it narrowed to `never` — an explicit type costs a line and
 *  removes a whole class of confusion at the call site. */
export interface Narrator {
  context: NarratorContext
  narrate(question: string, activity: string, recent?: string[]): Promise<string>
  stop(): void
}

export function createNarrator(opts: NarratorOpts): Narrator {
  // Named for THIS agent. These read ICA_REFLEX_* until now — the reflex was deleted, so the narrator was being
  // configured through a variable named after an agent that no longer exists. ICA_REFLEX_* is still honoured so
  // an existing deployment does not silently change model on the next restart.
  // pi against the opencode-go subscription: the same cheap model as before, one fewer harness running.
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_NARRATOR_HARNESS ?? process.env.ICA_REFLEX_HARNESS) as Harness ?? 'pi'
  const model = opts.ica?.model ?? process.env.ICA_NARRATOR_MODEL ?? process.env.ICA_REFLEX_MODEL ?? 'deepseek-v4-flash'
  const provider = opts.ica?.provider ?? process.env.ICA_NARRATOR_PROVIDER ?? process.env.ICA_REFLEX_PROVIDER ?? 'opencode-go'
  // Which context strategy this narrator runs. Default stateless; ICA_NARRATOR_CONTEXT=stateful switches it,
  // and opts wins over both so a caller can run the two against each other in one process.
  const context: NarratorContext =
    opts.context ?? (process.env.ICA_NARRATOR_CONTEXT === 'stateful' ? 'stateful' : 'stateless')
  const strategy = STRATEGIES[context]
  let session: Session | null = null
  return {
    /** Which strategy produced these beats — logged with each one, so an A/B is readable after the fact. */
    context,
    /** Translate a batch of raw system activity into ONE business-language line for the user. Best-effort.
     *  `recent` = the last few beats already shown (used by the stateless strategy). */
    async narrate(question: string, activity: string, recent: string[] = []): Promise<string> {
      // noTools + system=NARRATE → a PURE text completion: no coding-agent scaffolding, no tool schemas, no tool
      // calls. The instructions live in the (well-cached) system prompt; only the per-turn activity travels here.
      session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl, noTools: true, system: NARRATE })
      strategy.prepare(session)
      const { lastLines } = await session.run(strategy.prompt(question, activity, recent))
      // Keep the full update (may be a couple of sentences when there's a real finding). Strip any stray
      // wrapping quotes / markdown the model adds, and collapse blank lines.
      // The narrator's OWN output, through the same filter. A model with no tools still writes tool-call syntax
      // when it has just read some, and that is exactly how every beat of a turn came to be discarded.
      const raw = (lastLines || '').trim()
      if (hasToolMarkup(raw)) console.log('[beat] stripped tool-call markup from the narrator\'s own output')
      const beat = agentProse(raw)
        .replace(/^\s*(here('| i)s (an |the )?(update|latest|progress)[:.]?\s*)/i, '')   // drop a preamble if it slipped in
        .replace(/^["'`*\s]+|["'`*\s]+$/g, '')
        .replace(/\n{2,}/g, '\n')
        .trim()
      // GUARD: a small model sometimes echoes its raw input instead of translating it (that is how program source
      // and diffs once leaked to the user). A narration beat is best-effort, so if it doesn't read like a clean
      // business update, drop it silently — the next tick will produce a good one. Better a missing beat than a leak.
      const why = beatRejection(beat)
      if (why) { console.log(`[beat:dropped] ${why} — "${beat.replace(/\s+/g, ' ').slice(0, 160)}"`); return '' }
      return beat
    },
    /** Discard the per-question session. */
    stop() { try { session?.stop() } catch { /* best-effort */ } session = null },
  }
}
