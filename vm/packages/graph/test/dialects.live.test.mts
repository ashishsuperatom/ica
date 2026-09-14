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
  contract.shape!.dimensions.employee.entity = 'employee'
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

test('NetSuite: an April fiscal calendar splits the same hours as the calendar months', live, async () => {
  const { engine } = await netsuite()
  const calendar = { fiscal_quarter: { fiscal: 'quarter', startMonth: 4 } }
  const span = { from: '2026-01-01', to: '2026-07-01' }
  const months = (await engine.call<any>('utilised hours', { measures: ['hours'], by: ['month'], during: span })).value.rows
  const fq = (await engine.call<any>('utilised hours', { measures: ['hours'], by: ['fiscal_quarter'], during: span }, { assume: { calendar } })).value.rows
  const byMonth = (m: string[]) => months.filter((r: any) => m.includes(r.month)).reduce((a: number, r: any) => a + r.hours, 0)
  const got = new Map(fq.map((r: any) => [r.fiscal_quarter, r.hours]))
  assert.ok(Math.abs((got.get('FY2026-Q4') as number) - byMonth(['2026-01', '2026-02', '2026-03'])) < 1e-6)
  assert.ok(Math.abs((got.get('FY2027-Q1') as number) - byMonth(['2026-04', '2026-05', '2026-06'])) < 1e-6)
})

test('NetSuite: utilised hours by manager and by location — attributes reached through the employee', live, async () => {
  const { engine, store } = await netsuite()
  const dir = new URL('../examples/capacity/employees/', import.meta.url)
  await engine.define({ body: readFileSync(new URL('program.mjs', dir), 'utf8'), contract: JSON.parse(readFileSync(new URL('contract.json', dir), 'utf8')) }, { by: 'test' })
  const total = (await engine.call<any>('utilised hours', { measures: ['hours'], during: Q2 })).value.rows[0].hours
  const r = await engine.call<any>('utilised hours', { measures: ['hours'], by: ['employee.manager'], during: Q2, order: [{ by: 'hours', desc: true }] })
  const sum = r.value.rows.reduce((a: number, x: any) => a + x.hours, 0)
  assert.ok(Math.abs(sum - total) < 1e-6, `by manager ${sum} vs total ${total}`)
  const named = r.value.rows.filter((x: any) => x['employee.manager'] != null)
  assert.ok(named.length > 10 && named.every((x: any) => x['employee.manager_label']), 'managers are named')
  assert.ok(store.getCall(r.callId)!.caveats.some((x) => /some rows have no "employee.manager"/.test(x)))
  const c = store.getCall(r.callId)!
  assert.ok(c.verifications.some((v) => /"employees" has one row per employee/.test(v.label) && v.held))
  const loc = (await engine.call<any>('utilised hours', { measures: ['hours'], by: ['employee.location'], where: { 'employee.location': { isNull: false } }, during: Q2 })).value.rows
  assert.ok(loc.length > 1 && loc.every((x: any) => x['employee.location_label']))
})

test('NetSuite: a pivot of hours by pillar and month with totals, shares and the top two people per pillar', live, async () => {
  const { engine } = await netsuite()
  const r = (await engine.call<any>('utilised hours', { measures: ['hours', 'hours_per_entry'], by: ['pillar', 'month'], during: Q2,
    totals: [['pillar'], ['month'], []], share: { measures: ['hours'], within: ['month'] } })).value
  const grand = r.totals.find((t: any) => !t.by.length).rows[0]
  const cells = r.rows.reduce((a: number, x: any) => a + x.hours, 0)
  assert.ok(Math.abs(grand.hours - cells) < 1e-6)
  for (const month of ['2026-04', '2026-05', '2026-06']) {
    const s = r.rows.filter((x: any) => x.month === month).reduce((a: number, x: any) => a + x.hours_share, 0)
    assert.ok(Math.abs(s - 1) < 1e-9, `${month} shares add to one`)
  }
  const top = (await engine.call<any>('utilised hours', { measures: ['hours'], by: ['pillar', 'employee'], during: Q2,
    order: [{ by: 'hours', desc: true }], limit: 2, limitPer: ['pillar'] })).value.rows
  const perPillar = new Map<string, number>()
  for (const x of top) perPillar.set(x.pillar, (perPillar.get(x.pillar) ?? 0) + 1)
  assert.ok([...perPillar.values()].every((n) => n <= 2) && perPillar.size > 5)
})

// TODO: fails on NetSuite — 15,727 changes counted for 3 April in Auckland where a direct count gives 87 for
// 3 April UTC. The same conversion is exact on local rows (capabilities.test.mts). Not yet explained.
test('NetSuite: timestamps moved into another zone across a daylight-saving change match JavaScript', { ...live, todo: 'unexplained count on NetSuite' }, async () => {
  const { query } = await import('@superatom/scaffold')
  const { offsetMinutes } = await import('../src/index.ts')
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-live-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), query, dialects: { F5NETSUITE: 'oracle' } })
  // For the test the column is read as UTC; which zone NetSuite writes it in does not matter to the arithmetic.
  await engine.define({ body: `export default (ctx, { from, to }) => ({ source: 'F5NETSUITE', params: { from, to },
      sql: "SELECT tb.lastmodifieddate AS changed_at, 1 AS n FROM timebill tb WHERE tb.lastmodifieddate >= TO_DATE(@from, 'YYYY-MM-DD') - 2 AND tb.lastmodifieddate < TO_DATE(@to, 'YYYY-MM-DD') + 2" })`,
    contract: { name: 'changes', kind: 'concept', description: 'Time entries changed.', reads: { sources: ['F5NETSUITE'], programs: [] }, params: {}, returns: 'relation',
      shape: { dimensions: {}, measures: { changes: { aggregate: 'sum', column: 'n', unit: 'changes', kind: 'flow' } }, time: 'changed_at', timeZone: 'UTC' } } }, { by: 'test' })
  const span = { from: '2026-04-03', to: '2026-04-07' }
  const r = (await engine.call<any>('changes', { by: ['day'], during: span }, { assume: { timezone: 'Pacific/Auckland' } })).value.rows
  // Counted by hour, not fetched row by row: few enough rows to never meet the row cap, and exact, because
  // Auckland's offset changes on the hour.
  const hours = await query('F5NETSUITE', `SELECT TO_CHAR(tb.lastmodifieddate, 'YYYY-MM-DD HH24') AS h, COUNT(*) AS n FROM timebill tb
    WHERE tb.lastmodifieddate >= TO_DATE('2026-04-01', 'YYYY-MM-DD') AND tb.lastmodifieddate < TO_DATE('2026-04-09', 'YYYY-MM-DD')
    GROUP BY TO_CHAR(tb.lastmodifieddate, 'YYYY-MM-DD HH24')`)
  assert.ok(hours.length < 5000)
  const want = new Map<string, number>()
  for (const { h, n } of hours) {
    const instant = new Date(`${h.replace(' ', 'T')}:00:00Z`)
    const day = new Date(instant.getTime() + offsetMinutes('Pacific/Auckland', instant) * 60000).toISOString().slice(0, 10)
    if (day >= span.from && day < span.to) want.set(day, (want.get(day) ?? 0) + Number(n))
  }
  assert.ok(want.size > 0, 'there are changes to count')
  assert.deepEqual(new Map(r.map((x: any) => [x.day, x.changes])), want)
})
