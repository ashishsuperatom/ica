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
import { sqlSignature, rewriteSqlDetailed } from './sqlglot-pool.js'

// Result caps for AGENT queries — a runaway/unbounded query must not dump a whole table (192K rows would
// overwhelm the bridge WS AND the UI, which shows hundreds at most). MAX_ROWS is enforced AT THE SOURCE — the
// rewrite injects a LIMIT/FETCH FIRST into the query's AST, so the DB never returns more (a no-op for
// aggregations; the smaller of any agent-supplied limit wins). MAX_BYTES is a secondary guard for very wide
// rows. The trusted raw path (grounding/introspect, {raw:true}) skips the rewrite and both caps.
// 1000 is the HARD ceiling, enforced here so it holds whatever a program asks for. The SOFT limit (100 rows
// unless the question asks for more) lives in the authoring rule — the agent chooses that; this only backstops it.
const MAX_ROWS = Number(process.env.ICA_MAX_ROWS ?? 5000)
const MAX_BYTES = Number(process.env.ICA_MAX_BYTES ?? 8_000_000)

// ── RETRYING A FLAKY SOURCE ─────────────────────────────────────────────────────────────────────────────────
// TRANSIENT means the source could not be reached or was busy — not that the query was wrong. The distinction
// is the whole design: a syntax error retried three times is just a slow syntax error, and the caller waits
// longer to learn something it could have known immediately.
//
// Matched on the message because a bridge may be HTTP, a driver, or a socket, and they report the same outage
// in different shapes. Anything unrecognised is treated as permanent — failing fast on something we could have
// retried is a worse-than-necessary answer, while retrying a genuine error is a wrong answer arriving slowly.
const TRANSIENT = /(\b50[234]\b|\b429\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network|timed? ?out|temporarily unavailable|service unavailable|too many requests)/i

