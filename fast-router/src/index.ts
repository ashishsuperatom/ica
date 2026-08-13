// fast-router entrypoint. One process, ONE WS connection to this fast-router's own DO (role
// 'fast-router'), serving every project whose code-engine dials the same DO as a 'runtime'.
// The main thread carries NO model — it holds the WS and hands each task to a pool of worker
// threads (FR_WORKERS), each of which owns a warm model and runs on its own core.

import { loadConfig } from './config.js'
import { HubConnection } from './hub.js'
import { Pool } from './pool.js'

const cfg = loadConfig()

if (!cfg.id || !cfg.key) {
  console.error('[fast-router] missing config: set FR_ID + FR_KEY (or fast-router.local.json) — see README.')
  process.exit(1)
}

console.log(`[fast-router] hub=${cfg.hubHost} id=${cfg.id} workers=${cfg.workers}`)

const pool = new Pool(cfg.workers, new URL('./worker-boot.mjs', import.meta.url))
console.log(`[fast-router] warming ${cfg.workers} worker(s)…`)
await pool.ready()
console.log(`[fast-router] ${cfg.workers} worker(s) warm`)

const conn = new HubConnection(cfg, {
  onSuggest: async (msg, reply) => {
    try { const out = await pool.run(msg); if (out) reply(out) }   // null = stale (superseded seq) → no reply
    catch (e) { console.error('[fast-router] suggest failed:', (e as Error).message) }
  },
  onIngest: (msg) => { pool.run(msg).catch((e) => console.error('[fast-router] ingest failed:', e.message)) },
  onClassify: async (msg, reply) => {
    try { reply(await pool.run(msg)) } catch (e) { reply({ t: 'task:error', reqId: msg.reqId, error: (e as Error).message }) }
  },
  onNer: async (msg, reply) => {
    try { reply(await pool.run(msg)) } catch (e) { reply({ t: 'task:error', reqId: msg.reqId, error: (e as Error).message }) }
  },
})
conn.start()

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { console.log(`[fast-router] ${sig} — exiting`); conn.stop(); process.exit(0) })
}
