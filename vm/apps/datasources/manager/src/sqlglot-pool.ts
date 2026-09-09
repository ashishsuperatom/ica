// SQLGlot rewrite pool — the Node side of the SQL access seam.
//
// Every AGENT query flows through here: parse → SELECT-only allow-list →
// our per-dialect hooks → authorization inject → row cap → render to the source dialect. The heavy lifting is in
// Python (sqlrewrite/worker.py, vendored SQLGlot); this module owns the PROCESS lifecycle so it satisfies three
// requirements at once:
//
//   • CONCURRENT, no mutual waiting — a POOL of worker processes (separate processes sidestep Python's GIL, so
//     N agents rewrite truly in parallel). A checkout hands each request a free worker.
//   • NO IDLE MEMORY — workers spawn LAZILY on first use and the whole pool is REAPED after IDLE_MS with no
//     traffic. Next request re-spawns. Nothing sits resident while no one is asking.
//   • ATTACHED lifecycle — workers are children of THIS (manager) process. On manager exit / SIGINT / SIGTERM
//     they are killed. pm2 stop, `docker stop`, Fly machine stop → the manager dies → the Python children die.
//     No separate supervisor, no extra pm2 entry.

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKER_PY = join(HERE, '..', 'sqlrewrite', 'worker.py')
const PYTHON = process.env.PYTHON ?? process.env.PYTHON_BIN ?? 'python3'
const MAX_WORKERS = Math.max(1, Number(process.env.SQLGLOT_WORKERS ?? 4))
// Keep a FLOOR of warm workers so a query after an idle spell is never cold (~80ms). The floor is pre-warmed at
// boot and the reaper never drops below it; only the workers spun up ABOVE the floor under load get reaped. One
// worker ≈ 40-60MB resident — the standing cost of never cold-starting. Set 0 to reap to nothing (pure lazy).
const MIN_WORKERS = Math.max(0, Math.min(Number(process.env.SQLGLOT_MIN_WORKERS ?? 1), MAX_WORKERS))
const IDLE_MS = Math.max(5_000, Number(process.env.SQLGLOT_IDLE_MS ?? 120_000))

export type RewriteOpts = {
  read?: string          // dialect the agent wrote in (our source-dialect name, e.g. 'mssql' | 'suiteql')
  write?: string         // dialect to render to (defaults to read — same source)
  sourceDialect?: string // the source's dialect name, used by the per-dialect hooks
  policies?: unknown[]    // authorization predicates injected server-side (empty for now)
  maxRows?: number        // hard row cap injected as LIMIT/FETCH FIRST
  allowWrites?: boolean   // default false = READ-ONLY (reject writes). A future action-taking source/request sets true.
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void }
type Worker = { proc: ChildProcess; buf: string; pending: Map<number, Pending>; alive: boolean }

let workers: Worker[] = []
const idle: Worker[] = []
const waiters: Array<(w: Worker) => void> = []
let seq = 0
let reapTimer: ReturnType<typeof setTimeout> | null = null

function spawnWorker(): Worker {
  const proc = spawn(PYTHON, [WORKER_PY], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  })
  const w: Worker = { proc, buf: '', pending: new Map(), alive: true }
  proc.stdout!.setEncoding('utf8')
  proc.stdout!.on('data', (chunk: string) => {
    w.buf += chunk
    let nl: number
    while ((nl = w.buf.indexOf('\n')) >= 0) {
      const line = w.buf.slice(0, nl).trim()
      w.buf = w.buf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try { msg = JSON.parse(line) } catch { continue }
      const p = w.pending.get(msg.id)
      if (p) { w.pending.delete(msg.id); p.resolve(msg) }
    }
  })
  proc.stderr!.setEncoding('utf8')
  proc.stderr!.on('data', (d: string) => { if (d.trim()) console.error('[sqlrewrite] ' + d.trimEnd()) })
  const die = () => {
    if (!w.alive) return
    w.alive = false
    for (const p of w.pending.values()) p.reject(new Error('sqlrewrite worker exited'))
    w.pending.clear()
    workers = workers.filter((x) => x !== w)
    const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1)
  }
  proc.on('exit', die)
  proc.on('error', (e) => { console.error('[sqlrewrite] spawn error:', e.message); die() })
  workers.push(w)
  return w
}

function acquire(): Promise<Worker> {
  if (reapTimer) { clearTimeout(reapTimer); reapTimer = null }
  const w = idle.pop()
  if (w && w.alive) return Promise.resolve(w)
  if (workers.length < MAX_WORKERS) return Promise.resolve(spawnWorker())
  return new Promise((resolve) => waiters.push(resolve))
}

function release(w: Worker): void {
  if (!w.alive) return
  const next = waiters.shift()
  if (next) { next(w); return }
  idle.push(w)
  // Whole pool quiet AND above the warm floor → arm the idle reaper (unref'd so it never keeps the process
  // alive). At the floor there is nothing to reap, so don't even arm the timer.
  if (!reapTimer && idle.length === workers.length && workers.length > MIN_WORKERS) {
    reapTimer = setTimeout(reap, IDLE_MS)
    reapTimer.unref?.()
  }
}

