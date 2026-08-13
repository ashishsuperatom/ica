// THE core reuse use case: a stored question is parametrized ("book a flight from {origin} to
// {destination} on {date}"). A user asks it again with NEW values / different phrasing / different word
// order. We must recover the actual parameter VALUES so the existing program can be re-run. That slot
// extraction is exactly GLiNER NER: the labels ARE the template's slots. Runs over the M2M `ner` task
// against the warm model on the box.
//   node scripts/param-extract-demo.mjs
import WebSocket from 'ws'
import { readFileSync } from 'node:fs'
const cfg = JSON.parse(readFileSync(new URL('../fast-router.local.json', import.meta.url), 'utf8'))
const ws = new WebSocket(`${cfg.hubHost}/_ws/${cfg.id}?key=${cfg.key}`)

const CASES = [
  {
    template: 'book a flight from {origin} to {destination} on {date}',
    labels: ['origin', 'destination', 'date', 'passenger count', 'cabin class'],
    asks: [
      'book me a flight from Delhi to Mumbai on Friday',
      'I need 2 business class seats from Chennai to Bangalore next Monday morning',
      'flight to Goa from Pune on December 25th for 3 people',
    ],
  },
  {
    template: 'vendors from {origin} to {destination} on {vehicle} (freight domain)',
    labels: ['origin', 'destination', 'vehicle type', 'branch'],
    asks: [
      'who do we use from Raipur to Nagpur with 10-wheeler trucks',
      'vendor list Dahej to Udaipur on 14-wheeler from the Ahmedabad branch',
    ],
  },
  {
    template: 'book a hotel in {city} from {check-in} to {check-out} for {guests}',
    labels: ['city', 'check-in date', 'check-out date', 'guests'],
    asks: ['book a hotel in Jaipur from March 3 to March 7 for two guests'],
  },
]
const tasks = []
CASES.forEach((c, ci) => c.asks.forEach((text, ai) => tasks.push({ reqId: `${ci}-${ai}`, ci, text, labels: c.labels })))
const pending = new Set(tasks.map(t => t.reqId))
const byId = Object.fromEntries(tasks.map(t => [t.reqId, t]))
let curCase = -1

ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', key: cfg.key, role: 'runtime' })))
ws.on('message', (raw) => {
  const p = JSON.parse(raw.toString()).payload
  if (p?.t === 'welcome') { for (const t of tasks) ws.send(JSON.stringify({ to: { type: 'fast-router' }, payload: { t: 'ner', reqId: t.reqId, text: t.text, labels: t.labels } })); return }
  if (p?.t === 'ner:result') {
    const task = byId[p.reqId]
    if (task.ci !== curCase) { curCase = task.ci; console.log(`\n─── stored: "${CASES[task.ci].template}"`); console.log(`    slots: [${CASES[task.ci].labels.join(', ')}]\n`) }
    const slots = {}; p.entities.forEach(e => { slots[e.label] = e.text })
    console.log(`  new: "${task.text}"`)
    console.log(`   → ${JSON.stringify(slots)}   (${p.ms}ms)\n`)
    pending.delete(p.reqId); if (!pending.size) { ws.close(); process.exit(0) }
  }
  if (p?.t === 'task:error') { console.log(`[error ${p.reqId}] ${p.error}`); pending.delete(p.reqId); if (!pending.size) process.exit(0) }
})
setTimeout(() => { console.error('timeout', [...pending]); process.exit(1) }, 40000)
