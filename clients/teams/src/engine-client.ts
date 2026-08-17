// The shared runtime handshake — identical to what cloudflare/user-ui does, just
// in Node instead of the browser. A surface connects to the hub as a `runtime`
// peer and asks the code-engine a question:
//
//   1. open   wss://<hub>/_ws/<projectId>?token=<jwt>
//   2. hello  { type: "hello", token, role: "runtime" }
//   3. ask    { to: { type: "code-engine" }, payload: { t: "analyse", ... } }
//   4. recv   envelopes; resolve on payload.t === "analyst:answer"
//
// One WS per question (simple + robust: a suspended engine wakes on the message,
// and we tolerate that via `onWaking`). A production surface may keep the socket
// open and multiplex; this scaffold favours clarity.

import { WebSocket } from 'ws'
import { config } from './config.js'

export type EngineAnswer = {
  status?: string
  category?: string
  answer?: string
  period?: string
  figures?: Array<{ label: string; display: string; sub?: string }>
  table?: { columns: string[]; rows: any[][]; totalRows?: number; total?: any[] }
  [k: string]: unknown
}

export type AskOpts = {
  question: string
  sessionId: string
  /** Called if the engine machine is suspended and is being woken (so the caller can keep the user informed). */
  onWaking?: () => void
  /** Called on each interim status line from the analyst (optional progress). */
  onStatus?: (text: string) => void
  /** Hard cap. The analyst can take minutes on a fresh build; default 6 min. */
  timeoutMs?: number
}

/** Ask the engine one question and resolve with the final answer. Rejects on error/timeout. */
export function askEngine(opts: AskOpts): Promise<{ category?: string; answer: EngineAnswer }> {
  const { question, sessionId, onWaking, onStatus, timeoutMs = 6 * 60_000 } = opts
  if (!config.projectId) return Promise.reject(new Error('SA_PROJECT_ID is not set'))

  // v1: authenticate as an adapter with the project API key (sk-proj-…). The DO also accepts a per-user JWT
  // (?token=…); we'll switch to that once the platform token exists (docs/identity-and-access.md).
  const cred = config.engineKey
    ? `key=${encodeURIComponent(config.engineKey)}`
    : `token=${encodeURIComponent(config.engineToken)}`
  const url = `${config.hubWs}/_ws/${config.projectId}?${cred}`
  const hello = config.engineKey
    ? { type: 'hello', key: config.engineKey, role: 'runtime' }
    : { type: 'hello', token: config.engineToken, role: 'runtime' }
  const qid = randomId()

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    let settled = false
    // Keepalive: a suspended engine can take ~20-30s to wake, during which almost nothing flows on this
    // socket — long enough for an intermediary to drop it (seen as a 1006 close). A periodic ping frame keeps
    // the connection alive through the wake gap and any quiet stretch of a long analyst build.
    let ping: ReturnType<typeof setInterval> | null = setInterval(() => { try { ws.ping() } catch { /* not open */ } }, 15_000)
    const done = (fn: () => void) => {
      if (settled) return; settled = true
      clearTimeout(timer); if (ping) { clearInterval(ping); ping = null }
      try { ws.close() } catch { /* already closing */ }
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error('engine timed out'))), timeoutMs)

    ws.on('open', () => {
      ws.send(JSON.stringify(hello))
      ws.send(JSON.stringify({
        to: { type: 'code-engine' },
        payload: { t: 'analyse', question, projectId: config.projectId, role: 'user', sessionId, questionId: qid },
      }))
    })

    ws.on('message', (raw) => {
      let msg: any
      try { msg = JSON.parse(raw.toString()) } catch { return }
      // The hub wraps engine → client messages in an envelope; the browser reads `payload`. Tolerate both.
      const p = msg?.payload ?? msg
      switch (p?.t) {
        case 'tick': return                                  // liveness ping
        case 'machine:waking': onWaking?.(); return          // engine was suspended; it's coming up
        case 'analyst:status': onStatus?.(p.text); return
        case 'analyst:answer':
          return done(() => resolve({ category: p.category, answer: (p.answer ?? {}) as EngineAnswer }))
        case 'error':
          return done(() => reject(new Error(p.message ?? 'engine error')))
      }
    })

    ws.on('error', (err) => done(() => reject(err)))
    ws.on('close', (code, reasonBuf) => {
      const reason = reasonBuf?.length ? reasonBuf.toString() : ''
      // Surface the hub's close code/reason — e.g. 4001 "Invalid JWT" (bad/absent credential),
      // 4003 "Not a member of this project" — so auth failures are legible, not "closed".
      done(() => reject(new Error(`connection closed before an answer (code ${code}${reason ? `: ${reason}` : ''})`)))
    })
  })
}

function randomId(): string {
  // No Date.now()/Math.random() constraints here (plain Node); crypto is cleanest.
  return (globalThis.crypto?.randomUUID?.() ?? `q-${Date.now()}-${Math.floor(Math.random() * 1e9)}`)
}
