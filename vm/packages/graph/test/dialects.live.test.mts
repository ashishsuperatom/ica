// The SQL each dialect is given, run on a real source. Skipped unless DATASOURCE_URL points at a manager.
//
// NetSuite speaks the Oracle dialect; TotalGroup is SQL Server. For each: every time grain labels periods the
// way the engine's JavaScript does, and top-N, having and median run where the source supports them.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GraphStore, createEngine, periods, sqlFor, type Contract, type Grain } from '../src/index.ts'

const live = { skip: !process.env.DATASOURCE_URL }
const Q2 = { from: '2026-04-01', to: '2026-07-01' }
const GRAINS: Grain[] = ['day', 'week', 'month', 'quarter', 'year']

async function netsuite() {
  const { query } = await import('@superatom/scaffold')
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-live-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), query, dialects: { F5NETSUITE: 'oracle' } })
  const dir = new URL('../examples/capacity/utilised-hours-corrected/', import.meta.url)
  const body = readFileSync(new URL('program.mjs', dir), 'utf8')
  const contract = JSON.parse(readFileSync(new URL('contract.json', dir), 'utf8')) as Contract
  ;(contract.shape!.measures as any).typical_entry = { aggregate: 'median', column: 'hours', unit: 'h', kind: 'flow' }
  ;(contract.shape!.measures as any).entries = { aggregate: 'count', unit: 'entries', kind: 'flow' }
  ;(contract.shape!.measures as any).hours_per_entry = { expression: 'hours / entries', unit: 'h per entry', kind: 'ratio' }
  await engine.define({ body, contract }, { by: 'test' })
  return { engine, store }
}

test('NetSuite: every grain partitions the same hours, with the labels JavaScript gives', live, async () => {
  const { engine } = await netsuite()
  const total = (await engine.call<any>('utilised hours', { measures: ['hours'], during: Q2 })).value.rows[0].hours
  for (const grain of GRAINS) {
    const r = (await engine.call<any>('utilised hours', { measures: ['hours'], by: [grain], during: Q2 })).value
    const expected = new Set(periods(grain, Q2.from, Q2.to).map((p) => p.label))
    for (const row of r.rows) assert.ok(expected.has(row[grain]), `${grain}: "${row[grain]}" is not a label JavaScript produces`)
    const sum = r.rows.reduce((a: number, x: any) => a + x.hours, 0)
    assert.ok(Math.abs(sum - total) < 1e-6, `${grain}: ${sum} vs ${total}`)
  }
})

test('NetSuite: top employees by hours, with having, a ratio and a median', live, async () => {
  const { engine, store } = await netsuite()
  const r = await engine.call<any>('utilised hours', { measures: ['hours', 'hours_per_entry', 'typical_entry'], by: ['employee'], during: Q2,
    having: { hours: { gt: 100 } }, order: [{ by: 'hours', desc: true }], limit: 5 })
  const rows = r.value.rows
  assert.equal(rows.length, 5)
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].hours >= rows[i].hours, 'ordered')
  for (const x of rows) { assert.ok(x.hours > 100); assert.ok(x.hours_per_entry > 0); assert.ok(x.typical_entry > 0) }
  assert.match(store.getCall(r.callId)!.queries[0].sql, /FETCH FIRST 5 ROWS ONLY/)
})

test('SQL Server: period labels match JavaScript for dates across every edge', live, async () => {
  const { query } = await import('@superatom/scaffold')
  const s = sqlFor('mssql')
  // Year ends, a leap day, a Sunday and a Monday: where week and quarter arithmetic goes wrong.
  const dates = ['2024-02-29', '2025-12-28', '2025-12-29', '2025-12-31', '2026-01-01', '2026-03-31', '2026-04-01', '2026-09-13', '2026-09-14']
  for (const d of dates) {
    const cols = GRAINS.map((g) => `${s.period(g, 'CAST(@d AS date)')} AS ${g}`).join(', ')
    const [row] = await query('TOTALGROUP', `SELECT ${cols}`, { d })
    for (const g of GRAINS) {
      const want = periods(g, d, new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10))[0].label
      assert.equal(String(row[g]).trim(), want, `${g} of ${d}`)
    }
  }
})

test('NetSuite: period labels match JavaScript for dates across every edge', live, async () => {
  const { query } = await import('@superatom/scaffold')
  const s = sqlFor('oracle')
  const dates = ['2024-02-29', '2025-12-28', '2025-12-29', '2025-12-31', '2026-01-01', '2026-03-31', '2026-04-01', '2026-09-13', '2026-09-14']
  for (const d of dates) {
    const cols = GRAINS.map((g) => `${s.period(g, `TO_DATE('${d}', 'YYYY-MM-DD')`)} AS ${g}`).join(', ')
    const [row] = await query('F5NETSUITE', `SELECT ${cols} FROM dual`)
    for (const g of GRAINS) {
      const want = periods(g, d, new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10))[0].label
      assert.equal(String(row[g]), want, `${g} of ${d}`)
    }
  }
})
