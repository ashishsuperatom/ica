// A CONNECTION IN ITS OWN PROCESS (docs/connectors-plan.md step 4): the manager's stand-in for a connection whose
// connector runs in host.mjs, a child process of its own. It has the Bridge's shape, so the rest of the manager is
// unchanged: each call goes to the process and its answer comes back. A process that stops is started again — after 1 s,
// then 2, 5, 10, 30 — and its connection loaded again with the same settings; one that stops five times in five minutes is
// left stopped (a crash loop), the connection failed with why, until it is loaded again on purpose.

import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const HOST = fileURLToPath(new URL('./host.mjs', import.meta.url))
const BACKOFF = [1_000, 2_000, 5_000, 10_000, 30_000]
const LOOP = { stops: 5, withinMs: 5 * 60_000 }
const TIMEOUT: Record<string, number> = { query: 180_000, introspect: 600_000, test: 35_000, append: 180_000 }

/** What a host process may be given: what any process needs — never the manager's key or anyone else's secrets. */
function hostEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['PATH', 'HOME', 'TZ', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']) if (process.env[k] !== undefined) out[k] = process.env[k]!
  return out
}

export interface HostedState { pid: number | null; state: 'starting' | 'running' | 'restarting' | 'failed'; restarts: number; lastError: string | null }

export async function hosted(id: string, path: string, config: { settings: Record<string, unknown>; secrets: Record<string, string> }, dataDir: string, log: (s: string) => void) {
  let child: ChildProcess | null = null
  let about: { kind: string; dialect?: string; description?: string; testable: boolean; appends: boolean } | null = null
  let ready = false, closed = false
  const st: HostedState = { pid: null, state: 'starting', restarts: 0, lastError: null }
  const stops: number[] = []
  const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  let loadedOnce: ((v: unknown) => void) | null = null, loadFailed: ((e: Error) => void) | null = null

  const errorOf = (e: any) => Object.assign(new Error(String(e?.message ?? e)), { code: e?.code ?? undefined, transient: e?.transient ?? undefined })
  function start(): Promise<void> {
    const c = fork(HOST, [], { env: hostEnv(), execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    child = c; st.pid = c.pid ?? null; st.state = 'starting'
    c.on('message', (m: any) => {
      if (m?.t === 'loaded') {
        if (m.error) { st.lastError = m.error.message; loadFailed?.(errorOf(m.error)); loadFailed = loadedOnce = null; return }
        about = m.about; ready = !!m.ready; st.state = 'running'; loadedOnce?.(undefined); loadFailed = loadedOnce = null
        return
      }
      if (m?.t === 'answer') { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); if (typeof m.ready === 'boolean') ready = m.ready; m.error ? p.reject(errorOf(m.error)) : p.resolve(m.value); return }
      if (m?.t === 'ready') { ready = !!m.ready; return }
      if (m?.t === 'warn') log(`[datasource] ${id}: ${m.message}`)
    })
    c.on('exit', (code, signal) => {
      if (child === c) child = null
      for (const [k, p] of pending) { pending.delete(k); clearTimeout(p.timer); p.reject(Object.assign(new Error(`its process stopped (${signal ?? `exit ${code}`}) — it is started again`), { transient: true })) }
      if (closed) return
      ready = false
      const now = Date.now(); stops.push(now); while (stops.length && now - stops[0] > LOOP.withinMs) stops.shift()
      st.lastError = `its process stopped (${signal ?? `exit ${code}`})`
      if (stops.length >= LOOP.stops) { st.state = 'failed'; st.lastError = `its process stopped ${stops.length} times in ${LOOP.withinMs / 60_000} minutes — left stopped; load it again once fixed`; log(`[datasource] ${id}: ${st.lastError}`); return }
      const wait = BACKOFF[Math.min(st.restarts, BACKOFF.length - 1)]
      st.state = 'restarting'; st.restarts++
      log(`[datasource] ${id}: ${st.lastError}; starting it again in ${wait / 1000}s`)
      setTimeout(() => { if (!closed) void start().catch((e) => log(`[datasource] ${id} did not start again: ${e.message}`)) }, wait).unref?.()
    })
    const loaded = new Promise<void>((resolve, reject) => { loadedOnce = resolve as any; loadFailed = reject })
    c.send({ t: 'load', id, path, config, dataDir })
    return loaded
  }
  const call = (op: string, args: unknown[] = []) => new Promise<any>((resolve, reject) => {
    if (!child || st.state !== 'running') return reject(Object.assign(new Error(st.state === 'failed' ? st.lastError ?? 'it has failed' : 'its process is starting again — try again in a moment'), { transient: st.state !== 'failed' }))
    const k = randomUUID()
    const timer = setTimeout(() => { pending.delete(k); reject(Object.assign(new Error(`it did not answer ${op} in ${(TIMEOUT[op] ?? 60_000) / 1000}s`), { transient: true })) }, TIMEOUT[op] ?? 60_000)
    pending.set(k, { resolve, reject, timer })
    child.send({ t: 'call', id: k, op, args })
  })

  await start()   // throws when its connector does not load
  const a = about!
  return {
    bridge: {
      id, kind: a.kind, dialect: a.dialect, description: a.description,
      ready: () => ready && st.state === 'running',
      query: (sql: string, params?: Record<string, unknown>) => call('query', [sql, params ?? {}]),
      introspect: () => call('introspect'),
      ...(a.testable ? { test: () => call('test') } : {}),
      ...(a.appends ? { append: (table: string, rows: Record<string, unknown>[]) => call('append', [table, rows]) } : {}),
      // what the connector says of a failure travels with it; otherwise the manager's own reading
      isTransient: (e: any) => (typeof e?.transient === 'boolean' ? e.transient : /(\b50[234]\b|\b429\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|timed? ?out|temporarily unavailable)/i.test(String(e?.message ?? e))),
      close: () => { closed = true; const c = child; child = null; try { c?.send({ t: 'close' }) } catch { /* gone */ } setTimeout(() => { try { c?.kill('SIGKILL') } catch { /* gone */ } }, 2_000).unref?.() },
    },
    state: (): HostedState => ({ ...st }),
  }
}
