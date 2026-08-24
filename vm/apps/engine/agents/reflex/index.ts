// ── Reflex Agent ──────────────────────────────────────────────────────────────
// The fast FRONT DOOR every question hits first. It has ONE job and answers nothing itself: look at the
// programs that ALREADY EXIST in the DB (the catalog) and decide —
//   • a program already computes this question → REUSE it (run it, filling in this question's values), or
//   • nothing fits → BUILD (hand to the analyst, which always produces a program).
// The ENGINE hands it the top-K candidate intents that a SEMANTIC search already surfaced (not the whole
// catalog) — the reflex reads them in plain LANGUAGE and picks reuse/build + where the new node hangs
// (placement). One prompt in (question + candidates), one JSON out — it never touches data or writes files.
// (No basis coordinate: retrieval is the semantic index; the reflex reasons over the words.)
//
// Harness/model default to opencode + deepseek-v4-flash (the 2026-07-31 snapshot on the opencode-go gateway),
// overridable per-agent from .env (ICA_REFLEX_HARNESS / ICA_REFLEX_MODEL / ICA_REFLEX_PROVIDER) with NO code change.

import './generate-system.js'   // FIRST: (re)writes ./SYSTEM.md + ./REVIEW.md from generate-system.ts before they're read below
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, type Harness, type Session } from '../../ica/index.js'
import { loadPrompt } from '../../prompts.js'
import type { NodeStore } from '@superatom/node-store'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The reflex prompt, via the override layer (volume override for the current image → baked fallback).
const reflexPrompt = () => loadPrompt(join(__dirname, 'SYSTEM.md'), 'reflex/SYSTEM.md')
// The reflex's REVIEW instruction (a second, distinct job: judge a reused program's answer).
const reviewPrompt = () => loadPrompt(join(__dirname, 'REVIEW.md'), 'reflex/REVIEW.md')

// Reflex is a pure CLASSIFIER — it never uses tools or writes files. This minimal system prompt REPLACES
// opencode's default coding agent prompt (the per-message SYSTEM.md/REVIEW.md carry the real task), and paired
// with noTools it strips the whole toolset — no schemas, no tool calls, far fewer tokens.
const REFLEX_SYS = 'You are a fast classifier. Follow the instructions in each message exactly and reply with ONLY what they ask for — strict JSON when requested, no prose, no code fences. You have NO tools: never read or write files, never run commands.'

/** Deterministic hash of the EFFECTIVE instructions — a prompt (or override) change → fresh session. */
export async function promptVersion(): Promise<string> {
  return createHash('sha1').update(reflexPrompt() + reviewPrompt()).digest('hex').slice(0, 12)
}

/** The reflex's verdict on a reused program's answer. */
export type ReviewVerdict = { verdict: 'accept' | 'escalate'; reason?: string }

// A COMPACT view of an answer for review — enough to judge if it answers the question, not the whole blob.
function answerDigest(a: any): string {
  if (!a || typeof a !== 'object') return String(a)
  const rows = a.table?.rows?.length ?? 0
  const cols = a.table?.columns?.length ?? 0
  return JSON.stringify({
    status: a.status ?? null, answer: a.answer ?? null,
    headline: a.headline ? { label: a.headline.label, display: a.headline.display } : null,
    figures: Array.isArray(a.figures) ? a.figures.length : 0,
    table: { columns: cols, rows }, caveat: a.caveat ?? null,
  })
}

// A candidate the ENGINE retrieved by semantic search: an existing intent + the program it runs (if any).
export type Candidate = { intentId: string; question: string; program?: string; params?: any }
// Where the new question's node hangs: 'root' (a fresh topic) or an existing intentId (a follow-up of it).
export type Placement = 'root' | string
// What the reflex needs for placement: the session's first question forces root; else the current intent is context.
export type RouteCtx = { firstInSession: boolean; currentIntentId?: string; currentQuestion?: string }

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

/** The routing decision for one input: reuse an existing program, or build (analyst). The reflex NEVER decides
 * "modify" — editing an answer is deterministic and engine-side (only on an explicit `edit:`/`modify:` prefix). */
