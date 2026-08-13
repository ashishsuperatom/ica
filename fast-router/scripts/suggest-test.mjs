// Fire queries at the running fast-router (as a 'runtime') and print the semantic-match breakdown —
// the same thing the console shows, but headless, to verify quality.  node scripts/suggest-test.mjs
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync(new URL('../fast-router.local.json', import.meta.url), 'utf8'))
const QUERIES = process.argv.slice(2).length ? process.argv.slice(2) : [
  'vendors on the dahej udaipur lane',
  'who grew but is paying slower',
  'overdue invoices in raipur',
  'why did revenue change last year',
  'solar customers revenue',
]
const ws = new WebSocket(`${cfg.hubHost}/_ws/${cfg.id}?key=${cfg.key}`)
const pending = new Map()
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', key: cfg.key, role: 'runtime' })))
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.payload?.t === 'welcome') { run() ; return }
  if (m.payload?.t === 'suggestions') {
    const p = m.payload, d = p.diag
    console.log(`\n"${d.text}"   intent=${p.intent.intent} ${(p.intent.confidence*100).toFixed(0)}%   (${p.ms}ms · embed ${d.timings.embed} · qdrant ${d.timings.qdrant} · gliner ${d.timings.gliner})`)
    d.matches.slice(0, 3).forEach(x => console.log(`   ${(x.score * 100).toFixed(0).padStart(3)}%${x.score >= d.threshold ? ' ✓' : '  '} ${x.question}`))
    if (d.entities?.length) console.log('   entities: ' + d.entities.map(e => `${e.text}→${e.label}(${(e.score*100).toFixed(0)}%)`).join(', '))
    pending.delete(p.seq)
    if (pending.size === 0) { ws.close(); }
  }
})
let seq = 0
function run() {
  // unique inputId per query so they don't drop-stale each other (each = its own "input session")
  for (const q of QUERIES) { seq++; pending.set(seq, q); ws.send(JSON.stringify({ to: { type: 'fast-router' }, payload: { t: 'suggest', projectId: 'totalgroup', userId: 'tester', inputId: 'test-' + seq, seq, text: q } })) }
}
setTimeout(() => { console.error('timeout'); process.exit(1) }, 20000)
ws.on('close', () => process.exit(0))
