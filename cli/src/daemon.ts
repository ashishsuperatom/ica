// The connection that stays: a small background process per key holds the project's WebSocket, so a command does not
// connect and disconnect each time. Commands talk to it over a local socket in a directory only its owner can enter
// (named by a hash of key and hub, never the key). It connects on the first request, reconnects after a drop on the
// next one, and exits after an hour with no command — each command resets the hour. `sacli disconnect` ends it now.
//
// One JSON line each way per command:  → { op, … }   ← { type: 'event', m }…  ← { type: 'done', m } | { type: 'error', message, code }

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, appendFileSync } from 'node:fs'
import { createConnection, createServer, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { configPath, CliError } from './config.ts'
import { connect, type Hub } from './hub.ts'

export const IDLE_MS = 60 * 60_000
/** However busy, a background connection never lives longer than this; the next command starts a fresh one. */
export const MAX_LIFE_MS = 24 * 60 * 60_000

export interface Conn {
  project: { id: string; name?: string }
  request(payload: Record<string, unknown>, opts?: { timeoutMs?: number; until?: { t: string; qid: string }; onEvent?: (m: any) => void }): Promise<any>
  close(): void
}

const runDir = (env: NodeJS.ProcessEnv) => join(dirname(configPath(env)), 'run')
const idOf = (key: string, hub: string) => createHash('sha256').update(`${hub}\n${key}`).digest('hex').slice(0, 16)
export function socketPath(key: string, hub: string, env: NodeJS.ProcessEnv): string {
  const id = idOf(key, hub)
  return process.platform === 'win32' ? `\\\\.\\pipe\\sacli-${id}` : join(runDir(env), `${id}.sock`)
}

/** One command's exchange with the daemon. */
function exchange(path: string, msg: Record<string, unknown>, onEvent?: (m: any) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path)
    let buf = '', settled = false
    const end = (f: () => void) => { if (!settled) { settled = true; f(); s.end() } }
    s.on('connect', () => s.write(JSON.stringify(msg) + '\n'))
    s.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let r: any; try { r = JSON.parse(line) } catch { continue }
        if (r.type === 'event') onEvent?.(r.m)
        else if (r.type === 'done') end(() => resolve(r.m))
        else if (r.type === 'error') end(() => reject(new CliError(r.message, r.code ?? 1)))
      }
    })
    s.on('error', (e: any) => end(() => reject(e)))
    s.on('close', () => end(() => reject(new CliError('the background connection ended without an answer', 4))))
  })
}

/** Is a daemon listening for this key? */
export async function daemonStatus(key: string, hub: string, env: NodeJS.ProcessEnv): Promise<any | null> {
  try { return await exchange(socketPath(key, hub, env), { op: 'status' }) } catch { return null }
}

/** The daemon for this key — started if it is not running — as a connection. */
export async function viaDaemon(o: { key: string; hub: string; env: NodeJS.ProcessEnv; script: string; timeoutMs: number }): Promise<Conn> {
  const path = socketPath(o.key, o.hub, o.env)
  // No daemon is a failure to reach the socket; a daemon's refusal (a revoked key, the hub unreachable) is an answer.
  const ask = () => exchange(path, { op: 'hello' }).catch((e) => { if (e instanceof CliError) throw e; return null })
  let hello = await ask()
  if (!hello) {
    if (process.platform !== 'win32') mkdirSync(runDir(o.env), { recursive: true, mode: 0o700 })
    const child = spawn(process.execPath, [o.script, '__daemon'], {
      detached: true, stdio: 'ignore',
      // The key goes to the child in its environment, never on its command line (which others can list).
      env: { ...o.env, SACLI_DAEMON_KEY: o.key, SACLI_DAEMON_HUB: o.hub, SACLI_DAEMON_SOCKET: path },
    })
    child.unref()
    const t0 = Date.now()
    while (!hello) {
      if (Date.now() - t0 > 10_000) throw new CliError('the background connection did not start (see the log in the run directory, or use --no-daemon)', 4)
      await new Promise((r) => setTimeout(r, 50))
      hello = await ask()
    }
  }
  return {
    project: hello.project,
    request: (payload, opts = {}) => exchange(path, { op: 'request', payload, timeoutMs: opts.timeoutMs ?? 120_000, ...(opts.until ? { until: opts.until } : {}) }, opts.onEvent),
    close: () => {},
  }
}

export async function stopDaemon(key: string, hub: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try { await exchange(socketPath(key, hub, env), { op: 'stop' }); return true } catch { return false }
}

