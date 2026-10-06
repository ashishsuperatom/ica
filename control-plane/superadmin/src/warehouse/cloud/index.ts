// The cloud warehouse: the organisation's tables in one shared Basin Catalog (a namespace each), data files in R2,
// queries by Basin SQL. Nothing Basin-specific leaves this folder.

import { basinSql } from './sql'
import { icebergCatalog, CatalogError, type IcebergSchema, type TableMetadata } from './catalog'
import { appendRows, type ObjectStore } from './append'
import { checkQuery, capRows, type Grant } from '../access'
import { namespaceOf, NOT_CONFIGURED, TABLE_NAME, COLUMN_TYPES, WarehouseRefusal, type Column, type DataSourceBridge, type Ingest, type TableInfo } from '../bridge'

/** How long what the catalog said about an organisation's tables is trusted (this warehouse's own writes forget it). */
const SCHEMA_TTL = 5 * 60_000

export interface CloudConfig { accountId: string; bucket: string; catalogToken: string; sqlToken: string; catalogUri?: string; sqlEndpoint?: string }

const tableInfo = (name: string, m: TableMetadata): TableInfo => {
  const s = m.schemas.find((x) => x['schema-id'] === m['current-schema-id']) ?? m.schemas[0]
  const snap = (m.snapshots ?? []).find((x) => String(x['snapshot-id']) === String(m['current-snapshot-id']))
  const total = snap?.summary?.['total-records']
  return { name, columns: (s?.fields ?? []).map((f) => ({ name: f.name, type: f.type as Column['type'], required: f.required })),
    ...(snap ? { appended: snap['timestamp-ms'] } : {}), ...(total !== undefined && Number.isFinite(Number(total)) ? { rows: Number(total) } : {}) }
}

export function cloudWarehouse(cfg: CloudConfig | null, store: ObjectStore | null, fetcher: typeof fetch = fetch): { bridge: DataSourceBridge & { queryAs: QueryAs }; ingest: Ingest } {
  const configured = !!cfg && !!store
  const catalog = cfg ? icebergCatalog({ uri: cfg.catalogUri ?? `https://catalog.cloudflarestorage.com/${cfg.accountId}/${cfg.bucket}`, warehouse: `${cfg.accountId}_${cfg.bucket}`, token: cfg.catalogToken }, fetcher) : null
  const sql = cfg ? basinSql({ accountId: cfg.accountId, bucket: cfg.bucket, token: cfg.sqlToken, endpoint: cfg.sqlEndpoint }, fetcher) : null
  const need = () => { if (!configured) throw new WarehouseRefusal(NOT_CONFIGURED) }

  // The catalog answers slowly (a second or more a call), and every query is checked against the organisation's tables:
  // what it said is kept for a short while — the lookup itself, so requests at once share one — and forgotten when this
  // warehouse makes a table or adds rows. Another writer's change shows within SCHEMA_TTL.
  const known = new Map<string, { at: number; tables: Promise<TableInfo[]> }>()
  const forget = (org: string) => known.delete(namespaceOf(org))
  const tables = async (org: string): Promise<TableInfo[]> => {
    need()
    const ns = namespaceOf(org)
    const hit = known.get(ns)
    if (hit && Date.now() - hit.at < SCHEMA_TTL) return hit.tables
    const lookup = (async () => { const names = await catalog!.tables(ns); return Promise.all(names.map(async (n) => tableInfo(n, (await catalog!.load(ns, n)).metadata))) })()
    known.set(ns, { at: Date.now(), tables: lookup })
    lookup.catch(() => { if (known.get(ns)?.tables === lookup) known.delete(ns) })
    return lookup
  }
  const queryAs: QueryAs = async (org, text, grant, opts = {}) => {
    need()
    const schemas = await tables(org)
    let checked
    try { checked = checkQuery(text, schemas, grant === 'all' ? null : grant, namespaceOf(org)) } catch (e: any) { throw new WarehouseRefusal(e.message) }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 5000))
    let capped
    try { capped = capRows(checked.sql, limit + 1) } catch (e: any) { throw new WarehouseRefusal(e.message) }
    const r = await sql!.query(capped)
    // An expression's own name carries the table as the warehouse placed it (`min(<namespace>.t.x)`): shown as written.
    const ns = `${namespaceOf(org)}.`
    const plain = (c: string) => c.split(ns).join('')
    const columns = r.columns.map(plain)
    const rows = r.rows.slice(0, limit).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [plain(k), v])))
    return { columns, rows, truncated: r.rows.length > limit, tables: checked.tables }
  }
  return {
    bridge: {
      configured,
      tables,
      async describe(org, table) {
        need()
        return (await tables(org)).find((t) => t.name === table) ?? null
      },
      // The bridge's plain query reads every table of the organisation; callers with a project use queryAs.
      async query(org, text, opts) { const r = await queryAs(org, text, 'all', opts); return { columns: r.columns, rows: r.rows, truncated: r.truncated } },
      queryAs,
    },
    ingest: {
      configured,
      async createTable(org, t) {
        need()
        if (!TABLE_NAME.test(t.name)) throw new WarehouseRefusal(`"${t.name}" is not a table name (lowercase letters, digits and _; a letter first)`)
        if (!t.columns.length) throw new WarehouseRefusal('a table has at least one column')
        const seen = new Set<string>()
        for (const c of t.columns) {
          if (!/^[a-z_][a-z0-9_]{0,62}$/.test(c.name)) throw new WarehouseRefusal(`"${c.name}" is not a column name`)
          if (seen.has(c.name)) throw new WarehouseRefusal(`the column "${c.name}" is named twice`); seen.add(c.name)
          if (!COLUMN_TYPES.includes(c.type)) throw new WarehouseRefusal(`"${c.type}" is not a column type (${COLUMN_TYPES.join(', ')})`)
        }
        const ns = namespaceOf(org)
        await catalog!.ensureNamespace(ns, { owner: `org:${org}` })
        const schema: IcebergSchema = { type: 'struct', 'schema-id': 0, fields: t.columns.map((c, i) => ({ id: i + 1, name: c.name, required: !!c.required, type: c.type })) }
        try { await catalog!.create(ns, t.name, schema) } catch (e) { if (e instanceof CatalogError && e.status === 409) throw new WarehouseRefusal(`there is already a table "${t.name}"`); throw e }
        finally { forget(org) }
      },
      async append(org, table, rows) {
        need()
        try { const r = await appendRows(catalog!, store!, namespaceOf(org), table, rows); return { snapshot: r.snapshot, rows: r.rows } }
        catch (e) { if (e instanceof CatalogError && e.status === 404) throw new WarehouseRefusal(`there is no table "${table}"`); throw e }
        finally { forget(org) }
      },
    },
  }
}

/** A query as someone may run it: everything ('all', an organisation administrator) or a project's grant. */
export type QueryAs = (org: string, sql: string, grant: Grant | 'all', opts?: { limit?: number }) => Promise<{ columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; tables: string[] }>
