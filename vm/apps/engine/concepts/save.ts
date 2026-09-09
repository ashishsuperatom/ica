// ── SAVING A CONCEPT ──────────────────────────────────────────────────────────────────────────────────────
//
// Saving takes a runId, never a body. If an author could hand over source at save time, "verified" would
// describe something nobody executed — and the failure mode is the quiet one: try B, save the id of A from
// three messages ago, and store a concept that has never run.
//
// The id is derived from the source and the parameters, so this does not merely look the record up: it
// RE-DERIVES the id from the stored source and refuses a mismatch. What is written is what ran, structurally
// rather than by convention.
//
// Three refusals, all of them the same principle — a concept nobody can trust must not become knowledge
// everybody reuses:
//   • an unknown run           — nothing was verified
//   • a run that errored       — it does not execute
//   • a run whose invariants failed — it executes and its number is wrong, which is worse

import { NodeStore, getRun, upsertConcept, pruneRuns, runId as deriveRunId, runsBySource, putSignature, putSample,
         type ChangeMeta, type ConceptProps } from '@superatom/node-store'
import { conceptSignature, type SqlSignature } from './signature.js'

export interface SaveResult {
  ok: boolean
  reason?: string
  conceptId?: string
  name?: string
  /** Every parameter set this exact body has been exercised on — see `observedParams`. */
  observed?: unknown[]
}

/** Where the SQL half of a signature is computed. The manager owns the parser, so a signature computed
 *  anywhere else could disagree with what actually runs. Injected so this is testable, and so an unreachable
 *  manager degrades rather than fails. */
export type SignSql = (sql: string) => Promise<SqlSignature | null>

export const managerSignSql = (managerUrl: string): SignSql => async (sql) => {
  const r = await fetch(`${managerUrl}/signature`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sql }), signal: AbortSignal.timeout(10_000),
  })
  if (!r.ok) return null
  return ((await r.json()) as any).signature ?? null
}

export async function saveConcept(store: NodeStore, runIdToSave: string, meta: ChangeMeta, signSql?: SignSql): Promise<SaveResult> {
  const run = getRun(store.db, runIdToSave)
  if (!run) return { ok: false, reason: `no such run ${runIdToSave} — run the concept first` }
  if (run.error) return { ok: false, reason: `that run failed, so there is nothing verified to save:\n${run.error.split('\n')[0]}` }

  const failed = run.verifications.filter((v) => !v.ok)
  if (failed.length) {
    return { ok: false, reason: `invariants did not hold: ${failed.map((f) => f.label).join('; ')}` }
  }

  // The id is a function of the source; re-deriving it proves the record was not tampered with between the
  // run and the save. Cheap, and it turns a convention into a property.
  if (deriveRunId(run.source, run.params) !== run.runId) {
    return { ok: false, reason: 'the stored source does not hash to its run id — refusing to save' }
  }

  const m: any = run.meta ?? {}
  if (!m.name) return { ok: false, reason: 'the metadata has no name — a concept must say what a person would call it' }

  // ── VALIDATED HERE, BECAUSE HERE IS THE LAST PLACE ANYONE CAN ──────────────────────────────────────────
  // These are typed fields, and the type is no protection: the value crosses a JSON boundary on its way into
  // the store, so nothing checks it after this line. Seven concepts had already drifted to free text where a
  // three-value union was declared, and nobody noticed until the store was counted.
  const bad = validate(m)
  if (bad) return { ok: false, reason: bad }

  // THE BODY IS THE CONCEPT. `value` remains prose because a reader still needs to know what this IS and how
  // it differs from its nearest neighbour, but the computation, the rules and the verification are no longer
  // described here: they are the code.
  const sources: string[] = Array.isArray(m.sources) ? m.sources.filter(Boolean).map(String) : []
  // EVERY RUNNABLE CONCEPT CARRIES THE SAME KEYS. A field that appears only when it has a value makes two
  // concepts look like two shapes, and a reader cannot tell "this concept has no dimensions" from "this
  // concept is from before dimensions existed". An empty array says the first; a missing key says neither.
  const props: ConceptProps = {
    value: String(m.description ?? '').trim() || `Computes ${m.name}.`,
    // SELF-CHECKED. It ran and its own invariants held, which is real evidence that it works and none at all
    // that it measures the right thing. Not `corroborated`: that rung means a second, independent analysis
    // agreed, and a concept agreeing with itself is not a second witness.
    status: 'self-checked',
    // ONE FIELD FOR ONE IDEA. `source` was the first datasource and `sources` appeared only when there were
    // several, so the same fact lived under two names and one of them came and went with the data.
    sources,
    compute: run.source,                      // runnable, not a recipe
    parameters: paramsFacet(m.params) ?? [],
    // What a READER needs to use the number safely. `additive` and `unit` are first-class rather than folded
    // into a measures entry: they describe this concept's own atomic value, and `unit` spent its previous
    // life inside a prose note where nothing could check it.
    grain: m.grain || '',
    time: m.time,
    additive: m.additive === true,
    unit: m.unit ? String(m.unit).trim() : '',
    dimensions: dimensionsFacet(m.dimensions) ?? [],
    render: m.render ? String(m.render).trim() : '',
    scope: 'global',
    verifiedAt: new Date(run.at).toISOString(),
    evidence: `ran ${run.runId} in ${run.ms}ms; ${run.verifications.length} invariant(s) held`,
  }

  const node = upsertConcept(store, m.name, props, meta, Array.isArray(m.aliases) ? m.aliases : [])

  // WHAT IT LAST PRODUCED — derived, and never in props: a value moves with the data, so holding it there
  // would remint the concept on every re-run. Enough for a reader to judge fit without running it, and for a
  // structural match between two concepts to be confirmed by execution rather than assumed.
  putSample(store.db, {
    conceptId: node.id, name: m.name, params: run.params, value: run.result?.value,
    rows: Array.isArray(run.result?.distribution) ? run.result!.distribution!.length : undefined,
    caveats: run.caveats, verifications: run.verifications, ms: run.ms, at: run.at,
  })

  // THE SIGNATURE IS DERIVED, AND ITS FAILURE IS NOT THE SAVE'S FAILURE. It is an observation used to notice
  // duplication later; a concept that is correct and verified must not be rejected because a parser was
  // unreachable. Recorded when it can be, skipped with a warning when it cannot.
  if (signSql) {
    try {
      const sig = await conceptSignature(run.source, { signSql })
      putSignature(store.db, {
        conceptId: node.id, name: m.name, hash: sig.hash, coreHash: sig.sql[0]?.coreHash,
        dimension: sig.sql[0]?.dimension ?? [], calls: sig.calls, degraded: sig.degraded, sig, at: Date.now(),
      })
    } catch (e: any) {
      console.warn(`[concept] signature not computed for ${m.name}: ${e?.message ?? e}`)
    }
  }

  pruneRuns(store.db)                          // scratch: nothing depends on a run once its concept exists
  return { ok: true, conceptId: node.id, name: m.name, observed: observedParams(store, run.sourceHash) }
}

