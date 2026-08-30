// ⚠️  TEST-ONLY LOCAL HUB — NEVER production. Stands in for the Cloudflare Durable Object so a developer can drive
// the engine end-to-end on localhost with no cloud, no auth, no key. The engine reaches it ONLY because the test
// env sets ICA_HUB=ws://localhost:5174; production sets ICA_HUB=wss://superatom.site and never loads this file.
// It binds 127.0.0.1 exclusively and refuses anything else. If this runs anywhere but a laptop, something is wrong.
//
// Protocol (mirrors just enough of the DO): the engine connects to /_ws/<project>?key=..., sends {type:'hello',
// role:'code-engine'}; we reply {payload:{t:'welcome'}}. The engine then sends {type:'ready'|'heartbeat'|...} and,
// per question, {to, payload} emit-frames (answer/narration/logs). Our test client sends {type:'client-hello'}
// then {payload:{t:'analyse',...}}; we wrap it with a `from` and forward to the engine, and relay every engine
// emit-frame back to the client.
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.TEST_HUB_PORT || 5174)
const log = (...a) => console.log('[test-hub]', ...a)

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT })   // loopback ONLY — never 0.0.0.0
let engine = null
const clients = new Set()

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()) } catch { return }

    // ── engine handshake + lifecycle ───────────────────────────────────────
    if (m.type === 'hello' && m.role === 'code-engine') {
      engine = ws; log('engine registered')
      ws.send(JSON.stringify({ payload: { t: 'welcome', wsId: 'test-engine' } }))
      return
    }
    if (m.type === 'ready')     { log('engine READY —', m.detail); for (const c of clients) c.send(JSON.stringify({ payload: { t: 'engine:ready', detail: m.detail } })); return }
    if (m.type === 'not_ready') { log('engine NOT READY —', m.detail); for (const c of clients) c.send(JSON.stringify({ payload: { t: 'engine:not_ready', detail: m.detail } })); return }
    if (m.type === 'heartbeat' || m.type === 'bye') return

    // ── test client handshake ──────────────────────────────────────────────
    if (m.type === 'client-hello') { clients.add(ws); log('test client connected'); if (engine) ws.send(JSON.stringify({ payload: { t: 'engine:ready', detail: 'engine already up' } })); return }

    // ── engine → client (emit-frames: answer / narration / logs) ───────────
    if (m.payload && ws === engine) { for (const c of clients) { try { c.send(JSON.stringify(m)) } catch {} } return }

    // ── client → engine (wrap with a `from`, forward as-is) ────────────────
    if (m.payload && ws !== engine) {
      if (!engine) { log('no engine connected — dropping client message'); return }
      engine.send(JSON.stringify({ from: { id: 'test-client', type: 'runtime' }, payload: m.payload }))
      return
    }
  })
  ws.on('close', () => { if (ws === engine) { engine = null; log('engine disconnected') } else clients.delete(ws) })
  ws.on('error', () => {})
})

wss.on('listening', () => log(`listening on ws://127.0.0.1:${PORT}  (TEST-ONLY — never production)`))
process.on('SIGTERM', () => { try { wss.close() } catch {} process.exit(0) })
process.on('SIGINT',  () => { try { wss.close() } catch {} process.exit(0) })
