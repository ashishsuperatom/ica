// Burst-load test: fire N tasks AT ONCE and see how the worker's serial inference queue behaves —
// does every task come back (integrity), what's the throughput, and how does latency spread as tasks
// wait their turn in the queue.
//   node scripts/throughput-test.mjs [N=50] [ner|classify]
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync(new URL('../fast-router.local.json', import.meta.url), 'utf8'))
const N = parseInt(process.argv[2] || '50', 10)
const KIND = process.argv[3] || 'ner'
const cities = ['Delhi', 'Mumbai', 'Chennai', 'Bangalore', 'Pune', 'Goa', 'Jaipur', 'Kolkata', 'Hyderabad', 'Ahmedabad']
const days = ['Friday', 'Monday', 'next Tuesday', 'December 25th', 'tomorrow', 'next week']
const nerLabels = ['origin', 'destination', 'date', 'passenger count', 'cabin class']
const clsLabels = ['booking', 'cancellation', 'general inquiry', 'complaint']
const q = (i) => `book a flight from ${cities[i % cities.length]} to ${cities[(i * 3 + 1) % cities.length]} on ${days[i % days.length]} for ${1 + (i % 4)} people`

const ws = new WebSocket(`${cfg.hubHost}/_ws/${cfg.id}?key=${cfg.key}`)
const sentAt = {}, compute = [], roundtrip = []
let done = 0, t0 = 0
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { min: s[0], max: s[s.length - 1], avg: Math.round(s.reduce((x, y) => x + y, 0) / s.length), p50: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)] } }

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', key: cfg.key, role: 'runtime' })))
ws.on('message', (raw) => {
  const p = JSON.parse(raw.toString()).payload
  if (p?.t === 'welcome') {
    console.log(`firing ${N} '${KIND}' tasks in one burst…`)
    t0 = Date.now()
    for (let i = 0; i < N; i++) {
      const reqId = 't' + i; sentAt[reqId] = Date.now()
      const payload = KIND === 'classify'
        ? { t: 'classify', reqId, text: q(i), labels: clsLabels }
        : { t: 'ner', reqId, text: q(i), labels: nerLabels }
      ws.send(JSON.stringify({ to: { type: 'fast-router' }, payload }))
    }
    return
  }
  if (p?.t === 'ner:result' || p?.t === 'classify:result') { roundtrip.push(Date.now() - sentAt[p.reqId]); compute.push(p.ms); if (++done === N) finish() }
  if (p?.t === 'task:error') { console.log('error:', p.error); if (++done === N) finish() }
})
function finish() {
  const wall = Date.now() - t0, rt = stats(roundtrip), cp = stats(compute)
  console.log(`\nintegrity:   ${done}/${N} returned  ${done === N ? 'OK ✓' : 'DROPPED ✗'}`)
  console.log(`wall time:   ${wall}ms  (${(wall / 1000).toFixed(2)}s)`)
  console.log(`throughput:  ${(N / (wall / 1000)).toFixed(1)} tasks/sec`)
  console.log(`compute:     avg ${cp.avg}ms  p50 ${cp.p50}  p95 ${cp.p95}  (min ${cp.min} / max ${cp.max})`)
  console.log(`roundtrip:   avg ${rt.avg}ms  p50 ${rt.p50}  p95 ${rt.p95}  (min ${rt.min} / max ${rt.max} — max = last in queue)`)
  ws.close(); process.exit(0)
}
setTimeout(() => { console.error(`timeout — only ${done}/${N} returned`); process.exit(1) }, 180000)
