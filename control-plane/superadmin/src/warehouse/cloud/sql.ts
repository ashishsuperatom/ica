// Basin SQL: read-only SQL over the warehouse's Iceberg tables, run by Cloudflare (no query engine of ours).

export interface SqlConfig { accountId: string; bucket: string; token: string; endpoint?: string }
export interface SqlResult { columns: string[]; rows: Record<string, unknown>[] }

export function basinSql(cfg: SqlConfig, fetcher: typeof fetch = fetch) {
  const url = `${(cfg.endpoint ?? 'https://api.sql.cloudflarestorage.com').replace(/\/$/, '')}/api/v1/accounts/${encodeURIComponent(cfg.accountId)}/basin-sql/query/${encodeURIComponent(cfg.bucket)}`
  return {
    async query(sql: string): Promise<SqlResult> {
      const r = await fetcher(url, { method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ query: sql }) })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok || j?.success === false) throw new Error(j?.errors?.[0]?.message ?? j?.error ?? `${r.status} ${r.statusText}`)
      const res = j.result ?? j
      const columns: string[] = (res.schema ?? res.columns ?? []).map((c: any) => (typeof c === 'string' ? c : c.name))
      // Rows as objects; a result that gives them as arrays is read by the column names.
      const rows: Record<string, unknown>[] = (res.rows ?? []).map((row: any) => (Array.isArray(row) ? Object.fromEntries(columns.map((c, i) => [c, row[i]])) : row))
      return { columns: columns.length ? columns : Object.keys(rows[0] ?? {}), rows }
    },
  }
}
