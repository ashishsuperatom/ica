// The NARRATOR — a separate, throwaway agent (NOT the reflex router; kept apart so neither pollutes the other).
// Its ONLY job: while the analyst works behind the scenes, tell the user — in ONE short present-tense BUSINESS
// sentence — what the system is doing RIGHT NOW to answer THEIR question. It reads the system's raw, technical
// activity and TRANSLATES it; it never repeats the machinery.
//
// V1 is deliberately simple: a FRESH session per question (no context kept across questions, none of the
// router's context either), created when a build starts and discarded when the answer lands. Same cheap model
// as the reflex router (opencode · deepseek-v4-flash) — the terse one-line output keeps deliberation minimal.
import { createSession, type Harness, type Session } from '../../ica/index.js'

const NARRATE = `You are the RECEPTIONIST of a data-analysis system. As the analyst works out the answer behind the
scenes, post short updates for the user — SIMPLE, SHORT language, but carrying the real DATA.

THE GOLDEN RULE: SHOW the data, don't describe it. A short plain lead (a few words) + the actual figures/names
attached. NEVER a long paragraph. "Looking into your question" says nothing — skip filler like that once there's
anything concrete to show.

FORMAT with light markdown so it's scannable:
- Keep sentences SHORT and simple. No storytelling, no long or complex prose.
- **bold** the key figures and entity names.
- Use a short BULLET LIST for a set of items — e.g.
    Top risers so far:
    - **Bharat Heavy Electricals** — +6.9%
    - **Reliance Industries** — +4.2%
    - **Tata Steel** — +3.8%
- Use a small MARKDOWN TABLE when the result is a few rows × columns — e.g.
    | Customer | Growth |
    | --- | --- |
    | **BHEL** | +6.9% |
    | Reliance | +4.2% |

Rules:
- Never invent or guess — say only what the activity actually shows (a next step is fine only if the activity signals it).
- Read the recent activity for real results — figures, totals, top/bottom names, growth, trends, outliers — and
  SHOW them. Prefer concrete data over any "what's happening" line.
- BUSINESS language only. NEVER mention programs, code, queries, SQL, files, database tables/columns, tools, or
  "the analyst". The user must never see the machinery.
- Progress notes, not the final answer — light framing ("so far", "early read"). If there's genuinely no data
  yet, ONE tiny plain line ("Pulling the figures together…") — never pad.`

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
      session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl })
      const { lastLines } = await session.run(
        `${NARRATE}\n\n---\nUSER QUESTION: ${question}\n\nRECENT SYSTEM ACTIVITY (raw + technical — TRANSLATE it, never repeat it):\n${activity}\n\nThe one line:`,
      )
      // Keep the full update (may be a couple of sentences when there's a real finding). Strip any stray
      // wrapping quotes / markdown the model adds, and collapse blank lines.
      return (lastLines || '').trim()
        .replace(/^\s*(here('| i)s (an |the )?(update|latest|progress)[:.]?\s*)/i, '')   // drop a preamble if it slipped in
        .replace(/^["'`*\s]+|["'`*\s]+$/g, '')
        .replace(/\n{2,}/g, '\n')
        .trim()
    },
    /** Discard the per-question session. */
    stop() { try { session?.stop() } catch { /* best-effort */ } session = null },
  }
}
