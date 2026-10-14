// The engine's side of the agent runner (runner-main.ts; docs/connectors-plan.md, step 1e). Where the engine runs as root
// with an agent user named (SA_AGENT_USER — the Docker image's `sa-agent`), every agent session lives in the runner: a
// child process started as that user, with an allow-listed environment and the model-only key, never the engine's. A
// session here is a stand-in with the same interface: what it shows is mirrored from the runner, what is asked of it is
// sent there. A runner that stops is started again; sessions it held are made again (resumed by their harness id).

import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Session, RunHandlers, RunResult, AgentEvent, TokenUsage } from './session.js'
import type { Harness, SessionOpts, UsageSink } from './index.js'
import { agentUser } from '../agent-user.js'
import { childEnv } from '../child-env.js'

/** Run sessions in the runner? Only the engine, as root, with an agent user to run them as. */
export const useRunner = (): boolean => !!agentUser && !process.env.SA_IN_RUNNER

let child: ChildProcess | null = null
let sink: UsageSink | null = null
export function setRunnerUsageSink(s: UsageSink | null) { sink = s }

type Mirror = { busy: boolean; sessionId?: string; buffer: string; events?: AgentEvent[]; raw: Set<(d: string) => void> }
const mirrors = new Map<string, Mirror>()
const made = new Map<string, { harness: Harness; opts: SessionOpts }>()
const runs = new Map<string, { h?: RunHandlers; resolve: (r: RunResult) => void; reject: (e: Error) => void }>()
const calls = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

