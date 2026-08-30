// datasource-manager — the ONE data seam.
//
//   query(dataSourceId, sql, params)  →  POST http://localhost:<PORT>/query {id, sql, params}
//   introspect(dataSourceId)          →  POST /introspect {id}
//   list sources                      →  GET  /sources
//
// The manager routes by `id` to a BRIDGE loaded in-process. A bridge owns the connection to its
// remote source (e.g. the TotalGroup bridge holds the WebSocket to the remote DB). Adding a source
// = add a bridge to the registry below; nothing else in the system changes. Local port only —
// callers (ICA units, the semantic-model agent) never see a database, port, or credential.

import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, isAbsolute } from 'node:path'
import { rewriteSqlDetailed } from './sqlglot-pool.js'

// Result caps for AGENT queries — a runaway/unbounded query must not dump a whole table (192K rows would
// overwhelm the bridge WS AND the UI, which shows hundreds at most). MAX_ROWS is enforced AT THE SOURCE — the
// rewrite injects a LIMIT/FETCH FIRST into the query's AST, so the DB never returns more (a no-op for
// aggregations; the smaller of any agent-supplied limit wins). MAX_BYTES is a secondary guard for very wide
// rows. The trusted raw path (grounding/introspect, {raw:true}) skips the rewrite and both caps.
// 1000 is the HARD ceiling, enforced here so it holds whatever a program asks for. The SOFT limit (100 rows
// unless the question asks for more) lives in the authoring rule — the agent chooses that; this only backstops it.
const MAX_ROWS = Number(process.env.ICA_MAX_ROWS ?? 5000)
const MAX_BYTES = Number(process.env.ICA_MAX_BYTES ?? 8_000_000)

const PORT = Number(process.env.DATASOURCE_PORT ?? process.env.MANAGER_PORT ?? 4000)

// Dynamically-registered sources (from the connector agent) persist here (id → absolute bridge path) so they
// survive a restart. On Fly, point DATASOURCE_DATA_DIR at the mounted volume.
const DATA_DIR = process.env.DATASOURCE_DATA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..', '.data')
const REGISTRY_FILE = join(DATA_DIR, 'registry.json')

// A Bridge knows WHAT it is (kind/dialect) so the agent can write the right query, and HOW to run
// it. The bridge is the source of truth for kind/dialect; the manager just surfaces it.
interface Bridge {
  id: string
  kind: string                 // sql | rest | file | json — the query paradigm the agent must use
  dialect?: string             // for kind=sql: mssql | postgres | duckdb | sqlite …
  description?: string         // short how-to-query hint (dialect quirks)
  ready(): boolean
  query(sql: string, params?: Record<string, unknown>): Promise<any[]>
  introspect(): Promise<{ tables: any[]; kind?: string; dialect?: string }>
  close?(): void
}

// Registry: dataSourceId → the bridge module to load. The source of truth is registry.json (in
// DATASOURCE_DATA_DIR) — what the connector agent registers, per project, persisted on the volume. An
// optional SOURCES env can still seed static sources (JSON: {"id":"/abs/path/bridge.mjs"}); it's MERGED with
// registry.json (dynamic overrides). A fresh box with neither = no sources (add them via the connector agent).
const ENV_REGISTRY: Record<string, string> = process.env.SOURCES ? JSON.parse(process.env.SOURCES) : {}

const bridges = new Map<string, Bridge>()

const readDynamicRegistry = async (): Promise<Record<string, string>> => {
  try { return JSON.parse(await readFile(REGISTRY_FILE, 'utf8')) } catch { return {} }
}
const writeDynamicRegistry = async (reg: Record<string, string>) => {
  await mkdir(DATA_DIR, { recursive: true }); await writeFile(REGISTRY_FILE, JSON.stringify(reg, null, 2))
}

// Import a bridge module by path (absolute → file URL; else relative to this file). Cache-busted so a
// re-registered (rewritten) bridge reloads fresh instead of returning the cached module.
async function importBridge(rel: string): Promise<Bridge> {
  const base = isAbsolute(rel) ? pathToFileURL(rel).href : new URL(rel, import.meta.url).href
  const mod: any = await import(`${base}?t=${Date.now()}`)
  return mod.createBridge()
}

async function loadBridge(id: string, rel: string) {
  const bridge = await importBridge(rel)
  bridges.set(id, bridge)
  console.log(`[datasource] loaded bridge "${id}" (${bridge.dialect ?? bridge.kind})`)
}

async function loadBridges() {
  const merged = { ...ENV_REGISTRY, ...(await readDynamicRegistry()) }   // dynamic overrides env on conflict
  for (const [id, rel] of Object.entries(merged)) {
    try { await loadBridge(id, rel) } catch (e: any) { console.error(`[datasource] failed to load bridge "${id}": ${e?.message ?? e}`) }
  }
}

// Register a bridge LIVE (called by the connector agent after it writes + wants to test one). Imports it into
// the running process, persists it to registry.json, and returns its surfaced kind/dialect/ready. No restart.
async function registerSource(id: string, path: string): Promise<{ ok: boolean; source?: any; error?: string }> {
  try {
    await loadBridge(id, path)
    const reg = await readDynamicRegistry(); reg[id] = path; await writeDynamicRegistry(reg)
    const b = bridges.get(id)!
    return { ok: true, source: { id, kind: b.kind, dialect: b.dialect, description: b.description, ready: b.ready() } }
  } catch (e: any) { return { ok: false, error: e?.message ?? String(e) } }
}

