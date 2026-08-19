// TotalGroup bridge — owns the WebSocket to the remote DB and answers query()/introspect().
// It is loaded IN-PROCESS by the datasource-manager (no HTTP server, no port of its own). The
// manager routes query('totalgroup', …) here; this file is the only thing that knows the remote.
//
// DEPENDENCY-FREE: uses Node's built-in global WebSocket (Node ≥ 22) + node:crypto — no `ws` package.
// That keeps this a plain project file (lives under vm/projects/<project>/datasources/, never in the
// engine image). Secrets live in a gitignored .env beside this file (SA_WS_URL / SA_PROJECT_ID / SA_API_KEY).

import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

try { process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url))) } catch {}

const WS_URL     = process.env.SA_WS_URL     || 'wss://ws.superatom.ai/websocket'
const PROJECT_ID = process.env.SA_PROJECT_ID || ''
const API_KEY    = process.env.SA_API_KEY    || ''
const QUERY_TIMEOUT_MS   = 60_000
const RECONNECT_DELAY_MS = 3_000

// ── T-SQL param binding: replace @name with a safe literal (kept here — dialect-specific) ──
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`bad numeric param: ${v}`); return String(v) }
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (v instanceof Date) return `'${v.toISOString()}'`
  return `'${String(v).replace(/'/g, "''")}'`
}
const bind = (sql, params = {}) =>
  sql.replace(/@(\w+)/g, (w, n) => Object.prototype.hasOwnProperty.call(params, n) ? lit(params[n]) : w)

// ── one persistent WS to the remote DB bridge (built-in WebSocket, browser-style events) ─────
export function createBridge() {
  let ws = null, wsReady = false
  const pending = new Map()   // id -> { resolve, reject, timer }

  function connect() {
    const params = new URLSearchParams({ projectId: PROJECT_ID, type: 'data-agent' })
    if (API_KEY) params.set('apiKey', API_KEY)
    ws = new WebSocket(`${WS_URL}?${params}`)
    ws.binaryType = 'arraybuffer'   // so binary frames arrive as ArrayBuffer (sync-decodable), not a Blob
    ws.addEventListener('open', () => console.log('[totalgroup] ws connected'))
    ws.addEventListener('message', (ev) => {
      // The `ws` package delivered Buffers (.toString worked for text+binary); the built-in WebSocket gives
      // a string for text frames and an ArrayBuffer for binary — decode both to a UTF-8 string.
      const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)
      let msg; try { msg = JSON.parse(raw) } catch { return }
      if (msg.type === 'connected' && msg.payload?.clientId) { wsReady = true; console.log(`[totalgroup] ws ready (${msg.payload.clientId})`); return }
      const w = pending.get(msg.id); if (!w) return
      if (['query-result', 'tables-result', 'schema-result'].includes(msg.type)) { clearTimeout(w.timer); pending.delete(msg.id); w.resolve(msg.payload) }
      else if (msg.type === 'query-error') { clearTimeout(w.timer); pending.delete(msg.id); w.reject(new Error(msg.payload?.error || 'query-error')) }
    })
    ws.addEventListener('close', (ev) => {
      const code = ev?.code
      wsReady = false; console.log(`[totalgroup] ws closed (${code}) — reconnecting in ${RECONNECT_DELAY_MS}ms`)
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error(`socket closed (${code})`)) }
      pending.clear(); setTimeout(connect, RECONNECT_DELAY_MS)
    })
    ws.addEventListener('error', (ev) => console.error('[totalgroup] ws error:', ev?.message ?? 'error'))
  }

  function request(type, payload) {
    return new Promise((resolve, reject) => {
      if (!wsReady || ws?.readyState !== WebSocket.OPEN) return reject(new Error('totalgroup ws not ready'))
      const id = crypto.randomUUID()
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`totalgroup timeout after ${QUERY_TIMEOUT_MS}ms`)) }, QUERY_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, type, to: { type: 'db-bridge' }, from: { type: 'data-agent' }, payload }))
    })
  }

  const rows = (p) => p?.rows ?? p?.data ?? p?.recordset ?? (Array.isArray(p) ? p : [])

  connect()

  return {
    id: 'totalgroup',
    kind: 'sql',                 // sql | rest | file | json — the query paradigm
    dialect: 'mssql',            // for kind=sql: mssql | postgres | duckdb | sqlite …
    description: 'Microsoft SQL Server (T-SQL). Use TOP n (not LIMIT), [brackets] for identifiers, GETDATE().',
    ready: () => wsReady,

    async query(sql, params = {}) {
      return rows(await request('query', { sql: bind(sql, params) }))
    },

    async introspect() {
      const cols = rows(await request('query', {
        sql: `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE
              FROM INFORMATION_SCHEMA.COLUMNS
              ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      }))
      const byTable = new Map()
      for (const c of cols) {
        const name = `${c.TABLE_SCHEMA}.${c.TABLE_NAME}`
        if (!byTable.has(name)) byTable.set(name, { name, columns: [] })
        byTable.get(name).columns.push({ name: c.COLUMN_NAME, type: c.DATA_TYPE })
      }
      return { id: 'totalgroup', kind: 'sql', dialect: 'mssql', tables: [...byTable.values()] }
    },

    close() { try { ws?.close() } catch {} },
  }
}