function reap(): void {
  reapTimer = null
  if (waiters.length) return
  // Fires only when the pool is fully idle. Keep MIN_WORKERS warm; kill the load-driven surplus above the floor.
  const survivors = workers.slice(0, MIN_WORKERS)
  const dead = workers.slice(MIN_WORKERS)
  workers = survivors; idle.length = 0
  for (const w of survivors) idle.push(w)
  for (const w of dead) { w.alive = false; try { w.proc.kill('SIGTERM') } catch { /* already gone */ } }
}

async function once(w: Worker, req: any): Promise<any> {
  const id = ++seq
  return await new Promise((resolve, reject) => {
    w.pending.set(id, { resolve, reject })
    const ok = w.proc.stdin!.write(JSON.stringify({ ...req, id }) + '\n')
    if (!ok) { /* backpressure: the drain will flush; response still arrives */ }
  })
}

/** Rewrite an agent SQL query: transpile to the source dialect, enforce SELECT-only, inject policies + row cap.
 *  Returns the final SQL string. Throws with the worker's message on a parse/policy/forbidden error. */
// Returns the rewritten SQL AND what we changed that the caller must know about: `cappedTo` is the row limit we
// injected (null when the caller's own limit already fit). An unreported cap is indistinguishable from "that is
// all the data", which turns a truncated read into a confidently wrong total — so it always travels back.
export async function rewriteSqlDetailed(sql: string, opts: RewriteOpts = {}): Promise<{ sql: string; cappedTo: number | null }> {
  const req = {
    op: 'rewrite',
    sql,
    read: opts.read ?? opts.sourceDialect,
    write: opts.write ?? opts.read ?? opts.sourceDialect,
    source_dialect: opts.sourceDialect ?? opts.read,
    policies: opts.policies ?? [],
    maxRows: opts.maxRows ?? 0,
    allowWrites: opts.allowWrites ?? false,   // read-only unless the caller explicitly opts in
  }
  let attempt = 0
  for (;;) {
    const w = await acquire()
    try {
      const msg = await once(w, req)
      release(w)
      if (!msg.ok) throw new Error(String(msg.error || 'sql rewrite failed'))
      return { sql: String(msg.sql), cappedTo: msg.cappedTo == null ? null : Number(msg.cappedTo) }
    } catch (e: any) {
      // A dead worker (crash/exit) is retried ONCE on a fresh one; a real rewrite error (msg.ok=false) is rethrown.
      if (w.alive) { release(w); throw e }
      if (++attempt > 1) throw new Error('sqlrewrite worker unavailable: ' + (e?.message ?? e))
    }
  }
}

/** The STRUCTURAL signature of a query: what it measures, from where, under which conditions, and — kept
 *  separate — the axis it groups by. A similarity key for spotting one measure written several times, never
 *  an identity: two queries can compute the same thing with different shapes and no structural hash catches
 *  that. Runs on the same warm pool as the rewrite, but off the question path — signatures are computed when
 *  a concept is SAVED, not when anyone asks something. */
export interface SqlSignature {
  core: { measures: string[]; base: string | null; filters: string[] }
  coreHash: string
  dimension: string[]
  timeFilters: string[]
  joins: string[]
}

export async function sqlSignature(sql: string, opts: { dialect?: string } = {}): Promise<SqlSignature | null> {
  const w = await acquire()
  try {
    const msg = await once(w, { op: 'signature', sql, dialect: opts.dialect })
    release(w)
    // A body whose SQL will not parse is not a failure worth propagating — a concept can be perfectly good
    // and still hold a fragment, or a dialect this cannot read. No signature simply means no cluster.
    if (!msg.ok) return null
    return { core: msg.core, coreHash: msg.coreHash, dimension: msg.dimension, timeFilters: msg.timeFilters, joins: msg.joins }
  } catch {
    if (w.alive) release(w)
    return null
  }
}

/** Kill the whole pool now (idempotent). Wired to manager shutdown so children never outlive the parent. */
export function shutdownPool(): void {
  if (reapTimer) { clearTimeout(reapTimer); reapTimer = null }
  const dead = workers.slice()
  workers = []; idle.length = 0; waiters.length = 0
  for (const w of dead) { w.alive = false; try { w.proc.kill('SIGKILL') } catch { /* gone */ } }
}

// Attach lifecycle: whatever ends this process ends the children too.
for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { shutdownPool(); if (sig !== 'exit') process.exit(0) })
}

// Pre-warm the floor at boot: a floor of N means N are ALWAYS resident — including the first query, which is
// therefore never cold. (MIN_WORKERS=0 → no floor, pure lazy spawn.)
for (let i = 0; i < MIN_WORKERS; i++) idle.push(spawnWorker())

/** SQL only — for callers that don't care what was rewritten. */
export async function rewriteSql(sql: string, opts: RewriteOpts = {}): Promise<string> {
  return (await rewriteSqlDetailed(sql, opts)).sql
}
