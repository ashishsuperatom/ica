// ── Reflex Agent ──────────────────────────────────────────────────────────────
// The fast FRONT DOOR every question hits first. It has ONE job and answers nothing itself: look at the
// programs that ALREADY EXIST in the DB (the catalog) and decide —
//   • a program already computes this question → REUSE it (run it, filling in this question's values), or
//   • nothing fits → BUILD (hand to the analyst, which always produces a program).
// It also emits the question's INTENT COORDINATE (`basis` typed-pair axes = the structure, `params` = the
// literal values) so the intent space keeps growing for later retrieval/consolidation. One prompt in
// (question + catalog), one JSON out — it never touches data or writes files.
//
// Harness/model default to opencode + deepseek-v4-flash (the 2026-07-31 snapshot on the opencode-go gateway),
// overridable per-agent from .env (ICA_REFLEX_HARNESS / ICA_REFLEX_MODEL / ICA_REFLEX_PROVIDER) with NO code change.

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, type Harness, type Session } from '../../ica/index.js'
import { loadPrompt } from '../../prompts.js'
import { basisFromPairs, programCatalog, renderVocab, type BasisPair, type NodeStore, type ProgramEntry } from '@superatom/node-store'

const __dirname = dirname(fileURLToPath(import.meta.url))
// The reflex prompt, via the override layer (volume override for the current image → baked fallback).
const reflexPrompt = () => loadPrompt(join(__dirname, 'SYSTEM.md'), 'reflex/SYSTEM.md')

/** Deterministic hash of the EFFECTIVE instructions — a prompt (or override) change → fresh session. */
export async function promptVersion(): Promise<string> {
  return createHash('sha1').update(reflexPrompt()).digest('hex').slice(0, 12)
}

export type Param = { role: string; text: string; type?: string; value?: unknown }
export type IntentCoordinate = {
  basis: BasisPair[]                          // raw pairs the model proposed
  axes: ReturnType<typeof basisFromPairs>     // normalised, de-duped, canonical ids (feed straight to linkBasis)
  params: Param[]
  reuse?: { intentId: string; params: Record<string, unknown> }   // the agent's pick from the catalog (+ this question's values), when a program already computes it
  ms: number
  raw: string                                 // the model's raw text (for debugging a bad parse)
}

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
  | { decision: 'reuse'; intentId: string; program: string; params: Record<string, unknown>; coordinate: IntentCoordinate }
  | { decision: 'build'; coordinate: IntentCoordinate }

// Render the catalog for the prompt: id + question + the program's param shape, so the agent can pick a
// match and fill THIS question's values into the same shape.
function renderCatalog(catalog: ProgramEntry[]): string {
  if (!catalog.length) return 'EXISTING PROGRAMS: none yet — there is nothing to reuse, so route to build.'
  return 'EXISTING PROGRAMS (reuse one when it already computes THIS question — same computation; fill in this question\'s values):\n'
    + catalog.map((c, i) => `${i + 1}. intentId=${c.intentId} · question="${c.question}" · params=${JSON.stringify(c.params)}`).join('\n')
}

export function createReflex(opts: ReflexOpts) {
  const harness: Harness = opts.ica?.harness ?? (process.env.ICA_REFLEX_HARNESS as Harness) ?? 'opencode'
  const model = opts.ica?.model ?? process.env.ICA_REFLEX_MODEL ?? 'deepseek-v4-flash'
  const provider = opts.ica?.provider ?? process.env.ICA_REFLEX_PROVIDER ?? 'opencode-go'
  let session: Session | null = null

  /**
   * Question (+ the program catalog) → intent coordinate, with an optional reuse pick. Stateless: each call
   * is one fresh turn. The catalog is what makes the reuse decision GROUNDED in what actually exists — the
   * agent reads the real programs, it doesn't guess against a blind index.
   */
  async function coordinate(question: string, catalog: ProgramEntry[] = [], vocab?: string): Promise<IntentCoordinate> {
    const system = reflexPrompt()   // fresh each turn → an edited override goes live without a restart
    session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl })
    const t0 = Date.now()
    // The LIVE axis vocabulary — PREFER these tokens over minting near-duplicates; grows as the space evolves.
    const voc = vocab ? `AXIS VOCABULARY IN USE (reuse a token when it fits; only add a new one if none do):\n${vocab}\n\n---\n` : ''
    const { lastLines } = await session.run(`${system}\n\n---\n${voc}${renderCatalog(catalog)}\n\n---\nINPUT: ${question}\n\nJSON:`)
    const parsed = extractJson(lastLines)
    const basis: BasisPair[] = Array.isArray(parsed.basis) ? parsed.basis : []
    const params: Param[] = Array.isArray(parsed.params) ? parsed.params : []
    const reuse = parsed.reuse && typeof parsed.reuse.intentId === 'string'
      ? { intentId: parsed.reuse.intentId, params: (parsed.reuse.params && typeof parsed.reuse.params === 'object') ? parsed.reuse.params : {} }
      : undefined
    return { basis, axes: basisFromPairs(basis), params, reuse, ms: Date.now() - t0, raw: lastLines }
  }

  return {
    coordinate,
    /** Pre-create the session (connect to the warm opencode server) so the first route() has no cold start. */
    async warmup() { session ??= createSession(harness, { cwd: opts.cwd, model, provider, baseUrl: opts.ica?.baseUrl }); await session.warmup?.() },
    /**
     * Every question goes through here. The agent reads the DB program catalog and either picks a program to
     * REUSE or routes to BUILD. We validate its pick against the DB (the intent must still have a program);
     * a bad/failed reuse falls through to the analyst downstream, so a wrong guess is self-correcting.
     * (The basis space still grows via the coordinate's axes — that is the RETRIEVAL index for when the
     * catalog outgrows "show it all"; until then the agent sees every program directly.)
     */
    async route(store: NodeStore, question: string): Promise<Route> {
      const coord = await coordinate(question, programCatalog(store), renderVocab(store))
      if (coord.reuse) {
        const props = store.getNode(coord.reuse.intentId)?.props as any
        if (props?.program) return { decision: 'reuse', intentId: coord.reuse.intentId, program: props.program, params: coord.reuse.params, coordinate: coord }
        // The agent named an intent that no longer has a program → ignore the pick and build.
      }
      return { decision: 'build', coordinate: coord }
    },
    stop() { session?.stop() },
  }
}