/** The daemon itself: `sacli __daemon`, started by viaDaemon. */
export async function serveDaemon(env: NodeJS.ProcessEnv): Promise<void> {
  const key = env.SACLI_DAEMON_KEY!, hubUrl = env.SACLI_DAEMON_HUB!, path = env.SACLI_DAEMON_SOCKET!
  const idleMs = Number(env.SACLI_IDLE_MS) || IDLE_MS
  const maxLifeMs = Number(env.SACLI_MAX_LIFE_MS) || MAX_LIFE_MS
  const log = (s: string) => { try { appendFileSync(path.replace(/\.sock$/, '.log'), `${new Date().toISOString()} ${s}\n`) } catch { /* no log */ } }
  let hub: Hub | null = null, connecting: Promise<Hub> | null = null
  const startedAt = new Date().toISOString()
  let lastUsed = Date.now(), connectedAt: string | null = null
  const ensure = async () => {
    if (hub) return hub
    connecting ??= connect({ key, hub: hubUrl, log }).then((h) => {
      hub = h; connectedAt = new Date().toISOString(); log(`connected to ${h.project.id}`)
      h.on((m) => { if (m.t === '__closed') hub = null })
      return h
    }).finally(() => { connecting = null })
    return connecting
  }
  let timer = setTimeout(() => shutdown('idle'), idleMs)
  const lifeTimer = setTimeout(() => shutdown('reached its lifetime limit'), maxLifeMs)
  const touch = () => { lastUsed = Date.now(); clearTimeout(timer); timer = setTimeout(() => shutdown('idle'), idleMs) }
  const server = createServer((s: Socket) => {
    let buf = ''
    s.on('data', async (d) => {
      buf += d
      const i = buf.indexOf('\n'); if (i < 0) return
      const line = buf.slice(0, i); buf = ''
      const send = (r: unknown) => { try { s.write(JSON.stringify(r) + '\n') } catch { /* gone */ } }
      let msg: any; try { msg = JSON.parse(line) } catch { return send({ type: 'error', message: 'not JSON', code: 2 }) }
      try {
        if (msg.op === 'status') return send({ type: 'done', m: { pid: process.pid, startedAt, connectedAt, connected: !!hub, idleLeftMs: Math.max(0, idleMs - (Date.now() - lastUsed)) } })
        if (msg.op === 'stop') { send({ type: 'done', m: { stopped: true } }); return shutdown('asked') }
        touch()
        const h = await ensure()
        if (msg.op === 'hello') return send({ type: 'done', m: { project: h.project } })
        if (msg.op === 'request') {
          if (msg.until) {
            // A question: its narration as events, finished by its answer.
            const off = h.on((m) => {
              if (m.qid !== msg.until.qid) return
              if (m.t === msg.until.t) { off(); send({ type: 'done', m }) } else send({ type: 'event', m })
            })
            h.request(msg.payload, { timeoutMs: msg.timeoutMs }).catch((e) => { if (!/no reply/.test(e.message)) { off(); send({ type: 'error', message: e.message, code: e.code }) } })
            return
          }
          const r = await h.request(msg.payload, { timeoutMs: msg.timeoutMs })
          return send({ type: 'done', m: r })
        }
        send({ type: 'error', message: `unknown op ${msg.op}`, code: 2 })
      } catch (e: any) {
        // A dropped connection is reopened by the next command.
        if (e?.code === 4 || e?.code === 3) { try { hub?.close() } catch { /* */ } hub = null }
        send({ type: 'error', message: e?.message ?? String(e), code: e?.code ?? 1 })
      }
    })
  })
  // Everything it holds goes when it stops, whatever the reason: the hub connection, the listening socket and its
  // file, the timers — then the process itself, even if something is still pending.
  let stopping = false
  function shutdown(why: string, code = 0) {
    if (stopping) return
    stopping = true
    log(`stopping (${why})`)
    clearTimeout(timer); clearTimeout(lifeTimer)
    try { hub?.close() } catch { /* */ }
    try { server.close() } catch { /* */ }
    if (process.platform !== 'win32') try { rmSync(path, { force: true }) } catch { /* */ }
    setTimeout(() => process.exit(code), 100)
  }
  process.on('uncaughtException', (e) => { log(`crashed: ${e?.stack ?? e}`); shutdown('crashed', 1) })
  process.on('unhandledRejection', (e: any) => { log(`crashed: ${e?.stack ?? e}`); shutdown('crashed', 1) })
  if (process.platform !== 'win32' && existsSync(path)) rmSync(path, { force: true })   // a stale socket from a crash
  server.listen(path, () => log(`listening (idle limit ${Math.round(idleMs / 60000)} min)`))
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => shutdown(sig))
  server.on('error', (e: any) => { log(`the socket failed: ${e?.message ?? e}`); shutdown('socket failed', 1) })
}