/** The runner's environment: what any process needs, the platform's address, the model-only key, the agents' settings. */
export function runnerEnv(): Record<string, string> {
  const pass: Record<string, string | undefined> = { SA_IN_RUNNER: '1', SA_MODEL_KEY: process.env.SA_MODEL_KEY, SUPERATOM_PLATFORM: process.env.SUPERATOM_PLATFORM, ICA_PROJECT: process.env.ICA_PROJECT, HOME: process.env.HOME, IS_SANDBOX: process.env.IS_SANDBOX, DISABLE_AUTOUPDATER: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' }
  for (const [k, v] of Object.entries(process.env)) if ((k.startsWith('ICA_') && k !== 'ICA_KEY') || k.startsWith('OPENCODE_')) pass[k] = v
  return childEnv(pass)
}

function runner(): ChildProcess {
  if (child && child.connected) return child
  const c = fork(fileURLToPath(new URL('./runner-main.ts', import.meta.url)), [], {
    uid: agentUser!.uid, gid: agentUser!.gid, env: runnerEnv(), execArgv: process.execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  })
  child = c
  console.log(`[ica] agent runner started as ${agentUser!.name} (pid ${c.pid})`)
  c.on('message', onMessage)
  c.on('exit', (code, signal) => {
    if (child === c) child = null
    console.warn(`[ica] agent runner stopped (${signal ?? code}) — its sessions are made again on their next use`)
    for (const [rid, r] of runs) { runs.delete(rid); r.reject(new Error('the agent runner stopped mid-turn')) }
    for (const [cid, r] of calls) { calls.delete(cid); r.reject(new Error('the agent runner stopped')) }
    for (const sid of mirrors.keys()) needsMaking.add(sid)
  })
  return c
}
const needsMaking = new Set<string>()
let lastReady: { uid?: number; engineKey?: boolean; managerKey?: boolean } | null = null
/** What the runner said of itself when it started (its OS user, whether it holds a key it must not). */
export const runnerSaid = () => lastReady
/** The runner's process id, while one runs. */
export const runnerPid = (): number | undefined => (child?.connected ? child.pid : undefined)

function onMessage(m: any) {
  if (m.t === 'state') { const x = mirrors.get(m.sid); if (x) Object.assign(x, { busy: m.busy, sessionId: m.sessionId, buffer: m.buffer ?? '', events: m.events }); return }
  if (m.t === 'raw') { for (const cb of mirrors.get(m.sid)?.raw ?? []) { try { cb(m.d) } catch { /* a listener's own problem */ } } return }
  if (m.t === 'usage') { sink?.report(m.u); return }
  if (m.t === 'h') { const r = runs.get(m.rid); const f = (r?.h as any)?.[m.name]; if (typeof f === 'function') { try { f(...m.args) } catch { /* a handler's own problem */ } } return }
  if (m.t === 'ran') { const r = runs.get(m.rid); if (!r) return; runs.delete(m.rid); m.error ? r.reject(new Error(m.error)) : r.resolve(m.result); return }
  if (m.t === 'called') { const r = calls.get(m.cid); if (!r) return; calls.delete(m.cid); m.error ? r.reject(new Error(m.error)) : r.resolve(m.result); return }
  if (m.t === 'error') console.warn(`[ica] agent runner: ${m.error}`)
  if (m.t === 'hello') { lastReady = m; if (m.engineKey || m.managerKey) console.error('[ica] THE AGENT RUNNER HOLDS AN ENGINE KEY — it must not; agents are not kept apart') }
}

/** Made (again) in the runner when it does not hold it: a runner that restarted resumes the harness session by its id. */
function ensureMade(sid: string) {
  const c = runner()
  if (!needsMaking.has(sid)) return c
  const spec = made.get(sid)!
  const resumeId = mirrors.get(sid)?.sessionId ?? spec.opts.resumeId
  c.send({ t: 'create', sid, harness: spec.harness, opts: { ...spec.opts, ...(resumeId ? { resumeId } : {}) } })
  needsMaking.delete(sid)
  return c
}

const call = (sid: string, m: string, args: unknown[] = []) => new Promise<unknown>((resolve, reject) => {
  const cid = randomUUID(); calls.set(cid, { resolve, reject })
  ensureMade(sid).send({ t: 'call', sid, cid, m, args })
})

/** A session in the runner, as a Session here. kind, turnEnd and where the reference goes are known from the harness and
 *  its options (the runner confirms them; they are read at once by callers). */
export function remoteSession(harness: Harness, opts: SessionOpts): Session {
  const sid = randomUUID()
  made.set(sid, { harness, opts }); mirrors.set(sid, { busy: false, buffer: '', raw: new Set() }); needsMaking.add(sid)
  const ref = opts.systemReference?.trim() && !opts.noTools ? 'in-context' : 'file'
  const turn = (t: 'run' | 'compact', prompt: string | undefined, h?: RunHandlers) => new Promise<RunResult>((resolve, reject) => {
    const rid = randomUUID()
    runs.set(rid, { h, resolve, reject })
    const want = (['onOutput', 'onEvent', 'onNarration', 'onAnswer', 'onUsage'] as const).filter((k) => typeof h?.[k] === 'function')
    const c = ensureMade(sid)
    mirrors.get(sid)!.busy = true
    c.send({ t, sid, rid, prompt, h: { forSession: h?.forSession, forPerson: h?.forPerson, doneWhen: !!h?.doneWhen, want } })
    // "Is the deliverable here?" is answered on this side (it reads the engine's files) and told to the runner once true.
    if (h?.doneWhen) {
      const tick = setInterval(async () => {
        if (!runs.has(rid)) return clearInterval(tick)
        try { if (await h.doneWhen!()) { clearInterval(tick); child?.send({ t: 'done', rid }) } } catch { /* a check that throws is not an answer */ }
      }, 250)
      tick.unref?.()
    }
  })
  return {
    kind: harness === 'claude-code-pty' ? 'pty' : harness === 'codex' ? 'events' : undefined,
    referencePlacement: harness === 'claude-code-pty' ? (opts.systemReference?.trim() ? 'in-context' : 'file') : harness === 'codex' ? (opts.systemReference ? 'in-context' : 'file') : ref,
    turnEnd: harness === 'claude-code-pty' ? 'inferred' : 'native',
    run: (prompt, h) => turn('run', prompt, h),
    compact: (h) => turn('compact', undefined, h),
    warmup: async () => { await call(sid, 'warmup') },
    input: (data) => { void call(sid, 'input', [data]).catch(() => {}) },
    onRaw: (cb) => { const m = mirrors.get(sid)!; m.raw.add(cb); return () => m.raw.delete(cb) },
    reset: () => { void call(sid, 'reset').catch(() => {}) },
    buffer: () => mirrors.get(sid)?.buffer ?? '',
    events: () => mirrors.get(sid)?.events ?? [],
    busy: () => mirrors.get(sid)?.busy ?? false,
    stop: () => { if (!needsMaking.has(sid)) void call(sid, 'stop').catch(() => {}) },
    resize: (cols, rows) => { void call(sid, 'resize', [cols, rows]).catch(() => {}) },
    sessionId: () => mirrors.get(sid)?.sessionId,
  }
}
