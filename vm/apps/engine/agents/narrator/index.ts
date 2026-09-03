// The NARRATOR — a separate, throwaway agent (NOT the reflex router; kept apart so neither pollutes the other).
// Its ONLY job: while the analyst works behind the scenes, tell the user — in ONE short present-tense BUSINESS
// sentence — what the system is doing RIGHT NOW to answer THEIR question. It reads the system's raw, technical
// activity and TRANSLATES it; it never repeats the machinery.
//
// V1 is deliberately simple: a FRESH session per question (no context kept across questions, none of the
// router's context either), created when a build starts and discarded when the answer lands. Same cheap model
// as the reflex router (opencode · deepseek-v4-flash) — the terse one-line output keeps deliberation minimal.
import { createSession, type Harness, type Session } from '../../ica/index.js'
import { agentProse, hasToolMarkup } from '../../ica/prose.js'

const NARRATE = `You narrate a data analysis AS IT HAPPENS, for the person who asked. A short, live, plain-English
update on what is happening right now — so they follow along and never feel like they are just waiting.

TELL A STORY OF PROGRESS
- Each update is a step FORWARD: what we're looking at, then what we've FOUND. It should feel like momentum, not
  a status log. ("Pulling the sales records now." → "Found the regions — totalling each one." → "The totals are
  in — putting them together now.")
- When the calculation is done, say so plainly and let the answer follow. Keep the person leaning in and
  interested, not watching a clock.

PLAIN, PROFESSIONAL LANGUAGE
- Write as you would to a client in a business update: simple, common words, said professionally.
- Name things with the words the question and the data already use.
- Never mention programs, code, queries, SQL, files, tables/columns, tools, or "the analyst". Output ONLY the
  update sentence(s) — no tool call, command, code, XML, or file path (you have no tools).
- Very short: one or two sentences; **bold** a key figure or name. A short bullet list only for a set of items.

DON'T DWELL ON ERRORS
- The work is made of many small steps; some fail and are retried immediately — that is normal and NOT news. Do
  NOT report a failed step, a retry, or "an error"; the next step fixes it. Just keep telling the progress story.
- Only if the work is genuinely stuck with no way forward, say so simply ("This one is taking a little longer").

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
  /\[\[ui\]\]|❯|●|⏺|Combobulating|Ran \d+ shell/i,          // TUI chrome / spinner
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
}

export function createNarrator(opts: NarratorOpts) {
  // Named for THIS agent. These read ICA_REFLEX_* until now — the reflex was deleted, so the narrator was being
  // configured through a variable named after an agent that no longer exists. ICA_REFLEX_* is still honoured so
  // an existing deployment does not silently change model on the next restart.
  // pi against the opencode-go subscription: the same cheap model as before, one fewer harness running.
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_NARRATOR_HARNESS ?? process.env.ICA_REFLEX_HARNESS) as Harness ?? 'pi'
  const model = opts.ica?.model ?? process.env.ICA_NARRATOR_MODEL ?? process.env.ICA_REFLEX_MODEL ?? 'deepseek-v4-flash'
  const provider = opts.ica?.provider ?? process.env.ICA_NARRATOR_PROVIDER ?? process.env.ICA_REFLEX_PROVIDER ?? 'opencode-go'
  let session: Session | null = null
  return {
    /** Translate a batch of raw system activity into ONE business-language line for the user. Best-effort. */
    async narrate(question: string, activity: string): Promise<string> {
      // noTools + system=NARRATE → a PURE text completion: no coding-agent scaffolding, no tool schemas, no tool
      // calls. The instructions live in the (well-cached) system prompt; only the per-turn activity travels here.
      session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl, noTools: true, system: NARRATE })
      const { lastLines } = await session.run(
        `USER QUESTION: ${question}\n\nRECENT SYSTEM ACTIVITY (raw + technical — TRANSLATE it, never repeat it):\n${activity}\n\nThe one line:`,
      )
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
