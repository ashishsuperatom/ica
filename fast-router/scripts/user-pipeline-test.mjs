// Simulate the BROWSER: connect as a runtime to the real project DO (shared key), send a `suggest`
// to the code-engine exactly as the UI does, and see if suggestions come back through sa-engine.
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const KEY = readFileSync('/tmp/frkey.txt', 'utf8').trim()
const PROJECT_DO = process.argv[2] || (() => { console.error('usage: node scripts/user-pipeline-test.mjs <projectId>'); process.exit(1) })()
const ws = new WebSocket(`wss://superatom.site/_ws/${PROJECT_DO}?key=${KEY}`)
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', key: KEY, role: 'runtime' })))
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.payload?.t === 'welcome') {
    console.log('✅ connected to project DO as runtime:', m.payload.wsId)
    ws.send(JSON.stringify({ to: { type: 'code-engine' }, payload: {
      t: 'suggest', projectId: PROJECT_DO, inputId: 'pipe-test', seq: 1, text: process.argv[3] || 'total revenue last year',
    } }))
    console.log(`→ sent suggest to code-engine ("${process.argv[3] || 'total revenue last year'}")`)
  }
  if (m.payload?.t === 'suggestions') {
    const p = m.payload
    console.log(`\n✅ SUGGESTIONS came back through sa-engine (intent=${p.intent?.intent}):`)
    ;(p.items || []).forEach(it => console.log('   •', it.question, `(${Math.round(it.score * 100)}%)`))
    ws.close(); process.exit(0)
  }
  if (m.payload?.t === 'error') console.log('hub error:', m.payload)
})
ws.on('error', e => { console.log('ws error:', e.message); process.exit(1) })
setTimeout(() => { console.log('❌ TIMEOUT — no suggestions came back (relay not working)'); process.exit(1) }, 15000)
