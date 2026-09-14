// ── SLICE 1 · STEP S4 — CORRECTION ────────────────────────────────────────────────────────────────────────
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx packages/graph/examples/s4-correction.mts
//
// `utilised hours` is wrong: it counts allocated and planned time as well as actual. Two things are built on
// it — `utilisation`, a program that calls it, and `billable hours`, a relation whose SQL is built from its
// SQL. The concept is fixed once. Neither caller changes; both are right on their next run; the answers that
// went through the wrong version are found in memory and re-run.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { GraphStore, createEngine, managerInspect, managerQuery, type Contract } from '../src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const state = join(process.env.ENGINE_STATE_DIR ?? join(homedir(), '.superatom', 'state'), 'graph-slice-s4')
rmSync(state, { recursive: true, force: true })
const store = new GraphStore(join(state, 'graph.sqlite'))
const engine = createEngine({ store, modulesDir: join(state, 'modules'), query: managerQuery(), dialects: { F5NETSUITE: 'oracle' }, inspect: managerInspect() })

const load = (dir: string) => ({
  body: readFileSync(join(here, 'capacity', dir, 'program.mjs'), 'utf8'),
  contract: JSON.parse(readFileSync(join(here, 'capacity', dir, 'contract.json'), 'utf8')) as Contract,
})
const heading = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 100 - s.length))}`)
const n = (x: number) => x.toLocaleString('en-NZ', { maximumFractionDigits: 0 })
const pct = (x: number | null) => x == null ? '—' : `${(x * 100).toFixed(1)}%`
const Q2 = { from: '2026-04-01', to: '2026-07-01' }

const QUESTIONS: Array<[string, string, any]> = [
  ['utilisation by pillar', 'utilisation', { during: Q2, by: ['pillar'] }],
  ['utilisation, NetSuite by employee', 'utilisation', { during: Q2, by: ['employee'], pillar: 'NetSuite' }],
  ['billable hours by pillar', 'billable hours', { during: Q2, by: ['pillar'] }],
]

/** One comparable picture of an answer: per row label, the number that matters. */
function picture(name: string, v: any): Map<string, number | null> {
  const label = (r: any) => String(r.pillar_label ?? r.employee_label ?? r.pillar ?? r.employee ?? 'all')
  const m = new Map<string, number | null>()
  if (name === 'utilisation') { for (const r of v.rows) m.set(label(r), r.utilisation); m.set('TOTAL', v.total.utilisation) }
  else { for (const r of v.rows) m.set(label(r), r.hours); m.set('TOTAL', v.rows.reduce((a: number, r: any) => a + r.hours, 0)) }
  return m
}
const show = (name: string, x: number | null | undefined) => x == null ? '—' : name === 'utilisation' ? pct(x) : `${n(x)} h`

heading('define — the concept as it is, wrong')
for (const dir of ['pillars', 'resolve-pillar', 'fte', 'utilised-hours', 'utilisation', 'billable-hours']) {
  const r = await engine.define(load(dir), { by: 'human:slice' })
  console.log(`  ${r.name.padEnd(16)} ${r.hash}`)
}
const callers = ['utilisation', 'billable hours'].map((name) => [name, store.resolve(name)!] as const)

heading('ask, before the correction')
const before = new Map<string, Map<string, number | null>>()
for (const [label, name, request] of QUESTIONS) {
  const r = await engine.call<any>(name, request)
  before.set(label, picture(name, r.value))
  console.log(`  ${label.padEnd(36)} total ${show(name, before.get(label)!.get('TOTAL'))}`)
}

heading('a correction that would break its callers is refused')
const broken = load('utilised-hours-corrected')
broken.contract = { ...broken.contract, shape: { ...broken.contract.shape!, measures: { actual_hours: { aggregate: 'sum', column: 'hours', unit: 'h', kind: 'flow' } } } }
try { await engine.define(broken, { by: 'human:slice', replace: true, reason: 'actual time only' }); console.log('  ✗ accepted, which is wrong') }
catch (e: any) { console.log(`  ⊘ ${e.message}`) }

heading('the correction — once, in one place')
const wrong = store.resolve('utilised hours')!
const fixed = await engine.define(load('utilised-hours-corrected'),
  { by: 'human:slice', replace: true, reason: 'allocated and planned time are not hours worked' })
console.log(`  utilised hours    ${wrong}  →  ${fixed.hash}`)
for (const [name, hash] of callers) console.log(`  ${name.padEnd(16)}  ${hash}  →  ${store.resolve(name)}  ${store.resolve(name) === hash ? '(unchanged)' : '(CHANGED)'}`)

heading('the answers that went through the wrong version, re-run')
const affected = store.answersThrough(wrong)
console.log(`  ${affected.length} answer(s) went through ${wrong}\n`)
for (const a of affected) {
  const label = QUESTIONS.find(([, name, req]) => name === a.name && JSON.stringify(req) === JSON.stringify(a.request))?.[0] ?? a.name
  const again = await engine.call<any>(a.name, a.request as any)
  const was = before.get(label)!, now = picture(a.name, again.value)
  console.log(`  ${label}`)
  const rows = [...now.keys()].filter((k) => k !== 'TOTAL')
    .map((k) => ({ k, was: was.get(k) ?? null, now: now.get(k) ?? null }))
    .sort((x, y) => Math.abs((y.was ?? 0) - (y.now ?? 0)) - Math.abs((x.was ?? 0) - (x.now ?? 0)))
  for (const r of [...rows.slice(0, 5), { k: 'TOTAL', was: was.get('TOTAL') ?? null, now: now.get('TOTAL') ?? null }]) {
    console.log(`     ${r.k.padEnd(22)} ${show(a.name, r.was).padStart(10)}  →  ${show(a.name, r.now).padStart(10)}`)
  }
  if (rows.length > 5) console.log(`     … ${rows.length - 5} more rows changed or checked`)
  console.log()
}

heading('the composed SQL, after the correction')
const last = await engine.call<any>('billable hours', { during: Q2, by: ['pillar'], where: { pillar: '5' } })
const c = store.getCall(last.callId)!
console.log(c.queries[0].sql.split('\n').map((l) => `  ${l}`).join('\n'))
console.log(`\n  inlined: ${store.children(c.id).map((k) => `${k.name} ${k.hash}`).join(', ')}`)
console.log(`\n  what "utilised hours" has pointed at:`)
for (const h of store.history('utilised hours')) console.log(`     ${h.hash}  ${h.to ? 'until replaced' : 'now'}  by ${h.by}${h.reason ? ` — ${h.reason}` : ''}`)

store.close()
