// ── SLICE 1 · STEPS S7 AND S8 — EXPECTATIONS AND DECISIONS ─────────────────────────────────────────────────
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx packages/graph/examples/s7-s8-memory-and-decisions.mts
//
// S7: utilisation by pillar and month for eighteen months leaves its series in memory. Each month is compared with
// the twelve before it; a month outside that is a surprise, and triage walks it down to the part that moved.
// S8: "should this pillar hire?" is decided on last quarter's utilisation and reviewed as of a later day.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GraphStore, createEngine, managerInspect, managerQuery, type Contract } from '../src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const state = join(here, '..', '..', '..', '.state', 'graph-slice-s7')
rmSync(state, { recursive: true, force: true })
const store = new GraphStore(join(state, 'graph.sqlite'))
const engine = createEngine({ store, modulesDir: join(state, 'modules'), query: managerQuery(), dialects: { F5NETSUITE: 'oracle' }, inspect: managerInspect(), checks: 'light' })
const load = (dir: string) => ({
  body: readFileSync(join(here, 'capacity', dir, 'program.mjs'), 'utf8'),
  contract: JSON.parse(readFileSync(join(here, 'capacity', dir, 'contract.json'), 'utf8')) as Contract,
})
const pct = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`)
for (const dir of ['pillars', 'resolve-pillar', 'fte', 'utilised-hours-corrected', 'utilisation', 'should-hire']) await engine.define(load(dir), { by: 'human:slice' })

console.log('\n── S7: eighteen months into memory, and what stands out ──')
const span = { from: '2025-03-01', to: '2026-09-01' }
const history = await engine.call<any>('utilisation', { during: span, by: ['pillar', 'month'] })
const surprises = engine.surprises(history.callId)
for (const s of surprises.slice(0, 8)) {
  const show = (x: number | null | undefined) => (s.measure === 'utilisation' ? pct(x) : x == null ? '—' : `${Math.round(x).toLocaleString('en-NZ')} h`)
  const label = history.value.rows.find((r: any) => r.pillar === s.member.pillar)?.pillar_label ?? s.member.pillar
  console.log(`  ${String(label).padEnd(12)} ${s.period}  ${s.measure.padEnd(12)} ${show(s.expectation.value)} against ${show(s.expectation.median)} (z ${s.expectation.z!.toFixed(1)})`)
}
if (surprises.length) {
  const first = surprises.find((s) => s.measure === 'utilisation') ?? surprises[0]
  const { leads } = engine.explain(history.callId, { member: first.member, period: first.period, measure: first.measure })
  console.log(`\n  where ${history.value.rows.find((r: any) => r.pillar === first.member.pillar)?.pillar_label ?? first.member.pillar} ${first.period} comes from:`)
  for (const l of leads) console.log(`    ${l.name}.${l.measure}  z ${l.expectation.z?.toFixed(1)}`)
}

console.log('\n── S8: a decision, and its review ──')
for (const pillar of ['NetSuite', 'CEC']) {
  const d = await engine.call<any>('should hire', { pillar }, { today: '2026-04-15' })
  console.log(`  as at 2026-04-15, ${pillar}: ${pct(d.value.utilisation)} against ${pct(d.value.threshold)} → hire ${d.value.hire}`)
}
for (const r of await engine.review({ today: '2026-07-15' })) {
  console.log(`  reviewed 2026-07-15, ${(r.request as any).pillar}: ${r.reopened ? `REOPENED — ${r.flipped.map((f) => `${pct(f.was.value)} → ${pct(f.now.value)}`).join(', ')}` : 'still holds'}`)
}
store.close()
