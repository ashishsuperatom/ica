// ── A SOURCE'S DATA, EXPLORED AS THE ONE ASKING MAY SEE IT ──────────────────────────────────────────────────────────
//
// The console's explorer for a connected source — the same explorer the warehouse has, the same reads (a table's rows
// searched, filtered, sorted and paged; a column's commonest values; every column profiled; a column's spread), made by
// the one shared module (clients/explore.ts). The difference is where they run: here, through the datasource manager —
// the one data seam — which rewrites each read into the source's own dialect and applies the asker's data access to
// every table it reads. A table's columns come from this engine's copy of the index (disabled ones too: disabling hides
// a table from the agents' schema tools, it does not stop a read).
//
// A SQL source only for now: a file's sheets and an API's resources are each their own reader (planned), so another
// kind answers that its reader is not built rather than guessing.

import { explore, exploreType, ExploreRefusal, type ExploreRequest, type QueryResult } from '../../../clients/explore.js'
import { getSchema, type DataSourceIndex } from '@superatom/datasource-index'
import { whoIs } from './identity.js'

/** A table's name as SQL names it: plain when it is a plain (possibly schema-qualified) name, else quoted. */
const tableSql = (t: string) => (/^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)*$/.test(t) ? t : `"${t.replace(/"/g, '""')}"`)
export function createSourceViewer(o: {
  manager: string
  index: DataSourceIndex
  policiesFor: (who: ReturnType<typeof whoIs>, source: string) => Promise<unknown[]>
  kindOf: (source: string) => Promise<string | null>
}) {
  // An analysis read (a profile, bins, a column's values or spread) can be heavy: each person's run one at a time, in
  // order, whatever page or tab sent them — the browser queues its own, this holds for every client together.
  const lanes = new Map<string, Promise<unknown>>()
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
    const kind = await o.kindOf(source)
    if (kind === null) return { error: `there is no source ${source} on the engine` }
    if (kind !== 'sql') return { error: `a reader for ${kind} sources is not built yet` }
    let policies: unknown[]
    try { policies = await o.policiesFor(whoIs(from), source) } catch (e: any) { return { error: e?.message ?? 'your data access could not be checked — nothing was read' } }
    let schema: any
    try { schema = getSchema(o.index, source, String(req.table), { includeDisabled: true }) } catch (e: any) { return { error: e?.message ?? String(e) } }
    const columns = (schema.fields as { field: string; type: string | null }[]).map((f) => ({ name: f.field, type: exploreType(f.type) }))
    const run = async (sql: string, limit: number): Promise<QueryResult> => {
      const r = await fetch(`${o.manager}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: source, sql, policies }) })
      const d = await r.json().catch(() => ({})) as { rows?: Record<string, unknown>[]; error?: string; cappedTo?: number }
      if (!r.ok) throw new ExploreRefusal(d.error ?? `the source did not answer (${r.status})`)
      const rows = (d.rows ?? []).slice(0, limit)
      return { columns: rows[0] ? Object.keys(rows[0]) : [], rows, truncated: !!d.cappedTo }
    }
    try { return { result: await explore(run, { name: String(req.table), from: tableSql(String(req.table)), columns, rows: schema.rows ?? undefined }, req) } }
    catch (e: any) { return { error: e?.message ?? String(e) } }
  }
  return { read }
}
