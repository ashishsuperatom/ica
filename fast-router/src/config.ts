// How this worker reaches its OWN fast-router DO.
//
// fast-router is itself a "project" in the same DO system: it has its own projectId (one per
// fast-router instance). This worker opens ONE WS to that DO as role 'fast-router'. The code-engines
// of every real project dial into the SAME DO as role 'runtime' (using the shared key), and the DO
// relays their `suggest` messages here. So a single worker serves many projects over one connection;
// which project a message is for comes from the message payload (`projectId`), not the connection.
//
// Config source (first that exists wins):
//   1. env FR_HUB_HOST / FR_ID / FR_KEY
//   2. ./fast-router.local.json  (gitignored — holds the shared key for local dev)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export interface Config {
  hubHost: string   // e.g. wss://superatom.site  (no trailing slash)
  id: string        // the fast-router's OWN projectId (selects its DO)
  key: string       // shared key for this fast-router DO (same key every runtime uses); NEVER commit
  workers: number   // size of the inference worker pool (FR_WORKERS env). Each worker = one model + one core.
}

const HERE = dirname(fileURLToPath(import.meta.url))

export function loadConfig(): Config {
  let file: Partial<Config> = {}
  try { file = JSON.parse(readFileSync(join(HERE, '..', 'fast-router.local.json'), 'utf8')) } catch { /* optional */ }

  const hubHost = (process.env.FR_HUB_HOST || file.hubHost || 'wss://superatom.site').replace(/\/+$/, '')
  const id = process.env.FR_ID || file.id || ''
  const key = process.env.FR_KEY || file.key || ''
  // Default 1 worker: ~165ms/task, plenty for occasional use. Bump FR_WORKERS on a bigger box for
  // throughput (see the pool experiment in memory — this 2-core/8GB box tops out at ~2-3 workers).
  const workers = Math.max(1, parseInt(process.env.FR_WORKERS || '', 10) || (file as any).workers || 1)
  return { hubHost, id, key, workers }
}

// The DO WS URL — same scheme every server-side client dials (see cloudflare fly.ts):
//   wss://<host>/_ws/<fastRouterId>?key=<sharedKey>
// (The key is re-sent in the `hello` message, which is where the DO actually validates it.)
export function hubUrl(cfg: Config): string {
  return `${cfg.hubHost}/_ws/${encodeURIComponent(cfg.id)}?key=${encodeURIComponent(cfg.key)}`
}