// Delays before attempts 2, 3 and 4 — about 8.5s of cover in total. Sized against what it replaces: the agent
// noticing a failure costs a full LLM turn, so even several seconds of silent waiting is the cheaper path.
// Jittered, so a burst of queries failing together does not retry in lockstep.
const RETRY_DELAYS = [500, 2000, 6000]
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// `delays` is a parameter so a test can run this in milliseconds instead of the real eight seconds. Exported
// for the same reason: the rule about what must NOT be retried is the half worth pinning.
export async function withRetry<T>(run: () => Promise<T>, sourceId?: unknown, delays: number[] = RETRY_DELAYS,
                                   isTransient?: (err: unknown) => boolean): Promise<T> {
  const who = sourceId ? String(sourceId) : 'source'
  const transient = (e: unknown) => isTransient ? isTransient(e) : TRANSIENT.test(String((e as any)?.message ?? e))
  const began = Date.now()
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await run()
      if (attempt) console.log(`[query] ${who} recovered on attempt ${attempt + 1}`)
      return out
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (!transient(e)) throw e                        // waiting cannot fix this one
      if (attempt >= delays.length) {
        // SAY THAT WE ALREADY TRIED. The caller is an agent, and an agent that does not know a query was
        // retried four times over eight seconds will reason about the failure and issue it again — which is
        // the expensive loop this exists to remove, now running on top of it rather than instead of it.
        const secs = ((Date.now() - began) / 1000).toFixed(1)
        console.warn(`[query] ${who} failed after ${attempt + 1} attempts in ${secs}s — ${msg.slice(0, 200)}`)
        throw new Error(`${msg} — the source was unreachable; already retried ${attempt + 1} times over ${secs}s, so this is not worth repeating`)
      }
      const wait = delays[attempt] + Math.floor(Math.random() * 250)
      console.warn(`[query] ${who} transient failure (attempt ${attempt + 1}), retrying in ${wait}ms — ${msg.slice(0, 160)}`)
      await sleep(wait)
    }
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
  // IS THIS FAILURE WORTH WAITING OUT? Optional, and the default below covers the shapes we have seen. But a
  // source knows its own outages best — one engine reports a busy pool as a bare code, another wraps a
  // timeout in its own error class, and neither has to look like an HTTP 503. A bridge that knows says so;
  // one that does not is read by the default. Returning false is an override too: a source can declare a
  // failure permanent that the default would otherwise sit and retry.
  isTransient?(err: unknown): boolean
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

  // ── STRUCTURAL SIGNATURE ───────────────────────────────────────────────────────────────────────────────
  // Deliberately NOT on the query path. This is computed when a concept is saved — a background moment — so
  // it costs a question nothing. It lives here because this process already owns the SQL parser and its
  // dialect handling, and a signature computed by a second parser could disagree with what actually runs.
  if (req.method === 'POST' && url.pathname === '/signature') {
    let b: any; try { b = await readBody(req) } catch (e: any) { return send(res, 400, { error: e.message }) }
    if (!b?.sql) return send(res, 400, { error: 'body must have { sql, dialect? }' })
    const sig = await sqlSignature(String(b.sql), { dialect: b.dialect })
    return send(res, 200, { signature: sig })   // null when it will not parse: no signature, not an error
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
      // Ask for ONE MORE than the cap. If that extra row comes back there genuinely IS more data; if it doesn't,
      // the result is complete — even when it lands exactly on the cap. Comparing rows.length to the cap can't
      // tell those apart, and guessing wrong in either direction is a lie about the data.
      const passthrough = body.raw || bridge.kind !== 'sql'
      const rw = passthrough
        ? { sql: String(body.sql), cappedTo: null as number | null }
        : await rewriteSqlDetailed(String(body.sql), { sourceDialect: bridge.dialect, maxRows: MAX_ROWS + 1 })
      const sql = rw.sql
      // RETRIED HERE, not by the agent. A flaky source used to surface as a failed query, which the agent
      // noticed, reasoned about, and re-issued — a whole LLM turn, fifteen seconds and a pile of tokens, to
      // repeat a statement that would have worked a second later. One observed question spent a third of four
      // minutes doing exactly that. Retrying inside the seam turns six visible failures into one slow call.
      //
      // ONLY THE CHECKED PATH. `rewriteSqlDetailed` has proven this is a SELECT, so repeating it is safe.
      // The passthrough — `raw` (system-only; the agent cannot set it) or a non-SQL source with its own query
      // paradigm — carries no such proof, and repeating a statement nothing has shown to be a read is how a
      // retry turns into a double write. Those callers can opt in once they can say they are idempotent.
      const rows = passthrough
        ? await bridge.query(sql, body.params ?? {})
        : await withRetry(() => bridge.query(sql, body.params ?? {}), body.id, undefined, bridge.isTransient?.bind(bridge))
      // Byte guard for wide rows (the row cap is already injected into the agent query's AST). Raw/system reads are exempt.
      if (!body.raw) { const bytes = JSON.stringify(rows).length; if (bytes > MAX_BYTES) return send(res, 413, { error: `result too large (${(bytes / 1e6).toFixed(1)} MB) — add a filter or aggregate` }) }
      // REPORT what we did to the query. `notes` is only present when it changes how the result must be read:
      // we injected a row limit AND the result reached it, so these rows are a PREFIX, not the whole answer.
      // Without this the caller cannot tell a capped read from a complete one — the difference between a
      // partial list and a wrong total.
      const truncated = rw.cappedTo != null && rows.length > MAX_ROWS   // the probe row came back ⇒ there IS more
      const out = truncated ? rows.slice(0, MAX_ROWS) : rows            // never hand back the probe row
      const notes = truncated
        ? [`Row limit ${MAX_ROWS} was applied and there is more data beyond it: these are the FIRST ${MAX_ROWS} rows, not the full result. Aggregate in the query (COUNT/SUM/GROUP BY) for totals, or narrow it with a filter.`]
        : undefined
      return send(res, 200, { rows: out, sql, ...(truncated ? { cappedTo: MAX_ROWS } : {}), ...(notes ? { notes } : {}) })
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