export type Route =
  | { decision: 'reuse'; intentId: string; program: string; params: Record<string, unknown>; placement: Placement }
  | { decision: 'build'; adapt?: { program: string }; placement: Placement }   // adapt = a related program the analyst should start from

// Render the retrieved candidates for the prompt: id + its question + the program's param shape, so the agent
// can reuse one that computes the SAME thing (filling in THIS question's values), or adapt/build.
function renderCandidates(cands: Candidate[]): string {
  if (!cands.length) return 'CANDIDATES: none found — nothing to reuse, so BUILD.'
  return 'CANDIDATES (existing intents most similar to the question; reuse ONLY one that computes the SAME thing, just with different values):\n'
    + cands.map((c, i) => `${i + 1}. intentId=${c.intentId} · question="${c.question}"${c.program ? ` · params=${JSON.stringify(c.params ?? {})}` : ' · (no program)'}`).join('\n')
}

export function createReflex(opts: ReflexOpts) {
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_REFLEX_HARNESS as Harness) ?? 'opencode'
  const model = opts.ica?.model ?? process.env.ICA_REFLEX_MODEL ?? 'deepseek-v4-flash'
  const provider = opts.ica?.provider ?? process.env.ICA_REFLEX_PROVIDER ?? 'opencode-go'
  let session: Session | null = null

  /**
   * Question + the top-K semantically-retrieved CANDIDATES + placement context → one JSON judgment. Each call is
   * a turn on the ONE reused session (stateful). The candidates are the search results (not the whole catalog),
   * so the reflex reasons over a bounded, relevant set in plain language.
   */
  async function decide(question: string, candidates: Candidate[], ctx: RouteCtx): Promise<any> {
    const system = reflexPrompt()   // fresh each turn → an edited override goes live without a restart
    session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl, noTools: true, system: REFLEX_SYS })
    const place = ctx.firstInSession
      ? 'PLACEMENT: this is the FIRST question of the session → placement MUST be "root".'
      : `PLACEMENT: the user is currently on intent "${ctx.currentQuestion ?? ''}" (id=${ctx.currentIntentId ?? 'root'}). Set placement = "root" for a new topic, or the intentId this question follows from.`
    const { lastLines } = await session.run(`${system}\n\n---\n${renderCandidates(candidates)}\n\n${place}\n\n---\nQUESTION: ${question}\n\nJSON:`)
    return extractJson(lastLines)
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
    review,
    /** Pre-create the session (connect to the warm opencode server) so the first route() has no cold start. */
    async warmup() { session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl, noTools: true, system: REFLEX_SYS }); await session.warmup?.() },
    /**
     * Every question goes through here (after the engine's exact-match miss + semantic retrieval). The agent
     * reads the retrieved CANDIDATES and either picks one to REUSE (its program computes THIS question — just
     * different values) or routes to BUILD (optionally pointing at a related program to adapt) — plus WHERE the
     * node hangs (placement). We validate every id against the DB; a stale pick or a bad reuse falls through to
     * the analyst downstream, so a wrong guess is self-correcting.
     */
    async route(store: NodeStore, question: string, candidates: Candidate[], ctx: RouteCtx): Promise<Route> {
      const d = await decide(question, candidates, ctx)
      // Placement: first question of a session is always root; otherwise accept a real intentId, else fall to root.
      const placement: Placement = ctx.firstInSession ? 'root'
        : (typeof d.placement === 'string' && d.placement !== 'root' && store.getNode(d.placement)) ? d.placement : 'root'
      if (d.action === 'reuse' && typeof d.reuseId === 'string') {
        const prog = (store.getNode(d.reuseId)?.props as any)?.program
        if (prog) return { decision: 'reuse', intentId: d.reuseId, program: prog, params: (d.params && typeof d.params === 'object') ? d.params : {}, placement }
        // named a stale / programless intent → build instead
      }
      let adapt: { program: string } | undefined
      if (typeof d.adaptId === 'string') { const p = (store.getNode(d.adaptId)?.props as any)?.program; if (p) adapt = { program: p } }
      return { decision: 'build', adapt, placement }
    },
    stop() { session?.stop() },
  }
}
