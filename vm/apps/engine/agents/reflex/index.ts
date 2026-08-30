// ── Reflex Agent ──────────────────────────────────────────────────────────────
// The cheap TEXT tier in front of the expensive tool tier. It has no tools and answers nothing itself; it does
// the two jobs that are pure judgment on text, at the two edges of the fast path:
//   • canonicalize(question) → the question's canonical form + its parameters, so retrieval can match
//     question-to-question (both sides in the same shape) instead of question-to-program.
//   • review(question, answer) → did a reused program's answer actually answer the question?
// It never decides WHAT to build, never picks concepts, never places nodes — those belong to the engine and the
// composer. A no-tools completion costs ~1s where booting a tool session costs ~40s, which is the whole reason
// this tier exists: decide before paying for tools, and fall through to the composer whenever it can't.
//
// Harness/model default to opencode + deepseek-v4-flash (the 2026-07-31 snapshot on the opencode-go gateway),
// overridable per-agent from .env (ICA_REFLEX_HARNESS / ICA_REFLEX_MODEL / ICA_REFLEX_PROVIDER) with NO code change.

import './generate-system.js'   // FIRST: (re)writes ./SYSTEM.md + ./REVIEW.md from generate-system.ts before they're read below
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, type Harness, type Session } from '../../ica/index.js'
import { loadPrompt } from '../../prompts.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The reflex prompt, via the override layer (volume override for the current image → baked fallback).
const canonicalPrompt = () => loadPrompt(join(__dirname, 'CANONICAL.md'), 'reflex/CANONICAL.md')
// The reflex's REVIEW instruction (a second, distinct job: judge a reused program's answer).
const reviewPrompt = () => loadPrompt(join(__dirname, 'REVIEW.md'), 'reflex/REVIEW.md')

// Reflex never uses tools or writes files. This minimal system prompt REPLACES
// opencode's default coding agent prompt (the per-message SYSTEM.md/REVIEW.md carry the real task), and paired
// with noTools it strips the whole toolset — no schemas, no tool calls, far fewer tokens.
const REFLEX_SYS = 'You are a fast classifier. Follow the instructions in each message exactly and reply with ONLY what they ask for — strict JSON when requested, no prose, no code fences. You have NO tools: never read or write files, never run commands.'

/** Deterministic hash of the EFFECTIVE instructions — a prompt (or override) change → fresh session. */
export async function promptVersion(): Promise<string> {
  return createHash('sha1').update(canonicalPrompt() + reviewPrompt()).digest('hex').slice(0, 12)
}

/** The reflex's verdict on a reused program's answer. */
export type ReviewVerdict = { verdict: 'accept' | 'escalate'; reason?: string }

// A COMPACT view of an answer for review — enough to judge if it answers the question, not the whole blob.
// The WHOLE answer, with only BULK trimmed — never a hand-picked set of fields. Picking fields means the digest
// encodes the answer's shape, so anything in a shape it doesn't know about silently disappears: reading `a.table`
// while programs emitted `a.sections[{kind:'table'}]` showed the reviewer an answer with no list in it, and it
// duly rejected a correct one. This walks whatever is there, keeps every key, and shortens only long arrays and
// long strings — so a new field is summarised, not lost.
const KEEP_ITEMS = 3, MAX_STR = 400, MAX_CHARS = 6000
function trim(v: any, depth = 0): any {
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + `… (${v.length} chars)` : v
  if (Array.isArray(v)) {
    const head = v.slice(0, KEEP_ITEMS).map(x => trim(x, depth + 1))
    return v.length > KEEP_ITEMS ? [...head, `… ${v.length - KEEP_ITEMS} more of ${v.length}`] : head
  }
  if (v && typeof v === 'object' && depth < 6) {
    const o: any = {}
    for (const [k, val] of Object.entries(v)) o[k] = trim(val, depth + 1)
    return o
  }
  return v
}
function answerDigest(a: any): string {
  if (!a || typeof a !== 'object') return String(a)
  const s = JSON.stringify(trim(a))
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + '…' : s
}

/** A question normalised for matching: the canonical sentence, the values pulled out of it, and whatever the
 *  conversation could not resolve (present ⇒ do NOT reuse on this; it isn't self-contained yet). */
export type Canonical = { canonical: string; params: Record<string, unknown>; unresolved?: string }

export interface ReflexOpts {
  cwd: string
  ica?: { harness?: Harness; model?: string; provider?: string; baseUrl?: string }
}

// Pull the first balanced {...} JSON object out of a model response (tolerates stray prose/fences).
function extractJson(s: string): any {
  const start = s.indexOf('{')
  if (start < 0) throw new Error('no JSON object in reflex output')
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { if (--depth === 0) return JSON.parse(s.slice(start, i + 1)) }
  }
  throw new Error('unbalanced JSON object in reflex output')
}

export function createReflex(opts: ReflexOpts) {
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_REFLEX_HARNESS as Harness) ?? 'opencode'
  const model = opts.ica?.model ?? process.env.ICA_REFLEX_MODEL ?? 'deepseek-v4-flash'
  const provider = opts.ica?.provider ?? process.env.ICA_REFLEX_PROVIDER ?? 'opencode-go'
  let session: Session | null = null

  /**
   * Question (+ the recent conversation, when there is one) → its CANONICAL form and the values in it. Both the
   * stored question and the asked one go through this, so retrieval compares like with like. Binding falls out of
   * the same call — the parameters are exactly what canonicalisation had to pull out — so this costs one
   * completion, not two.
   */
  async function canonicalize(question: string, context?: string): Promise<Canonical> {
    const system = canonicalPrompt()
    session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl, noTools: true, system: REFLEX_SYS })
    const ctx = context?.trim() ? `RECENT CONVERSATION:\n${context.trim()}\n\n` : ''
    const { lastLines } = await session.run(`${system}\n\n---\n${ctx}QUESTION: ${question}\n\nJSON:`)
    const parsed = extractJson(lastLines)
    return {
      canonical: typeof parsed?.canonical === 'string' ? parsed.canonical.trim() : question,
      params: (parsed?.params && typeof parsed.params === 'object') ? parsed.params : {},
      unresolved: typeof parsed?.unresolved === 'string' && parsed.unresolved.trim() ? parsed.unresolved.trim() : undefined,
    }
  }

  /**
   * Look at a reused program's ANSWER and decide whether it genuinely answers the question, or should be
   * handed to the analyst. This is the missing feedback edge: a reused program can run cleanly and still not
   * answer (stale interpretation, a name that now resolves to two things, an empty result). The reflex owns
   * whether the answer is real. One turn on the reused session; fail-open handled by the caller (a review error must not
   * take down the fast path).
   */
  async function review(question: string, answer: any): Promise<ReviewVerdict> {
    const system = reviewPrompt()
    session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl, noTools: true, system: REFLEX_SYS })
    const { lastLines } = await session.run(`${system}\n\n---\nQUESTION: ${question}\n\nANSWER (digest): ${answerDigest(answer)}\n\nJSON:`)
    const parsed = extractJson(lastLines)
    const verdict = parsed?.verdict === 'escalate' ? 'escalate' : 'accept'
    return { verdict, reason: typeof parsed?.reason === 'string' ? parsed.reason : undefined }
  }

  return {
    canonicalize,
    review,
    /** Pre-create the session (connect to the warm opencode server) so the first call has no cold start. */
    async warmup() { session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl, noTools: true, system: REFLEX_SYS }); await session.warmup?.() },
    stop() { session?.stop() },
  }
}
