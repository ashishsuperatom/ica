// ── A SOURCE'S ROWS, AS THE ONE ASKING MAY SEE THEM ─────────────────────────────────────────────────────────────────
//
// The console's data viewer for a connected source (the warehouse has its own: it is our uniform data, this is whatever
// the source is). A table's first rows and how many there are, read through the datasource manager — the one data seam —
// with the asker's data access applied to both reads (the rewrite injects their policies into every table read), so the
// count is of what they may see. At most VIEW_ROWS rows; the total says how many more there are.
//
// A SQL source only for now: a file's sheets and an API's resources are each their own viewer (planned), so another
// kind answers that its viewer is not built rather than guessing.

import { whoIs } from './identity.js'

const VIEW_ROWS = 100
/** A table's name as SQL names it: plain when it is a plain (possibly schema-qualified) name, else quoted. */
const tableSql = (t: string) => (/^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)*$/.test(t) ? t : `"${t.replace(/"/g, '""')}"`)

export function createSourceViewer(o: {
  manager: string
  policiesFor: (who: ReturnType<typeof whoIs>, source: string) => Promise<unknown[]>
  kindOf: (source: string) => Promise<string | null>
}) {
  const query = async (source: string, sql: string, policies: unknown[]) => {
    const r = await fetch(`${o.manager}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: source, sql, policies }) })
    const d = await r.json().catch(() => ({})) as { rows?: Record<string, unknown>[]; error?: string }
    if (!r.ok) throw new Error(d.error ?? `the source did not answer (${r.status})`)
    return d.rows ?? []
  }

  /** A table's first rows and its count, as `from` may see them. */
  async function rows(p: { source?: unknown; table?: unknown }, from: unknown): Promise<Record<string, unknown>> {
    const source = String(p.source ?? ''), table = String(p.table ?? '')
    if (!source || !table) return { error: 'which source and table?' }
    const kind = await o.kindOf(source)
    if (kind === null) return { error: `there is no source ${source} on the engine` }
    if (kind !== 'sql') return { error: `a viewer for ${kind} sources is not built yet` }
    let policies: unknown[]
    try { policies = await o.policiesFor(whoIs(from), source) } catch (e: any) { return { error: e?.message ?? 'your data access could not be checked — nothing was read' } }
    try {
      const [shown, counted] = await Promise.all([
        query(source, `SELECT * FROM ${tableSql(table)} LIMIT ${VIEW_ROWS}`, policies),
        query(source, `SELECT COUNT(*) AS n FROM ${tableSql(table)}`, policies).catch(() => null),
      ])
      const total = counted?.[0] ? Number(Object.values(counted[0])[0]) : null
      const columns = shown[0] ? Object.keys(shown[0]) : []
      return { source, table, columns, rows: shown, total: Number.isFinite(total) ? total : null, limit: VIEW_ROWS }
    } catch (e: any) { return { error: e?.message ?? String(e) } }
  }
  return { rows }
}
