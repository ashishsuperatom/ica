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
  if (!m.name) return { ok: false, reason: 'that run has no meta.name' }

  // THE BODY IS THE CONCEPT. `value`/`description` remain prose because a reader still needs to know what
  // this IS and how it differs from its nearest neighbour — but the computation, the rules and the
  // verification are no longer described here, they are the code.
  const props: ConceptProps = {
    value: String(m.description ?? '').trim() || `Computes ${m.name}.`,
    aliases: Array.isArray(m.aliases) && m.aliases.length ? m.aliases : undefined,
    // CORROBORATED, not verified. It ran and its invariants held, which is stronger than an analyst having
    // seen it once — but the existing scale reserves 'verified' for a person confirming, and quietly
    // redefining a status is how a scale stops meaning anything. Execution earns the middle rung.
    status: 'corroborated',
    source: Array.isArray(m.sources) ? m.sources[0] : undefined,
    compute: run.source,                      // runnable, not a recipe
    parameters: paramsFacet(m.params),
    // Carried onto the stored concept because they are what a READER needs in order to use the number safely,
    // and because the existing schema already had places for them — a runnable concept that dropped them
    // would have been a step backwards from the prose it replaced.
    grain: m.grain || undefined,
    time: m.time || undefined,
    measures: m.unit || m.additive !== undefined
      ? [{ name: m.name, additive: m.additive === true, note: m.unit ? `unit: ${m.unit}` : undefined }]
      : undefined,
    verifiedAt: new Date(run.at).toISOString(),
    evidence: `ran ${run.runId} in ${run.ms}ms; ${run.verifications.length} invariant(s) held`,
  }

  const node = upsertConcept(store, m.name, props, meta)

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