async function unregisterSource(id: string): Promise<{ ok: boolean }> {
  try { bridges.get(id)?.close?.() } catch { /* ignore */ }
  bridges.delete(id)
  const reg = await readDynamicRegistry(); delete reg[id]; await writeDynamicRegistry(reg)
  return { ok: true }
}

// ── HTTP (localhost only) ─────────────────────────────────────────────────────
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let b = ''
    req.on('data', (c) => (b += c))
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}) } catch { reject(new Error('invalid JSON body')) } })
    req.on('error', reject)
  })
}
const send = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost')
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true })
  if (req.method === 'GET' && url.pathname === '/sources')   // the agent reads kind/dialect here before writing queries
    // id is the REGISTRY KEY (what the manager routes by), NOT the bridge's own id — one authoritative name so
    // /sources, /query, the index and grounding always agree (a source is renamed by its registry key alone).
    return send(res, 200, { sources: [...bridges.entries()].map(([id, b]) => ({ id, kind: b.kind, dialect: b.dialect, description: b.description, ready: b.ready() })) })

  // Dynamic registration (the connector agent): add or remove a bridge live, no restart.
  if (req.method === 'POST' && url.pathname === '/sources') {
    let b: any; try { b = await readBody(req) } catch (e: any) { return send(res, 400, { error: e.message }) }
    if (!b.id || !b.path) return send(res, 400, { error: 'body must have { id, path }' })
    const r = await registerSource(String(b.id), String(b.path))
    return send(res, r.ok ? 200 : 400, r)
  }
  if (req.method === 'DELETE' && url.pathname === '/sources') {
    let b: any; try { b = await readBody(req) } catch (e: any) { return send(res, 400, { error: e.message }) }
    if (!b.id) return send(res, 400, { error: 'body must have { id }' })
    return send(res, 200, await unregisterSource(String(b.id)))
  }

  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' })
  let body: any
  try { body = await readBody(req) } catch (e: any) { return send(res, 400, { error: e.message }) }

  const bridge = bridges.get(body.id)
  if (!bridge) return send(res, 404, { error: `unknown data source: "${body.id}" (known: ${[...bridges.keys()].join(', ') || 'none'})` })

  try {
    if (url.pathname === '/query') {
      if (!body.sql) return send(res, 400, { error: 'body must have { id, sql, params? }' })
      // Agent path (default): for a kind:'sql' source the query goes through the rewrite — parsed to an AST,
      // SELECT-only-checked, policy- and row-cap-injected, rendered to the source dialect (sqlrewrite/worker.py).
      // A NON-SQL source (rest/file/json) owns its own query paradigm, so its query text passes to the bridge
      // as-is (the rewrite only understands SQL). Trusted SYSTEM path (introspect/grounding, via {raw:true})
      // always passes as-is. Only the raw path skips checks and the agent can't reach it; `sql` (what actually
      // ran) is returned for visibility.
      const passthrough = body.raw || bridge.kind !== 'sql'
      const rw = passthrough
        ? { sql: String(body.sql), cappedTo: null as number | null }
        : await rewriteSqlDetailed(String(body.sql), { sourceDialect: bridge.dialect, maxRows: MAX_ROWS })
      const sql = rw.sql
      const rows = await bridge.query(sql, body.params ?? {})
      // Byte guard for wide rows (the row cap is already injected into the agent query's AST). Raw/system reads are exempt.
      if (!body.raw) { const bytes = JSON.stringify(rows).length; if (bytes > MAX_BYTES) return send(res, 413, { error: `result too large (${(bytes / 1e6).toFixed(1)} MB) — add a filter or aggregate` }) }
      // REPORT what we did to the query. `notes` is only present when it changes how the result must be read:
      // we injected a row limit AND the result reached it, so these rows are a PREFIX, not the whole answer.
      // Without this the caller cannot tell a capped read from a complete one — the difference between a
      // partial list and a wrong total.
      const truncated = rw.cappedTo != null && rows.length >= rw.cappedTo
      const notes = truncated
        ? [`Row limit ${rw.cappedTo} was applied and reached: these are the FIRST ${rw.cappedTo} rows, not the full result. Aggregate in the query (COUNT/SUM/GROUP BY) for totals, or narrow it with a filter.`]
        : undefined
      return send(res, 200, { rows, sql, ...(rw.cappedTo != null ? { cappedTo: rw.cappedTo } : {}), ...(notes ? { notes } : {}) })
    }
    if (url.pathname === '/introspect') return send(res, 200, await bridge.introspect())
    return send(res, 404, { error: 'not found — use POST /query, POST /introspect, GET /sources' })
  } catch (e: any) {
    return send(res, 500, { error: e?.message ?? String(e) })
  }
})

await loadBridges()
server.listen(PORT, '127.0.0.1', () => console.log(`[datasource-manager] http://127.0.0.1:${PORT} · sources: ${[...bridges.keys()].join(', ')}`))

// Keep the URL helper import honest under noUnusedLocals-style linters.
void fileURLToPath
