// Measure TRUE end-to-end round-trip latency (client SEND → client RECEIVE) against the deployed
// fast-router over the real hub, and split it into worker-compute vs network. Sequential (one query
// at a time, waits for each reply) so the serial inference queue never overlaps the measurements.
//   node scripts/latency-test.mjs           (default queries, projectId=totalgroup)
//   PROJECT=<id> node scripts/latency-test.mjs "query one" "query two"
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync(new URL('../fast-router.local.json', import.meta.url), 'utf8'))
const PROJECT = process.env.PROJECT || 'totalgroup'
const QUERIES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'vendors on the dahej udaipur lane', 'overdue invoices in raipur',
  'who grew but is paying slower', 'solar customers revenue', 'total revenue last year',
]
const WARMUP = 2
const queue = [...Array(WARMUP).fill('__warm__'), ...QUERIES]
const ws = new WebSocket(`${cfg.hubHost}/_ws/${cfg.id}?key=${cfg.key}`)
let idx = 0, seq = 0, tSend = 0
const results = []
function send() {
  if (idx >= queue.length) return finish()
  seq++; tSend = Date.now()
  const text = queue[idx] === '__warm__' ? 'warmup ' + seq : queue[idx]
  ws.send(JSON.stringify({ to: { type: 'fast-router' }, payload: { t: 'suggest', projectId: PROJECT, userId: 'lat', inputId: 'lat-' + seq, seq, text } }))
}
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', key: cfg.key, role: 'runtime' })))
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.payload?.t === 'welcome') { console.log(`connected to ${cfg.hubHost} — ${WARMUP} warmup then ${QUERIES.length} measured\n`); return send() }
  if (m.payload?.t === 'suggestions') {
    const e2e = Date.now() - tSend, p = m.payload
    if (queue[idx] !== '__warm__') results.push({ q: queue[idx], e2e, compute: p.ms ?? 0 })
    idx++; send()
  }
})
function finish() {
  console.log('query'.padEnd(40) + '   e2e   compute  network')
  results.forEach(r => console.log(r.q.slice(0, 38).padEnd(40) + (r.e2e + 'ms').padStart(6) + (r.compute + 'ms').padStart(9) + ((r.e2e - r.compute) + 'ms').padStart(9)))
  const avg = a => Math.round(a.reduce((x, y) => x + y, 0) / a.length)
  console.log('\naverage:   e2e ' + avg(results.map(r => r.e2e)) + 'ms    compute ' + avg(results.map(r => r.compute)) + 'ms    network ' + avg(results.map(r => r.e2e - r.compute)) + 'ms')
  ws.close(); process.exit(0)
}
setTimeout(() => { console.error('timeout'); process.exit(1) }, 60000)
