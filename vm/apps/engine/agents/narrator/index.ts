// The NARRATOR — a separate, throwaway agent (NOT the reflex router; kept apart so neither pollutes the other).
// Its ONLY job: while the analyst works behind the scenes, tell the user — in ONE short present-tense BUSINESS
// sentence — what the system is doing RIGHT NOW to answer THEIR question. It reads the system's raw, technical
// activity and TRANSLATES it; it never repeats the machinery.
//
// V1 is deliberately simple: a FRESH session per question (no context kept across questions, none of the
// router's context either), created when a build starts and discarded when the answer lands. Same cheap model
// as the reflex router (opencode · deepseek-v4-flash) — the terse one-line output keeps deliberation minimal.
import { createSession, type Harness, type Session } from '../../ica/index.js'

const NARRATE = `You are the RECEPTIONIST of a data-analysis system. While the analyst works out the answer behind
the scenes, post short live updates in plain BUSINESS language.

- VERY SHORT — at most one or two sentences, or up to ~4 bullet points. Never a big paragraph.
- Lead with what's been FOUND when the activity shows real figures or names; otherwise briefly say what's
  happening. Concrete data beats a vague line.
- Simple markdown only: **bold** for key figures/names, and a short bullet list for a set of items.
- BUSINESS language only — never mention programs, code, queries, SQL, files, tables/columns, tools, or "the
  analyst". Output ONLY the update text — never a tool call, command, code, XML, or file path (you have no tools).
- PLAIN, CLEAR, everyday words. NO slang or cute/quirky terms ("snag", "hiccup", "under the hood", "tooling") and
  no drama. If a step failed or is retrying, say it plainly ("still loading the data, one moment") or just say
  what's happening now — a reader must never have to wonder what a word means.
- Report only what the activity actually shows — never invent or guess. Progress notes ("so far"), not the final answer.`

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
      // noTools + system=NARRATE → a PURE text completion: no coding-agent scaffolding, no tool schemas, no tool
      // calls. The instructions live in the (well-cached) system prompt; only the per-turn activity travels here.
      session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl, noTools: true, system: NARRATE })
      const { lastLines } = await session.run(
        `USER QUESTION: ${question}\n\nRECENT SYSTEM ACTIVITY (raw + technical — TRANSLATE it, never repeat it):\n${activity}\n\nThe one line:`,
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
