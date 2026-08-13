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
    return send(res, 200, { sources: [...bridges.values()].map((b) => ({ id: b.id, kind: b.kind, dialect: b.dialect, description: b.description, ready: b.ready() })) })

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
      return send(res, 200, { rows: await bridge.query(body.sql, body.params ?? {}) })
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
