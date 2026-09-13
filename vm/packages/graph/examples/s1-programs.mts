// ── SLICE 1 · STEP S1 — PROGRAMS ──────────────────────────────────────────────────────────────────────────
//
//   DATASOURCE_URL=http://127.0.0.1:4020 pnpm exec tsx packages/graph/examples/s1-programs.mts
//
// What it shows, on real NetSuite data:
//   1. programs are defined from files, identified by hash, and reached by name
//   2. a program calls programs by name, in stages: resolve what was typed, then count
//   3. every call is remembered, and the trace is read straight from that memory
//   4. the contract is enforced — only a concept reads data, and a program reads only what it declares
//   5. immutability and correction: a fixed program is a new hash, the name moves, every caller gets the fix,
//      and the calls that went through the wrong version are still listed

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { query } from '@superatom/scaffold'
import { GraphStore, createEngine, trace, type Contract } from '../src/index.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const state = join(here, '..', '..', '..', '.state', 'graph-slice')
rmSync(state, { recursive: true, force: true })

const store = new GraphStore(join(state, 'graph.sqlite'))
const engine = createEngine({ store, modulesDir: join(state, 'modules'), query, dialects: { F5NETSUITE: 'oracle' } })

const load = (dir: string) => ({
  body: readFileSync(join(here, 'capacity', dir, 'program.mjs'), 'utf8'),
  contract: JSON.parse(readFileSync(join(here, 'capacity', dir, 'contract.json'), 'utf8')) as Contract,
})
const heading = (s: string) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 100 - s.length))}`)
const attempt = async (label: string, fn: () => unknown) => {
  try { await fn(); console.log(`  ✗ ${label} — ALLOWED, which is wrong`) }
  catch (e: any) { console.log(`  ✓ ${label}\n      refused: ${e.message}`) }
}

heading('1 · define programs')
for (const dir of ['pillars', 'resolve-pillar', 'active-headcount', 'pillar-headcount']) {
  const r = await engine.define(load(dir), { by: 'human:slice' })
  console.log(`  ${r.name.padEnd(20)} ${r.hash}`)
}

heading('2 · a question, staged: resolve what was typed, then count')
const typo = await engine.call('pillar headcount', { pillar: 'netsuit' })
console.log(`  answer: ${JSON.stringify(typo.value)}\n`)
console.log(trace(store, typo.callId))

heading('3 · when the name is ambiguous, it says so instead of guessing')
const mwp = await engine.call('pillar headcount', { pillar: 'MWP' })
console.log(`  answer: ${JSON.stringify(mwp.value)}\n`)
console.log(trace(store, mwp.callId))

heading('4 · the contract is enforced')
await attempt('a program cannot declare a data source', () => engine.define({
  body: `export default async (ctx) => ctx.query('F5NETSUITE', 'SELECT 1 AS n FROM dual')`,
  contract: { name: 'sneaky', kind: 'program', description: 'Tries to read data directly.',
              reads: { sources: ['F5NETSUITE'], programs: [] }, params: {}, returns: 'rows' },
}, { by: 'human:slice' }))
await attempt('a program cannot read a program that does not exist', () => engine.define({
  body: `export default async (ctx) => ctx.call('revenue')`,
  contract: { name: 'dangling', kind: 'program', description: 'Reads something missing.',
              reads: { sources: [], programs: ['revenue'] }, params: {}, returns: 'value' },
}, { by: 'human:slice' }))
await engine.define({
  body: `export default async (ctx) => ctx.call('active headcount')`,
  contract: { name: 'undeclared', kind: 'program', description: 'Calls something it did not declare.',
              reads: { sources: [], programs: ['pillars'] }, params: {}, returns: 'value' },
}, { by: 'human:slice' })
await attempt('a program cannot call what its contract does not declare', () => engine.call('undeclared'))
await attempt('a name cannot be taken by a different program by accident', () =>
  engine.define(load('active-headcount-corrected'), { by: 'human:slice' }))

heading('5 · correction: fix once, every caller gets it')
// OH holds two of the four placeholder records, so it is where the correction visibly moves a number.
const wrong = store.resolve('active headcount')!
const beforeOH  = await engine.call('pillar headcount', { pillar: 'OH' })
const beforeAll = await engine.call('active headcount')
const fixed = await engine.define(load('active-headcount-corrected'),
  { by: 'human:slice', replace: true, reason: 'system accounts and placeholders are not people' })
console.log(`  "active headcount"  ${wrong}  →  ${fixed.hash}`)
const afterOH  = await engine.call('pillar headcount', { pillar: 'OH' })
const afterAll = await engine.call('active headcount')
console.log(`  pillar headcount, OH      before ${JSON.stringify(beforeOH.value)}   after ${JSON.stringify(afterOH.value)}`)
console.log(`  active headcount, all     before ${JSON.stringify(beforeAll.value)}   after ${JSON.stringify(afterAll.value)}\n`)
console.log(trace(store, afterOH.callId))
console.log(`\n  calls that went through the wrong version (${wrong}):`)
for (const c of store.callsThrough(wrong)) console.log(`     ${new Date(c.at).toISOString()}  ${JSON.stringify(c.request)}  → ${JSON.stringify(c.output)}`)
console.log(`\n  what "active headcount" has pointed at:`)
for (const h of store.history('active headcount')) console.log(`     ${h.hash}  ${h.to ? 'until replaced' : 'now'}  by ${h.by}${h.reason ? ` — ${h.reason}` : ''}`)

store.close()
