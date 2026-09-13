// ── SLICE 1 · STEP S2 — SLICE AND DRILL ───────────────────────────────────────────────────────────────────
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx packages/graph/examples/s2-drill.mts
//
// Two concepts return relations — definitions, not answers. Every question below is coordinates asked of the
// same two programs; none of them needed a new program. And the requests that would produce a wrong number
// are refused, with the reason.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@superatom/scaffold'
import { GraphStore, createEngine, trace, type Contract } from '../src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const state = join(here, '..', '..', '..', '.state', 'graph-slice-s2')
rmSync(state, { recursive: true, force: true })
const store = new GraphStore(join(state, 'graph.sqlite'))
const engine = createEngine({ store, modulesDir: join(state, 'modules'), query, dialects: { F5NETSUITE: 'oracle' } })

const load = (dir: string) => ({
  body: readFileSync(join(here, 'capacity', dir, 'program.mjs'), 'utf8'),
  contract: JSON.parse(readFileSync(join(here, 'capacity', dir, 'contract.json'), 'utf8')) as Contract,
})
const heading = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 100 - s.length))}`)
const Q3 = { from: '2026-07-01', to: '2026-10-01' }
const PILLARS = { CEC: '15', NetSuite: '5', OH: '4' }

function table(result: any, limit = 8) {
  const cols = result.columns.filter((c: any) => c.role !== 'dimension' || !result.columns.some((x: any) => x.name === `${c.name}_label`))
  const rows = [...result.rows].sort((a: any, b: any) => {
    const m = result.columns.find((c: any) => c.role === 'measure').name
    return String(a.month ?? '').localeCompare(String(b.month ?? '')) || Number(b[m]) - Number(a[m])
  })
  const fmt = (c: any, v: any) => c.role === 'measure' ? (v == null ? '—' : Number(v).toLocaleString('en-NZ', { maximumFractionDigits: 1 })) : String(v ?? '(none)')
  const head = cols.map((c: any) => c.role === 'measure' ? `${c.name} (${c.unit})` : c.name.replace(/_label$/, ''))
  const body = rows.slice(0, limit).map((r: any) => cols.map((c: any) => fmt(c, r[c.name])))
  const widths = head.map((h: string, i: number) => Math.max(h.length, ...body.map((b: string[]) => b[i].length)))
  const line = (cells: string[]) => '  ' + cells.map((c, i) => (cols[i].role === 'measure' ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('   ')
  console.log(line(head))
  for (const b of body) console.log(line(b))
  if (rows.length > limit) console.log(`  … ${rows.length - limit} more`)
}

async function ask(label: string, name: string, coords: any, opts: { limit?: number; sql?: boolean } = {}) {
  console.log(`\n  ${label}\n  ${name} ${JSON.stringify(coords)}`)
  try {
    const r = await engine.call(name, coords)
    const c = store.getCall(r.callId)!
    table(r.value, opts.limit)
    for (const v of c.verifications) console.log(`  ${v.held ? '✓' : '✗'} ${v.label} (${v.detail})`)
    for (const cv of c.caveats) console.log(`  · ${cv}`)
    console.log(`  ${c.queries.length} statement(s), ${c.ms}ms`)
    if (opts.sql) console.log('\n' + trace(store, r.callId, '  ', true))
  } catch (e: any) {
    console.log(`  ⊘ refused: ${e.message}`)
  }
}

heading('definitions are checked when they are defined')
for (const dir of ['fte', 'utilised-hours']) {
  const r = await engine.define(load(dir), { by: 'human:slice' })
  console.log(`  ${r.name.padEnd(16)} ${r.hash}`)
}
const fteContract = load('fte').contract
for (const [label, contract, body] of [
  ['a column the shape names but the SQL does not produce',
   { ...fteContract, name: 'bad fte', shape: { ...fteContract.shape!, measures: { fte: { aggregate: 'sum', column: 'fte_hours', unit: 'FTE', kind: 'stock' } } } },
   load('fte').body],
  ['a flow with no time column',
   { ...load('utilised-hours').contract, name: 'bad hours', shape: { ...load('utilised-hours').contract.shape!, time: undefined } },
   load('utilised-hours').body],
  ['a measure with no unit',
   { ...fteContract, name: 'bad unit', shape: { ...fteContract.shape!, measures: { headcount: { aggregate: 'count', unit: '', kind: 'stock' } } } },
   load('fte').body],
] as const) {
  try {
    await engine.define({ body, contract: contract as Contract }, { by: 'human:slice' })
    console.log(`  ✗ ${label} — accepted, which is wrong`)
  } catch (e: any) { console.log(`  ⊘ ${label}: ${e.message.slice(0, 220)}`) }
}

heading('a stock, at an instant, then split and drilled')
await ask('fte by pillar, as at the end of August', 'fte', { by: ['pillar'], at: '2026-08-31' }, { limit: 6, sql: true })
await ask('the same stock, by month across Q3, for three pillars', 'fte',
  { by: ['pillar', 'month'], where: { pillar: Object.values(PILLARS) }, during: Q3 }, { limit: 9 })

heading('a stock across a span must say how to roll up')
await ask('fte by pillar for Q3, no rollup', 'fte', { by: ['pillar'], during: Q3 })
await ask('fte by pillar for Q3, as at the end', 'fte', { by: ['pillar'], during: Q3, rollup: { time: 'last' }, where: { pillar: Object.values(PILLARS) } })
await ask('fte by pillar for Q3, the average of month-ends', 'fte', { by: ['pillar'], during: Q3, rollup: { time: 'average' }, where: { pillar: Object.values(PILLARS) } })

heading('a flow, split and drilled')
await ask('utilised hours by pillar for Q3', 'utilised hours', { by: ['pillar'], during: Q3 }, { limit: 6 })
await ask('drill into CEC: by employee', 'utilised hours', { by: ['employee'], where: { pillar: PILLARS.CEC }, during: Q3 }, { limit: 5 })
await ask('drill further: CEC by employee and month', 'utilised hours', { by: ['employee', 'month'], where: { pillar: PILLARS.CEC }, during: Q3 }, { limit: 6 })

heading('requests that would produce a wrong number')
await ask('a flow at an instant', 'utilised hours', { by: ['pillar'], at: '2026-08-31' })
await ask('a filter on a dimension that does not exist', 'fte', { measures: ['fte'], by: ['pillar'], at: '2026-08-31', where: { region: 'NZ' } })
await ask('a dimension that does not exist', 'utilised hours', { by: ['region'], during: Q3 })
await ask('more rows than the source will return', 'utilised hours', { by: ['employee', 'month'], during: { from: '2025-01-01', to: '2026-09-01' } })

store.close()
