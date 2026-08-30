// The NARRATOR — a separate, throwaway agent (NOT the reflex router; kept apart so neither pollutes the other).
// Its ONLY job: while the analyst works behind the scenes, tell the user — in ONE short present-tense BUSINESS
// sentence — what the system is doing RIGHT NOW to answer THEIR question. It reads the system's raw, technical
// activity and TRANSLATES it; it never repeats the machinery.
//
// V1 is deliberately simple: a FRESH session per question (no context kept across questions, none of the
// router's context either), created when a build starts and discarded when the answer lands. Same cheap model
// as the reflex router (opencode · deepseek-v4-flash) — the terse one-line output keeps deliberation minimal.
import { createSession, type Harness, type Session } from '../../ica/index.js'

const NARRATE = `You narrate a data analysis AS IT HAPPENS, for the person who asked. A short, live, plain-English
update on what is happening right now — so they follow along and never feel like they are just waiting.

TELL A STORY OF PROGRESS
- Each update is a step FORWARD: what we're looking at, then what we've FOUND. It should feel like momentum, not
  a status log. ("Pulling the sales records now." → "Found the regions — totalling each one." → "Numbers are in,
  just double-checking them before we show you.")
- When the calculation is done, say we've worked it out and are confirming it once more — then the final answer
  follows. Keep the person leaning in and interested, not watching a clock.

PLAIN, PROFESSIONAL LANGUAGE
- Write as you would to a client in a business update: simple, common words, said professionally. If a word is
  unusual, fancy, or clever, do NOT use it. No slang, no cute or quirky terms (never "snag", "hiccup", "under the
  hood", "hunting for quiet customers"), no jargon. Name things the way the business does — "customers with no
  orders in the last six months", not a colourful phrase for them.
- Never mention programs, code, queries, SQL, files, tables/columns, tools, or "the analyst". Output ONLY the
  update sentence(s) — no tool call, command, code, XML, or file path (you have no tools).
- Very short: one or two sentences; **bold** a key figure or name. A short bullet list only for a set of items.

DON'T DWELL ON ERRORS
- The work is made of many small steps; some fail and are retried immediately — that is normal and NOT news. Do
  NOT report a failed step, a retry, or "an error"; the next step fixes it. Just keep telling the progress story.
- Only if the work is genuinely stuck with no way forward, say so simply ("This one is taking a little longer").

- Report only what the activity actually shows — never invent a number. Progress notes, not the final answer.`

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
  /=>|\bfunction\b|\bconst\b|\breturn\b|\bawait\b/,          // code
  /\[\[ui\]\]|❯|●|⏺|Combobulating|Ran \d+ shell/i,          // TUI chrome / spinner
  /```|<\/?\w+>/,                                            // fenced code / xml
]
// Strip fenced code blocks and drop lines that are mostly code, so the narrator only ever SEES findings — never
// program source. Returns '' when nothing business-meaningful survives.
export function stripCode(s: string): string {
  return (s ?? '')
    .replace(/```[\s\S]*?```/g, ' ')                         // fenced blocks
    .replace(/`[^`]*`/g, ' ')                                // inline code
    .split('\n')
    .filter((l) => { const t = l.trim(); return t && !/programs?\/|=>|[{};]\s*$|^\s*[+-]\s|\.(ts|tsx|js|mjs)\b/.test(t) })
    .join('\n')
    .replace(/\s{2,}/g, ' ')
    .trim()
}
// A finished narration beat must READ like a business update. Reject anything that smells of machinery or is too
// long to be one (an echo of the raw activity). A dropped beat is invisible; a leaked one is the bug — so when in
// doubt, drop.
export function isCleanBeat(s: string): boolean {
  const t = (s ?? '').trim()
  if (!t) return false
  if (t.length > 320) return false                           // a real beat is a sentence or a few bullets, never a dump
  return !MACHINERY.some((re) => re.test(t))
}

export interface NarratorOpts {
  cwd: string
  ica?: { harness?: Harness; model?: string; provider?: string; baseUrl?: string }
}

export function createNarrator(opts: NarratorOpts) {
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_REFLEX_HARNESS as Harness) ?? 'opencode'
  const model = opts.ica?.model ?? process.env.ICA_NARRATOR_MODEL ?? process.env.ICA_REFLEX_MODEL ?? 'deepseek-v4-flash'
  const provider = opts.ica?.provider ?? process.env.ICA_REFLEX_PROVIDER ?? 'opencode-go'
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
      const beat = (lastLines || '').trim()
        .replace(/^\s*(here('| i)s (an |the )?(update|latest|progress)[:.]?\s*)/i, '')   // drop a preamble if it slipped in
        .replace(/^["'`*\s]+|["'`*\s]+$/g, '')
        .replace(/\n{2,}/g, '\n')
        .trim()
      // GUARD: a small model sometimes echoes its raw input instead of translating it (that is how program source
      // and diffs once leaked to the user). A narration beat is best-effort, so if it doesn't read like a clean
      // business update, drop it silently — the next tick will produce a good one. Better a missing beat than a leak.
      return isCleanBeat(beat) ? beat : ''
    },
    /** Discard the per-question session. */
    stop() { try { session?.stop() } catch { /* best-effort */ } session = null },
  }
}
