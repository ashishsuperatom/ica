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

import { NodeStore, getRun, upsertConcept, resolveConcept, conceptHash, pruneRuns, runId as deriveRunId, runsBySource, putSignature, putSample,
         type ChangeMeta, type ConceptProps } from '@superatom/node-store'
import { conceptSignature, type SqlSignature } from './signature.js'
import { validateConceptMeta } from '@superatom/scaffold'

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

export async function saveConcept(store: NodeStore, runIdToSave: string, meta: ChangeMeta, signSql?: SignSql,
                                  opts: { replace?: boolean } = {}): Promise<SaveResult> {
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
  const bad = validateConceptMeta(m)
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

  // ONE NAME AT CREATION. Alternative names were being invented at authoring time, unbounded — six per
  // concept on average and fourteen on one, including a database view and a column name, neither of which is
  // a thing anyone would ask for. A name earns its place by a question actually arriving under it, and adding
  // one then is a pointer, not a guess. Any list supplied here is ignored rather than obeyed.
  // WHO ALREADY ANSWERS TO THIS NAME. A name is the key an agent opens a concept by, and pointing it at a new
  // body moves what that name MEANS — which is right when a concept is being revised and wrong when two
  // concepts have simply been given the same name. Nothing in the write can tell those apart, and it used to
  // do the first silently, so a collision quietly took a name off the concept that held it.
  //
  // Same body under the same name is not a collision: that is a re-save, and it changes nothing.
  const holder = resolveConcept(store, m.name)
  // VERIFIED MEANS A PERSON SAID SO, and an agent may not undo that. The other rungs are agent-earned: a
  // concept that ran, or that two analyses agreed on, can be superseded by better work of the same kind. This
  // one cannot, because whatever replaced it would carry no such confirmation and nothing downstream would
  // show that the guarantee had been withdrawn.
  if (holder && holder.id !== conceptHash(props) &&
      (holder.props as any)?.status === 'verified' && !/^human:/.test(meta.changedBy)) {
    return { ok: false, reason:
      `"${m.name}" names a concept a person has verified (${holder.id}), so it is not an agent's to replace. ` +
      `Save this under a name of its own; if the verified one is wrong, that is for a person to change.` }
  }
  if (holder && holder.id !== conceptHash(props) && !opts.replace) {
    // THE EXACT MATCH IS NOT ENOUGH TO DECIDE WITH. Being told a name is taken tells you to pick another one;
    // being shown what is already nearby tells you whether this concept should exist at all, or belongs under
    // a name shaped like its neighbours'. The choice is between merging, renaming and replacing, and only the
    // last of those is about the collision.
    const near = neighbours(store, m.name).filter((n) => n.name !== m.name)
    const held = String((holder.props as any)?.value ?? '').slice(0, 160)
    return { ok: false, reason:
      `"${m.name}" already names a different concept (${holder.id}): ${held}\n` +
      (near.length
        ? `Nearby concepts:\n${near.map((n) => `  ${n.name} — ${n.value.slice(0, 110)}`).join('\n')}\n`
        : '') +
      `If yours is one of these, save under that name with --replace, or extend it instead. ` +
      `If it is genuinely different, name it so that it is.` }
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

/** Concepts whose names share a word with this one, for showing an author what already exists near what they
 *  are about to write. The same two passes the agent's own search uses: SQLite finds candidates by prefix,
 *  and the closest are taken by how much of each name is covered. */
function neighbours(store: NodeStore, name: string, limit = 6): Array<{ name: string; value: string }> {
  const words = (s: string) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1))
  const qw = [...words(name)]
  if (!qw.length) return []
  const match = 'label : (' + qw.map((w) => '"' + w + '" * ').join(' OR ') + ')'
  let rows: any[] = []
  try {
    rows = store.db.prepare(
      `SELECT n.label, n.props FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ? AND n.kind = 'index' AND n.valid_to IS NULL LIMIT 200`).all(match) as any[]
  } catch { return [] }
  const scored = rows.map((r) => {
    const cw = words(r.label); let m = 0
    for (const w of cw) if (qw.includes(w)) m++
    return { r, matched: m, cover: cw.size ? m / cw.size : 0 }
  }).filter((x) => x.matched > 0).sort((a, b) => (b.matched - a.matched) || (b.cover - a.cover))

  const out: Array<{ name: string; value: string }> = []
  const seen = new Set<string>()
  for (const x of scored) {
    const target = (JSON.parse(x.r.props || '{}') || {}).target
    if (!target || seen.has(target)) continue
    seen.add(target)
    const body: any = store.getNode(target)
    if (!body) continue
    out.push({ name: x.r.label, value: String((body.props as any)?.value ?? '') })
    if (out.length >= limit) break
  }
  return out
}
