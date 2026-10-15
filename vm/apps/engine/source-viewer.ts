// ── A SOURCE'S DATA, EXPLORED AS THE ONE ASKING MAY SEE IT ──────────────────────────────────────────────────────────
//
// The console's explorer for a connected source — the same explorer the warehouse has, the same reads (a table's rows
// searched, filtered, sorted and paged; a column's commonest values; every column profiled; a column's spread), made by
// the one shared module (clients/explore.ts). The difference is where they run: here, through the datasource manager —
// the one data seam — which rewrites each read into the source's own dialect and applies the asker's data access to
// every table it reads: each read goes with the asker's ticket (their own key, for a source read with each person's). A table's columns come from this engine's copy of the index (disabled ones too: disabling hides
// a table from the agents' schema tools, it does not stop a read).
//
// A source that is not SQL (a document store's collections, an API's entities): its rows are held by the manager, at
// most its row cap, and explored there in DuckDB's SQL — said, with each result, whether that is all of it or a sample.

import { explore, exploreType, dialectOf, ExploreRefusal, type ExploreRequest, type QueryResult } from '../../../clients/explore.js'
import { getSchema, type DataSourceIndex } from '@superatom/datasource-index'
import { whoIs } from './identity.js'

/** How long a table's readable columns (learnt from one sample row) are kept before they are asked again. */
const READABLE_FOR_MS = 10 * 60_000

export function createSourceViewer(o: {
  manager: string
  index: DataSourceIndex
  policiesFor: (who: ReturnType<typeof whoIs>, source: string) => Promise<unknown[]>
  /** The asker's ticket: every read goes with it (their data access; their own key, for a source read with each person's). */
  ticketOf: (from: unknown) => Promise<string>
  /** A source's kind and SQL dialect (as its bridge says), or null when there is no such source. */
  sourceOf: (source: string) => Promise<{ kind: string; dialect: string | null } | null>
}) {
  // An analysis read (a profile, bins, a column's values or spread) can be heavy: each person's run one at a time, in
  // order, whatever page or tab sent them — the browser queues its own, this holds for every client together.
  const lanes = new Map<string, Promise<unknown>>()
  const readable = new Map<string, { at: number; names: Set<string> | null }>()
  function inLane<T>(who: string, work: () => Promise<T>): Promise<T> {
    const before = lanes.get(who) ?? Promise.resolve()
    const mine = before.catch(() => {}).then(work)
    const tail = mine.catch(() => {})
    lanes.set(who, tail)
    void tail.then(() => { if (lanes.get(who) === tail) lanes.delete(who) })
    return mine
  }

  /** One read of the explorer, as `from` may see it. */
  async function read(p: { source?: unknown; request?: unknown }, from: unknown): Promise<Record<string, unknown>> {
    const req = p.request as ExploreRequest | undefined
    if (req && typeof req === 'object' && req.op !== 'rows') { let who = 'unknown'; try { who = whoIs(from).id } catch { /* refused below */ } return inLane(who, () => readNow(p, from)) }
    return readNow(p, from)
  }
  async function readNow(p: { source?: unknown; request?: unknown }, from: unknown): Promise<Record<string, unknown>> {
    const source = String(p.source ?? ''), req = p.request as ExploreRequest | undefined
    if (!source || !req || typeof req !== 'object') return { error: 'which source, and what to read?' }
    if (!('table' in req) || !req.table) return { error: 'a source is explored table by table' }
    const src = await o.sourceOf(source)
    if (src === null) return { error: `there is no source ${source} on the engine` }
    if (src.kind !== 'sql') return readSample(source, String(req.table), req, from)
    let policies: unknown[]
    try { policies = await o.policiesFor(whoIs(from), source) } catch (e: any) { return { error: e?.message ?? 'your data access could not be checked — nothing was read' } }
    let schema: any
    try { schema = getSchema(o.index, source, String(req.table), { includeDisabled: true }) } catch (e: any) { return { error: e?.message ?? String(e) } }
    const indexed = (schema.fields as { field: string; type: string | null }[]).map((f) => ({ name: f.field, type: exploreType(f.type) }))
    let ticket: string
    try { ticket = await o.ticketOf(from) } catch (e: any) { return { error: e?.message ?? 'your data access could not be checked — nothing was read' } }
    const run = async (sql: string, limit: number): Promise<QueryResult> => {
      const r = await fetch(`${o.manager}/query`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-ticket': ticket }, body: JSON.stringify({ id: source, sql }) })
      const d = await r.json().catch(() => ({})) as { rows?: Record<string, unknown>[]; error?: string; cappedTo?: number }
      if (!r.ok) throw new ExploreRefusal(d.error ?? `the source did not answer (${r.status})`)
      const rows = (d.rows ?? []).slice(0, limit)
      return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, truncated: !!d.cappedTo }
    }
    // the reads in the source's own SQL (its dialect), never one dialect hoped to pass for all
    const d = dialectOf(src.dialect)
    // Only the columns the source lets this connection read: a source may hold fields it will not show (permissions),
    // and one such field named in a read fails the whole read. One sample row says which come back (kept a while).
    let columns = indexed
    const key = `${source}|${req.table}|${JSON.stringify(policies)}`
    let seen = readable.get(key)
    if (!seen || Date.now() - seen.at > READABLE_FOR_MS) {
      try { const r = await run(d.firstN(`SELECT * FROM ${d.id(String(req.table))}`, 1), 1); seen = { at: Date.now(), names: r.rows.length ? new Set(Object.keys(r.rows[0]!).map((x) => x.toLowerCase())) : null } }
      catch { seen = { at: Date.now(), names: null } }
      readable.set(key, seen)
    }
    if (seen.names) columns = indexed.filter((c) => seen!.names!.has(c.name.toLowerCase()))
    try { return { result: await explore(run, { name: String(req.table), from: d.id(String(req.table)), columns, rows: schema.rows ?? undefined }, req, d) } }
    catch (e: any) { return { error: e?.message ?? String(e) } }
  }
  /** A document store's collection or an API's entity: its rows held by the manager (/snapshot — read as the asker, at most
   *  its row cap) and explored there in DuckDB's SQL; whether it is all of it or a sample, said with the result. */
  async function readSample(source: string, table: string, req: ExploreRequest, from: unknown): Promise<Record<string, unknown>> {
    let ticket: string
    try { ticket = await o.ticketOf(from) } catch (e: any) { return { error: e?.message ?? 'your data access could not be checked — nothing was read' } }
    let sample = { rows: 0, complete: true }
    const run = async (sql: string, limit: number): Promise<QueryResult> => {
      const r = await fetch(`${o.manager}/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sa-ticket': ticket }, body: JSON.stringify({ id: source, entity: table, sql }) })
      const d = await r.json().catch(() => ({})) as { rows?: Record<string, unknown>[]; error?: string; sample?: { rows: number; complete: boolean } }
      if (!r.ok) throw new ExploreRefusal(d.error ?? `the source did not answer (${r.status})`)
      if (d.sample) sample = d.sample
      const rows = (d.rows ?? []).slice(0, limit)
      return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, truncated: false }
    }
    try {
      const cols = await run(`SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position`, 1000)
      if (!sample.rows) return { error: `${table} holds nothing you may read` }
      const columns = cols.rows.map((c) => ({ name: String(c.name), type: exploreType(String(c.type)) }))
      return { result: await explore(run, { name: table, from: '"t"', columns, rows: sample.rows }, req, dialectOf('duckdb')), sample }
    } catch (e: any) { return { error: e?.message ?? String(e) } }
  }
  return { read }
}
