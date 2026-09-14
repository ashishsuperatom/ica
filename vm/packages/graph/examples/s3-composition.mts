// ── SLICE 1 · STEP S3 — COMPOSITION ───────────────────────────────────────────────────────────────────────
//
//   DATASOURCE_URL=http://127.0.0.1:4021 pnpm exec tsx packages/graph/examples/s3-composition.mts
//
// `utilisation` is a program: it reads no data. It resolves what was typed, decides whether the span has
// ended, asks the two concepts the same question, and divides row by row. The split, the drill and the
// pillar name are all its parameters — none of them is a new program.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { GraphStore, createEngine, managerInspect, managerQuery, trace, type Contract } from '../src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const state = join(process.env.ENGINE_STATE_DIR ?? join(homedir(), '.superatom', 'state'), 'graph-slice-s3')
rmSync(state, { recursive: true, force: true })
const store = new GraphStore(join(state, 'graph.sqlite'))
const engine = createEngine({ store, modulesDir: join(state, 'modules'), query: managerQuery(), dialects: { F5NETSUITE: 'oracle' }, inspect: managerInspect() })

const load = (dir: string) => ({
  body: readFileSync(join(here, 'capacity', dir, 'program.mjs'), 'utf8'),
  contract: JSON.parse(readFileSync(join(here, 'capacity', dir, 'contract.json'), 'utf8')) as Contract,
})
const heading = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 100 - s.length))}`)

function table(v: any, limit = 8) {
  const cols = v.columns.filter((c: any) => c.role !== 'dimension' || !v.columns.some((x: any) => x.name === `${c.name}_label`))
  const rows = [...v.rows].sort((a: any, b: any) => String(a.month ?? '').localeCompare(String(b.month ?? '')) || (b.utilisation ?? -1) - (a.utilisation ?? -1))
  const fmt = (c: any, x: any) => c.unit === 'ratio' ? (x == null ? '—' : `${(x * 100).toFixed(1)}%`)
    : c.role === 'measure' ? Number(x).toLocaleString('en-NZ', { maximumFractionDigits: 0 }) : String(x ?? '(none)')
  const head = cols.map((c: any) => c.role === 'measure' ? `${c.name}${c.unit === 'ratio' ? '' : ` (${c.unit})`}` : c.name.replace(/_label$/, ''))
  const body = rows.slice(0, limit).map((r: any) => cols.map((c: any) => fmt(c, r[c.name])))
  body.push(cols.map((c: any, i: number) => i === 0 ? 'TOTAL' : c.role === 'measure' ? fmt(c, v.total[c.name]) : ''))
  const w = head.map((h: string, i: number) => Math.max(h.length, ...body.map((b: string[]) => b[i].length)))
  const line = (cells: string[]) => '  ' + cells.map((c, i) => cols[i].role === 'measure' ? c.padStart(w[i]) : c.padEnd(w[i])).join('   ')
  console.log(line(head))
  body.forEach((b: string[], i: number) => { if (i === body.length - 1 && rows.length > limit) console.log(`  … ${rows.length - limit} more`); console.log(line(b)) })
}

async function ask(label: string, request: any, opts: { limit?: number; trace?: boolean } = {}) {
  console.log(`\n  ${label}\n  utilisation ${JSON.stringify(request)}`)
  try {
    const r = await engine.call<any>('utilisation', request)
    if (!r.value.columns) { console.log(`  → ${JSON.stringify(r.value)}`) } else table(r.value, opts.limit)
    const all = (id: string): any[] => { const c = store.getCall(id)!; return [c, ...store.children(id).flatMap((k: any) => all(k.id))] }
    const calls = all(r.callId)
    for (const c of calls) for (const v of c.verifications) console.log(`  ${v.held ? '✓' : '✗'} ${c.name}: ${v.label} (${v.detail})`)
    for (const cv of [...new Set(calls.flatMap((c) => c.caveats))]) console.log(`  · ${cv}`)
    console.log(`  ${calls.length} calls, ${calls.reduce((a, c) => a + c.queries.length, 0)} statements, ${store.getCall(r.callId)!.ms}ms`)
    if (opts.trace) console.log('\n' + trace(store, r.callId, '  '))
  } catch (e: any) { console.log(`  ⊘ refused: ${e.message}`) }
}

heading('define: two concepts, a resolver, one composite')
for (const dir of ['pillars', 'resolve-pillar', 'fte', 'utilised-hours', 'utilisation']) {
  const r = await engine.define(load(dir), { by: 'human:slice' })
  console.log(`  ${r.name.padEnd(16)} ${r.hash}`)
}

const Q3 = { from: '2026-07-01', to: '2026-10-01' }
const Q2 = { from: '2026-04-01', to: '2026-07-01' }

heading('one program, many questions')
await ask('utilisation by pillar, Q2', { during: Q2, by: ['pillar'] }, { limit: 15, trace: true })
await ask('the same, for a pillar typed with a spelling mistake', { during: Q2, by: ['pillar'], pillar: 'netsuit' })
await ask('drill: NetSuite by month', { during: Q2, by: ['month'], pillar: 'NetSuite' })
await ask('drill: NetSuite by employee', { during: Q2, by: ['employee'], pillar: 'NetSuite' }, { limit: 6 })
await ask('a span that has not ended: Q3 by pillar', { during: Q3, by: ['pillar'] }, { limit: 4 })

heading('what the composite cannot be made to do')
await ask('a pillar name that fits two pillars', { during: Q2, pillar: 'MWP' })
await ask('a split the concepts do not have', { during: Q2, by: ['region'] })

store.close()
