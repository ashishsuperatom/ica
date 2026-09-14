// ── SLICE 1 · STEP S5 — ASSUMPTIONS AND INTERVENTIONS ─────────────────────────────────────────────────────
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx packages/graph/examples/s5-assumptions.mts
//
// `utilisation` declares two assumptions: the working week, and which pillars are not delivery capacity. The
// same program answers under its defaults, under an organisation's settings, and under a caller's. Then two
// changes for one request only: three hires in NetSuite, and a rule to leave one subsidiary out. Nothing is
// saved into the graph; every answer records what it assumed and whether it is hypothetical.
//
// The organisation settings here are ILLUSTRATIVE — chosen to show the mechanism, not Fusion5's real ones.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@superatom/scaffold'
import { GraphStore, createEngine, managerInspect, trace, type Contract } from '../src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const state = join(here, '..', '..', '..', '.state', 'graph-slice-s5')
rmSync(state, { recursive: true, force: true })
const store = new GraphStore(join(state, 'graph.sqlite'))
const modulesDir = join(state, 'modules')
const engine = createEngine({ store, modulesDir, query, dialects: { F5NETSUITE: 'oracle' }, inspect: managerInspect() })
const organisation = createEngine({ store, modulesDir, query, dialects: { F5NETSUITE: 'oracle' }, inspect: managerInspect(),
  assumptions: { 'working week': 37.5, 'pillars outside capacity': ['4', '48', '24'] } })   // OH, Microsoft, Jade

const load = (dir: string) => ({
  body: readFileSync(join(here, 'capacity', dir, 'program.mjs'), 'utf8'),
  contract: JSON.parse(readFileSync(join(here, 'capacity', dir, 'contract.json'), 'utf8')) as Contract,
})
const heading = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 100 - s.length))}`)
const pct = (x: number | null) => x == null ? '—' : `${(x * 100).toFixed(1)}%`
const h = (x: number) => `${x.toLocaleString('en-NZ', { maximumFractionDigits: 0 })} h`
const Q2 = { from: '2026-04-01', to: '2026-07-01' }

for (const dir of ['pillars', 'resolve-pillar', 'fte', 'utilised-hours-corrected', 'utilisation']) await engine.define(load(dir), { by: 'human:slice' })

async function show(label: string, e: typeof engine, request: any, options: any = {}) {
  const r = await e.call<any>('utilisation', request, options)
  const c = store.getCall(r.callId)!
  const t = r.value.total
  console.log(`\n  ${label}`)
  if (!t) { console.log(`  → ${JSON.stringify(r.value)}`); return r }
  console.log(`  utilisation ${pct(t.utilisation)}   hours ${h(t.hours)}   available ${h(t.available)}`)
  for (const a of c.assumptions) console.log(`  assumed  ${a.name} = ${JSON.stringify(a.value)} (${a.from})`)
  for (const cv of c.caveats.filter((x) => /hypothetical|capacity/.test(x))) console.log(`  · ${cv}`)
  return r
}

heading('one program, three sources of an assumption')
await show('the program\'s defaults', engine, { during: Q2 })
await show('the organisation\'s settings (illustrative)', organisation, { during: Q2 })
await show('a caller who says the week is 35 hours', organisation, { during: Q2 }, { assume: { 'working week': 35 } })
await show('asked about a pillar the organisation says is not capacity', organisation, { during: Q2, pillar: 'OH' })

heading('an intervention: three hires in NetSuite from 1 April')
const hires = [1, 2, 3].map((i) => ({ row: { employee_id: `hire-${i}`, employee_name: `New hire ${i}`, pillar_id: '5', pillar_name: 'NetSuite', subsidiary_id: '3', subsidiary_name: 'Fusion5 Ltd', fte: 1 }, from: '2026-04-01' }))
await show('NetSuite, as it was', engine, { during: Q2, pillar: 'NetSuite' })
const hypothetical = await show('NetSuite, with three more people', engine, { during: Q2, pillar: 'NetSuite' }, { intervene: { fte: { add: hires } } })
await show('asked again with no intervention — nothing was saved', engine, { during: Q2, pillar: 'NetSuite' })

heading('a rule for this request only: leave one subsidiary out')
const bySub = (await engine.call<any>('fte', { measures: ['headcount'], by: ['subsidiary'], at: '2026-06-30' })).value.rows
  .filter((r: any) => r.headcount > 0).sort((a: any, b: any) => b.headcount - a.headcount)
const left = bySub[1]
console.log(`\n  leaving out ${left.subsidiary_label} (${left.headcount} people as at 30 June)`)
const rule = { where: { subsidiary: left.subsidiary } }
await show(`everyone except ${left.subsidiary_label}`, engine, { during: Q2 }, { intervene: { fte: rule, 'utilised hours': rule } })

heading('memory: what a hypothetical answer assumed, and a replay of it')
console.log(trace(store, hypothetical.callId, '  ').split('\n').filter((l) => !/^\s+query/.test(l)).slice(0, 14).join('\n'))
const again = await engine.replay<any>(hypothetical.callId)
console.log(`\n  replayed: ${pct(again.value.total.utilisation)} (was ${pct(hypothetical.value.total.utilisation)})`)

store.close()
