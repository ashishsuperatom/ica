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
import { createRequire } from 'node:module'

// Compile PRQL → the source's SQL dialect. PRQL has NATIVE targets for some dialects (mssql/postgres/…); for
// ones it does NOT (e.g. NetSuite SuiteQL = Oracle-flavoured) we compile to the closest STANDARD target
// (`sql.ansi`) and apply a small per-dialect FIXUP to bridge the remaining gap. `sql.ansi` is far closer to
// Oracle than `sql.mssql` (standard COALESCE/||/CHAR_LENGTH, no [brackets] or ISNULL) — only pagination differs.
// This is the ONE place a new source declares how its PRQL compiles; keep each fixup small and targeted.
const PRQL_TARGET: Record<string, string> = { mssql: 'sql.mssql', postgres: 'sql.postgres', sqlite: 'sql.sqlite', duckdb: 'sql.duckdb', suiteql: 'sql.ansi' }
const DIALECT_FIXUP: Record<string, (sql: string) => string> = {
  // SuiteQL/Oracle: no LIMIT — it uses `FETCH FIRST n ROWS ONLY` (with an optional leading `OFFSET m ROWS`).
  suiteql: (sql) => sql.replace(/\bLIMIT\s+(\d+)(?:\s+OFFSET\s+(\d+))?/gi, (_m, n, off) => (off ? `OFFSET ${off} ROWS ` : '') + `FETCH FIRST ${n} ROWS ONLY`),
}
// prqlc runs as a WASM module (prql-js). A specific input can make the Rust compiler PANIC, which POISONS the
// WASM instance — every LATER compile then throws "memory access out of bounds"/"unreachable" until the process
// restarts (a single-point wedge for the whole data path). This is an upstream prqlc bug, not our code. We make
// it SELF-HEAL: prql_js.js builds a fresh WebAssembly.Instance on each require, so dropping it from the CJS cache
// and re-requiring gives a clean instance + clean memory. Compiles are SYNCHRONOUS (serialized on the JS thread),
// so nothing is ever mid-flight in the instance when we swap it — safe even under many concurrent users.
const _require = createRequire(import.meta.url)
const loadPrqlCompile = (): ((s: string) => string) => {
  const m: any = _require('prql-js')
  const c = m.compile ?? m.default?.compile
  if (typeof c !== 'function') throw new Error('prql-js: no compile() export')
  return c
}
let _prqlCompileFn = loadPrqlCompile()
const reloadPrqlCompiler = () => { try { delete _require.cache[_require.resolve('prql-js')] } catch { /* ignore */ }; _prqlCompileFn = loadPrqlCompile() }
// A poisoned-instance/panic signature — NOT a normal PRQL syntax error (which must propagate unchanged).
const isWasmFault = (msg: string) => /out of bounds|unreachable|RuntimeError|recursive use|table index|null function|memory access|\bwasm\b/i.test(String(msg))
// Compile with self-healing: on a WASM fault, LOG the offending PRQL (so we can capture + report the trigger),
// re-instantiate, and retry ONCE. If the SAME input faults again it reliably crashes prqlc → reset for the NEXT
// query and reject THIS one clearly, so a bad input can never wedge the compiler for everyone else.
const _prqlCompile = (src: string): string => {
  try { return _prqlCompileFn(src) }
  catch (e: any) {
    if (!isWasmFault(e?.message ?? '')) throw e
    console.error('[manager] prqlc WASM FAULT — re-instantiating compiler. Offending PRQL:\n' + src + '\n' + (e?.message ?? e))
    reloadPrqlCompiler()
    try { return _prqlCompileFn(src) }
    catch (e2: any) {
      if (isWasmFault(e2?.message ?? '')) reloadPrqlCompiler()   // input reliably crashes prqlc → reset so the NEXT query is clean
      throw new Error('this query crashed the PRQL compiler (upstream prqlc bug on this input) — rephrase the pipeline: ' + (e2?.message ?? e2))
    }
  }
}
// Result caps for AGENT queries — a runaway/unbounded query must not dump a whole table (192K rows would
// overwhelm the bridge WS AND the UI, which shows hundreds at most). MAX_ROWS is enforced AT THE SOURCE (a `take`
// appended to the PRQL, so the DB returns no more) — a no-op for aggregations, only bites a raw row list.
// MAX_BYTES is a secondary guard for very wide rows. The trusted raw path (grounding/introspect) is exempt.
const MAX_ROWS = Number(process.env.ICA_MAX_ROWS ?? 5000)
const MAX_BYTES = Number(process.env.ICA_MAX_BYTES ?? 8_000_000)
// Compile an AGENT query, which MUST be a PRQL pipeline — this is the access-control chokepoint where row/tenant
// filters get injected before compilation. There is NO SQL-keyword allow-list: raw SQL simply fails to compile
// as PRQL and is rejected with a clear message. Trusted SYSTEM reads (introspect/grounding) never come here —
// they use POST /query {raw:true}, which skips compilation entirely. So the split is by PATH, not by string shape.
function compilePrql(prql: string, dialect?: string): string {
  const target = PRQL_TARGET[dialect ?? ''] ?? 'sql.ansi'   // unknown source → standard ANSI (safest, most portable)
  const hasHeader = /^\s*prql\s+target:/.test(prql)
  const body = hasHeader ? prql.replace(/^\s*prql\s+target:[^\n]*\n?/, '') : prql
  // A whole-query raw-SQL escape (`s"…SELECT…"`) is opaque and would bypass filter injection — reject it with a
  // targeted message. A scoped `s"…"`/`f"…"` fragment INSIDE a pipeline is fine (the pipeline still starts `from`).
  if (/^\s*s"/.test(body)) throw new Error('whole-query raw SQL is not allowed here — write a PRQL pipeline (start with `from …`); use s"…" only for a specific expression inside it')
  // Hard row cap at the source: append `take MAX_ROWS` so the DB never returns more (protects the bridge WS + UI).
  // A no-op for aggregations; if the agent already `take`s fewer, the smaller wins. Only an unbounded list is capped.
  const src = (hasHeader ? prql : `prql target:${target}\n${prql}`) + `\ntake ${MAX_ROWS}`
  try {
    let sql = String(_prqlCompile(src)).replace(/\n?-- Generated by PRQL.*$/s, '').trim()
    const fixup = dialect ? DIALECT_FIXUP[dialect] : undefined   // bridge the target→source dialect gap (e.g. suiteql LIMIT→FETCH FIRST)
    if (fixup) sql = fixup(sql)
    return sql
  } catch (e: any) {
    // Bare SQL (SELECT/WITH/EXEC/…) doesn't parse as PRQL → this is where it's caught, no keyword list needed.
    throw new Error('query must be a PRQL pipeline (start with `from …`), not raw SQL: ' + (e?.message ?? e))
  }
}

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
      // Agent path (default): the query text is PRQL → compile to the source dialect. Trusted SYSTEM path
      // (introspect/grounding, via {raw:true}): run the SQL as-is. This is the access-control boundary — only the
      // raw path may pass raw SQL, and the agent can't reach it. `sql` (the executed SQL) is returned for visibility.
      const sql = body.raw ? String(body.sql) : compilePrql(body.sql, bridge.dialect)
      const rows = await bridge.query(sql, body.params ?? {})
      // Byte guard for wide rows (the row cap is already enforced in the PRQL for the agent path). Raw/system reads are exempt.
      if (!body.raw) { const bytes = JSON.stringify(rows).length; if (bytes > MAX_BYTES) return send(res, 413, { error: `result too large (${(bytes / 1e6).toFixed(1)} MB) — add a filter or aggregate` }) }
      return send(res, 200, { rows, sql })
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
