// THE AGENT RUNNER — every agent's harness (pi, the claude PTY, codex, opencode) in one process apart from the engine,
// started by it as another OS user with an allow-listed environment (docs/connectors-plan.md, step 1e). It holds no
// engine key: models are reached with the model-only key, data with the tickets the engine leaves beside each turn.
// The engine drives it over the IPC channel (runner.ts): sessions are made, run, typed into and stopped by message;
// every callback a turn makes comes back as a message.

process.env.SA_IN_RUNNER = '1'   // createSession here runs the harness in this process (it never asks a runner)

import { createSession, setUsageSink, type Harness, type SessionOpts, type Session, type RunHandlers } from './index.js'
import { fetchBoxCredentials } from './box-credentials.js'

type In =
  | { t: 'create'; sid: string; harness: Harness; opts: SessionOpts }
  | { t: 'run' | 'compact'; sid: string; rid: string; prompt?: string; h: { forSession?: string; forPerson?: string; doneWhen?: boolean; want: string[] } }
  | { t: 'done'; rid: string }
  | { t: 'call'; sid: string; cid: string; m: 'warmup' | 'input' | 'reset' | 'stop' | 'resize' | 'drop'; args: unknown[] }

const send = (msg: Record<string, unknown>) => { try { process.send?.(msg) } catch { /* the engine is gone; it will start another runner */ } }
const sessions = new Map<string, Session>()
const done = new Set<string>()

// What a session shows (its rolling text, its events, whether it is busy, its harness id), pushed when it changes —
// at most every 250ms — so the engine answers those questions at once, as if the session were its own.
const lastState = new Map<string, string>()
function pushState(sid: string) {
  const s = sessions.get(sid); if (!s) return
  const st = { busy: s.busy(), sessionId: s.sessionId?.(), buffer: s.buffer(), events: s.events?.() }
  const k = JSON.stringify(st); if (lastState.get(sid) === k) return
  lastState.set(sid, k); send({ t: 'state', sid, ...st })
}
setInterval(() => { for (const sid of sessions.keys()) pushState(sid) }, 250).unref()

setUsageSink({ report: (u) => send({ t: 'usage', u }) })

process.on('message', async (m: In) => {
  try {
    if (m.t === 'create') {
      const s = createSession(m.harness, m.opts)
      sessions.set(m.sid, s)
      s.onRaw?.((d) => send({ t: 'raw', sid: m.sid, d }))
      send({ t: 'created', sid: m.sid, kind: s.kind, referencePlacement: s.referencePlacement, turnEnd: s.turnEnd })
      pushState(m.sid)
      return
    }
    if (m.t === 'done') { done.add(m.rid); return }
    if (m.t === 'run' || m.t === 'compact') {
      const s = sessions.get(m.sid); if (!s) return send({ t: 'ran', rid: m.rid, error: 'the agent session is gone — it will be made again' })
      const fwd = (name: string) => m.h.want.includes(name) ? (...args: unknown[]) => send({ t: 'h', rid: m.rid, name, args }) : undefined
      const h: RunHandlers = {
        onOutput: fwd('onOutput') as RunHandlers['onOutput'], onEvent: fwd('onEvent') as RunHandlers['onEvent'],
        onNarration: fwd('onNarration') as RunHandlers['onNarration'], onAnswer: fwd('onAnswer') as RunHandlers['onAnswer'],
        onUsage: fwd('onUsage') as RunHandlers['onUsage'],
        ...(m.h.doneWhen ? { doneWhen: () => done.has(m.rid) } : {}),
        forSession: m.h.forSession, forPerson: m.h.forPerson,
      }
      try {
        const r = m.t === 'run' ? await s.run(m.prompt ?? '', h) : await s.compact(h)
        pushState(m.sid); send({ t: 'ran', rid: m.rid, result: r })
      } catch (e: any) { pushState(m.sid); send({ t: 'ran', rid: m.rid, error: e?.message ?? String(e) }) }
      finally { done.delete(m.rid) }
      return
    }
    if (m.t === 'call') {
      const s = sessions.get(m.sid)
      if (m.m === 'drop') { try { s?.stop() } catch { /* already stopped */ } sessions.delete(m.sid); lastState.delete(m.sid); return send({ t: 'called', cid: m.cid }) }
      if (!s) return send({ t: 'called', cid: m.cid, error: 'the agent session is gone' })
      const f = (s as any)[m.m]
      const out = typeof f === 'function' ? await f.apply(s, m.args) : undefined
      pushState(m.sid); send({ t: 'called', cid: m.cid, result: out ?? null })
    }
  } catch (e: any) {
    send({ t: 'error', error: e?.message ?? String(e) })
  }
})

// The credentials this box's agents run on (the Claude login, …), fetched from the platform's vault with the model-only
// key — the same route the engine used, which takes that key.
// Who it runs as, and that it holds no engine key — for the engine's log and the image's isolation check.
send({ t: 'hello', uid: process.getuid?.(), engineKey: !!process.env.ICA_KEY, managerKey: !!process.env.SA_MANAGER_KEY })
void fetchBoxCredentials().then((c) => send({ t: 'ready', missing: c.missing }), () => send({ t: 'ready', missing: [] }))
process.on('disconnect', () => process.exit(0))   // the engine went away: so do its agents