/** The parameter sets this exact body has been run with — a RECORD of what was exercised, never a claim
 *  about what matters. An author checking behaviour across several inputs produces this for free. */
export function observedParams(store: NodeStore, hash: string): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const r of runsBySource(store.db, hash)) {
    if (r.error) continue                       // a failed attempt says nothing about which inputs are valid
    const k = JSON.stringify(r.params)
    if (!seen.has(k)) { seen.add(k); out.push(r.params) }
  }
  return out
}

/** meta.params is `name → what it means`; the concept schema wants a list. Descriptions only — the VALUES
 *  live in the run records, because which values matter is discovered by running, not declared. */
const paramsFacet = (params: Record<string, string> | undefined) =>
  params ? Object.entries(params).map(([name, note]) => ({ name, note })) : undefined

/** meta.dimensions is a short list of axis names: the ways this measure can be split.
 *
 *  NOT the same thing as a parameter, which is an input that changes the computation. A dimension is an axis
 *  the RESULT can be broken down by, and the two are independent — a concept can take no parameters and still
 *  split three ways. It is declared rather than derived because the derivation is noisy: pulling the GROUP BY
 *  out of the SQL also collects the columns a join drags along, and nothing in the syntax distinguishes an
 *  analysis axis from a join artefact. */
const dimensionsFacet = (dims: unknown) =>
  Array.isArray(dims) && dims.length
    ? dims.map((d) => (typeof d === 'string' ? { name: d } : d)).filter((d: any) => d?.name)
    : undefined

/** How long a description may be before it stops being a description. Not a style rule: the field exists so a
 *  reader can tell whether this is the concept they want, and a model asked for prose will happily write four
 *  paragraphs of reasoning that belongs in comments beside the code it explains. Three short sentences fit. */
const MAX_DESCRIPTION = 300

const TIME_VALUES = ['point', 'window']
/** A parameter that bounds a window. One is enough — a year IS a window, and so is a week start. Requiring a
 *  from AND a to was the obvious rule and it was wrong: six perfectly well-formed concepts take a single
 *  bounding value. */
const BOUNDING = /from|to\b|start|end|year|month|period|cutoff|week|as[_]?of|date/i

/** Everything that must be true of the metadata before a concept exists. Returns a reason, or null.
 *
 *  It refuses rather than repairs. A description silently truncated, or a time value quietly mapped to the
 *  nearest legal one, is a concept that says something its author did not write — and the author is right
 *  here, able to fix it, which is the only moment anyone will. */
function validate(m: any): string | null {
  const desc = String(m.description ?? '').trim()
  if (!desc) return 'the metadata has no description — say in one to three sentences what this concept is'
  if (desc.length > MAX_DESCRIPTION) {
    return `the description is ${desc.length} characters and the limit is ${MAX_DESCRIPTION}. Say what this ` +
      `concept IS in one to three sentences; the reasoning, the traps and the why belong in comments inside ` +
      `the body, where they sit beside the code they explain`
  }
  if (!Array.isArray(m.sources) || !m.sources.length) {
    return 'the metadata declares no sources — name every datasource this reads'
  }
  if (m.time !== undefined && !TIME_VALUES.includes(m.time)) {
    return `time is "${m.time}" but the only values are ${TIME_VALUES.join(' and ')}. A value is either true ` +
      `AS AT an instant (point) or accumulated OVER a span (window)`
  }
  if (m.time === 'window') {
    const params = Object.keys(m.params ?? {})
    if (!params.some((p) => BOUNDING.test(p))) {
      return `time is "window" but no parameter bounds the window${params.length ? ` (has: ${params.join(', ')})` : ' (it takes none)'}` +
        ` — a total over an unstated span is not an answer, it is a number`
    }
  }
  if (m.additive !== undefined && typeof m.additive !== 'boolean') return 'additive must be true or false'
  if (m.unit !== undefined && !String(m.unit).trim()) return 'unit is present but empty — say what the value is counted in'
  return null
}
