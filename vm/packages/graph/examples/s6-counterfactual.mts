// ── SLICE 1 · STEP S6 — COUNTERFACTUAL ────────────────────────────────────────────────────────────────────
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx packages/graph/examples/s6-counterfactual.mts
//
// Q2 utilisation by pillar was asked and answered. What would that answer have been with three more people in
// NetSuite? With a 37.5-hour week? Against a different target? Each question takes the recorded answer — its
// day, its assumptions — asks it again as it was and with the change, and gives the difference row by row.
//
// And when a concept has been corrected since the answer was given, the effect of the change is still only the
// change: both sides are recomputed, so the correction is not counted as something the hires did.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@superatom/scaffold'
import { GraphStore, createEngine, managerInspect, type Contract } from '../src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const state = join(here, '..', '..', '..', '.state', 'graph-slice-s6')
rmSync(state, { recursive: true, force: true })
const store = new GraphStore(join(state, 'graph.sqlite'))
const engine = createEngine({ store, modulesDir: join(state, 'modules'), query, dialects: { F5NETSUITE: 'oracle' }, inspect: managerInspect() })
const load = (dir: string) => ({
  body: readFileSync(join(here, 'capacity', dir, 'program.mjs'), 'utf8'),
  contract: JSON.parse(readFileSync(join(here, 'capacity', dir, 'contract.json'), 'utf8')) as Contract,
})
const heading = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 100 - s.length))}`)
const pct = (x: number | null | undefined) => x == null ? '—' : `${(x * 100).toFixed(1)}%`
const pts = (x: number | null | undefined) => x == null ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)} pts`
const Q2 = { from: '2026-04-01', to: '2026-07-01' }

for (const dir of ['pillars', 'resolve-pillar', 'fte', 'utilised-hours-corrected', 'utilisation']) await engine.define(load(dir), { by: 'human:slice' })

function show(cf: any, rows = 6, measure = 'utilisation') {
  const d = cf.difference
  const moved = [...d.rows].sort((a: any, b: any) => Math.abs(b[`${measure}_change`] ?? 0) - Math.abs(a[`${measure}_change`] ?? 0))
  console.log(`  ${'pillar'.padEnd(12)} ${'as it was'.padStart(10)} ${'would be'.padStart(10)} ${'change'.padStart(11)}`)
  for (const r of moved.slice(0, rows)) {
    const f = measure === 'gap' ? pts : pct
    console.log(`  ${String(r.pillar_label).padEnd(12)} ${f(r[measure]).padStart(10)} ${f(r[`${measure}_counterfactual`]).padStart(10)} ${pts(r[`${measure}_change`]).padStart(11)}`)
  }
  const t = d.total?.[measure]
  const f = measure === 'gap' ? pts : pct
  if (t) console.log(`  ${'TOTAL'.padEnd(12)} ${f(t.factual).padStart(10)} ${f(t.counterfactual).padStart(10)} ${pts(t.change).padStart(11)}`)
  for (const c of cf.caveats) console.log(`  · ${c}`)
}

heading('the answer as given')
const asked = await engine.call<any>('utilisation', { during: Q2, by: ['pillar'] }, { assume: { 'utilisation target': 0.5 } })
console.log(`  Q2 utilisation by pillar, against a 50% target: ${pct(asked.value.total.utilisation)} overall, ` +
  `${asked.value.rows.filter((r: any) => r.gap < 0).length} of ${asked.value.rows.length} pillars below target   (call ${asked.callId.slice(0, 8)})`)

heading('what it would have been with three more people in NetSuite')
const hires = [1, 2, 3].map((i) => ({ row: { employee_id: `hire-${i}`, employee_name: `New hire ${i}`, pillar_id: '5', pillar_name: 'NetSuite', subsidiary_id: '3', subsidiary_name: 'Fusion5 Ltd', fte: 1 }, from: '2026-04-01' }))
show(await engine.counterfactual(asked.callId, { intervene: { fte: { add: hires } } }), 3)

heading('what it would have been on a 37.5-hour week')
show(await engine.counterfactual(asked.callId, { assume: { 'working week': 37.5 } }))

heading('against a 60% target instead of 50%')
const target = await engine.counterfactual(asked.callId, { assume: { 'utilisation target': 0.6 } })
const below = (rows: any[], key: string) => rows.filter((r) => r[key] != null && r[key] < 0).length
console.log(`  pillars below target: ${below(target.difference.rows, 'gap')} → ${below(target.difference.rows, 'gap_counterfactual')}`)
show(target, 3, 'gap')

heading('a counterfactual on an answer given before a correction')
const wrongState = join(state, 'before-correction')
const before = new GraphStore(join(wrongState, 'graph.sqlite'))
const old = createEngine({ store: before, modulesDir: join(wrongState, 'modules'), query, dialects: { F5NETSUITE: 'oracle' }, inspect: managerInspect() })
for (const dir of ['pillars', 'resolve-pillar', 'fte', 'utilised-hours', 'utilisation']) await old.define(load(dir), { by: 'human:slice' })
const early = await old.call<any>('utilisation', { during: Q2, by: ['pillar'] })
console.log(`  answered with the wrong concept: ${pct(early.value.total.utilisation)}`)
await old.define(load('utilised-hours-corrected'), { by: 'human:slice', replace: true, reason: 'actual time only' })
const cf = await old.counterfactual(early.callId, { intervene: { fte: { add: hires } } })
console.log(`  as it was, recomputed: ${pct(cf.difference.total.utilisation.factual)} — with the hires: ${pct(cf.difference.total.utilisation.counterfactual)}`)
console.log(`  effect of the hires alone: ${pts(cf.difference.total.utilisation.change)}   (recorded answer to counterfactual would have said ${pts(cf.difference.total.utilisation.counterfactual - early.value.total.utilisation)})`)
for (const c of cf.caveats) console.log(`  · ${c}`)

before.close()
store.close()
