// The data seam. Units and the wrapper import `query` and NOTHING else about data access —
// they never see HTTP, WebSockets, ports, dialects, or credentials. There is ONE endpoint: the
// datasource-manager. It routes by `dataSourceId` to the right bridge, and the bridge (which owns
// the remote connection) binds params in its own dialect and runs the query. Callers just say
// query(id, sql, params) -> rows.

const MANAGER = process.env.DATASOURCE_URL ?? 'http://localhost:4000'

/**
 * Run a parameterised query against a named data source and return its rows.
 *
 * Use named placeholders (`@name`) in the SQL and pass values in `params`; the bridge binds them
 * safely in its own dialect. Throws on unknown source, transport failure, or a source error.
 */
export async function query(
  dataSourceId: string,
  sql: string,
  params: Record<string, unknown> = {},
  options: { who?: Record<string, unknown> } = {},
): Promise<any[]> {
  const res = await fetch(`${MANAGER}/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `who` is the person the query is run for: the manager chooses that person's access policies by it.
    body: JSON.stringify({ id: dataSourceId, sql, params, ...(options.who ? { who: options.who } : {}) }),
  })
  if (!res.ok) throw new Error(`Query failed [${dataSourceId}]: ${res.status} ${await res.text()}`)

  const payload: any = await res.json()
  if (payload?.error) throw new Error(`Source error [${dataSourceId}]: ${payload.error}`)
  const rows: any[] = payload?.rows ?? []
  // The seam REPORTS what it did to the query. A row limit that the caller can't see reads as "that is all the
  // data" — so surface it loudly in the run output (where whoever is writing the program will see it) and hang
  // it off the result for anything that wants to branch on it.
  if (Array.isArray(payload?.notes) && payload.notes.length) {
    for (const n of payload.notes) console.warn(`[datasource:${dataSourceId}] ${n}`)
    Object.defineProperty(rows, 'notes', { value: payload.notes, enumerable: false })
  }
  return rows
}
