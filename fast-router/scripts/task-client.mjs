// Exercise the generic machine-to-machine task protocol against the deployed fast-router: connect as
// a 'runtime', fire classify + ner tasks (each with a reqId) to { type:'fast-router' }, print results.
// The model is loaded ONCE in the worker — every task here just queues onto that warm instance.
//   node scripts/task-client.mjs
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync(new URL('../fast-router.local.json', import.meta.url), 'utf8'))
const ws = new WebSocket(`${cfg.hubHost}/_ws/${cfg.id}?key=${cfg.key}`)

const TASKS = [
  { t: 'classify', reqId: 'c1', text: 'My internet has been down for three days and nobody will help me.', labels: ['billing issue', 'technical problem', 'cancellation', 'refund request', 'general inquiry'] },
  { t: 'classify', reqId: 'c2', text: 'The delivery was fast but the product quality was disappointing.', labels: ['positive', 'negative', 'neutral'], multiLabel: true },
  { t: 'classify', reqId: 'c3', text: 'URGENT: production database is down and customers cannot check out.', labels: ['critical', 'high', 'normal', 'low'] },
  { t: 'ner', reqId: 'n1', text: 'Tim Cook announced in Cupertino that Apple will report earnings on May 2.', labels: ['person', 'organization', 'location', 'date'] },
  { t: 'ner', reqId: 'n2', text: 'The patient was given 500mg of amoxicillin for a throat infection and reported nausea.', labels: ['drug', 'dosage', 'symptom', 'condition'] },
]
const pending = new Set(TASKS.map(t => t.reqId))
const sentAt = {}
const pct = v => `${(v * 100).toFixed(0)}%`

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', key: cfg.key, role: 'runtime' })))
ws.on('message', (raw) => {
  const p = JSON.parse(raw.toString()).payload
  if (p?.t === 'welcome') { console.log('connected — firing', TASKS.length, 'tasks to the warm model\n'); for (const task of TASKS) { sentAt[task.reqId] = Date.now(); ws.send(JSON.stringify({ to: { type: 'fast-router' }, payload: task })) } return }
  if (p?.t === 'classify:result') {
    const rt = Date.now() - sentAt[p.reqId]
    const s = Object.entries(p.scores).sort((a, b) => b[1] - a[1])
    console.log(`[classify ${p.reqId}]  ▸ ${p.top.label} ${pct(p.top.score)}   (compute ${p.ms}ms · roundtrip ${rt}ms)`)
    console.log('   ' + s.map(([k, v]) => `${k} ${pct(v)}`).join('  ·  ') + '\n'); done(p.reqId)
  }
  if (p?.t === 'ner:result') {
    const rt = Date.now() - sentAt[p.reqId]
    console.log(`[ner ${p.reqId}]  (compute ${p.ms}ms · roundtrip ${rt}ms)`)
    console.log('   ' + p.entities.map(e => `${e.text}=${e.label}(${pct(e.score)})`).join('   ') + '\n'); done(p.reqId)
  }
  if (p?.t === 'task:error') { console.log(`[error ${p.reqId}] ${p.error}\n`); done(p.reqId) }
})
function done(id) { pending.delete(id); if (pending.size === 0) { ws.close(); process.exit(0) } }
setTimeout(() => { console.error('timeout, still pending:', [...pending]); process.exit(1) }, 40000)
