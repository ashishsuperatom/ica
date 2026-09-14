// A relation computed here — rows from a non-SQL source — joins relations held in a SQL source by reading their rows
// here too: exchange rates to convert it, and the attributes of an entity it names. A source that holds back rows
// cannot be joined that way.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, GraphStore, type Contract } from '../src/index.js'

const HOURS = [
  { worked_on: '2026-09-01', employee_id: 'e1', currency_code: 'NZD', amount: 100 },
  { worked_on: '2026-09-02', employee_id: 'e2', currency_code: 'AUD', amount: 50 },
]
const PEOPLE = [{ employee_id: 'e1', team: 'north' }, { employee_id: 'e2', team: 'south' }]
const RATES = [{ from_code: 'NZD', to_code: 'AUD', rate: 0.9 }]

const billed: Contract = { name: 'billed', kind: 'concept', description: 'Billed time.', reads: { sources: ['TIMESHEETS'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { employee: { column: 'employee_id', history: 'stable', entity: 'employee' }, currency: { column: 'currency_code', history: 'stable' } },
           measures: { billed: { aggregate: 'sum', column: 'amount', unit: 'money', kind: 'flow', currency: 'currency' } }, time: 'worked_on' } }
const people: Contract = { name: 'people', kind: 'concept', description: 'People.', reads: { sources: ['HR'], programs: [] }, params: {}, returns: 'relation',
  shape: { grain: 'employee', dimensions: { employee: { column: 'employee_id', history: 'stable', entity: 'employee' }, team: { column: 'team', history: 'current' } },
           measures: { headcount: { aggregate: 'count', unit: 'people', kind: 'stock' } } } }
const fx: Contract = { name: 'fx', kind: 'concept', description: 'Rates.', reads: { sources: ['HR'], programs: [] }, params: {}, returns: 'relation',
  shape: { dimensions: { from_currency: { column: 'from_code', history: 'stable' }, to_currency: { column: 'to_code', history: 'stable' } },
           measures: { rate: { aggregate: 'max', column: 'rate', unit: 'ratio', kind: 'stock' } } } }

async function setup(capped = false) {
  // HR is a SQL source; its query is answered from the rows each statement names.
  const query = async (_source: string, sql: string) => {
    const rows: any[] = /FROM hr_people/.test(sql) ? PEOPLE.map((p) => ({ ...p })) : /FROM hr_fx/.test(sql) ? RATES.map((r) => ({ ...r })) : []
    if (capped) Object.defineProperty(rows, 'notes', { value: ['Row limit applied'], enumerable: false })
    return rows
  }
  const store = new GraphStore(join(mkdtempSync(join(tmpdir(), 'graph-lj-')), 'g.sqlite'))
  const engine = createEngine({ store, modulesDir: mkdtempSync(join(tmpdir(), 'graph-mod-')), dialects: { HR: 'sqlite' }, query, today: () => '2026-09-14',
    checks: 'light', assumptions: { 'exchange rates': { relation: 'fx', at: 'end' } } })
  await engine.define({ body: `export default async (ctx, { from, to }) => ({ source: 'TIMESHEETS', rows: ${JSON.stringify(HOURS)}.filter((r) => r.worked_on >= from && r.worked_on < to) })`, contract: billed }, { by: 'test' })
  await engine.define({ body: `export default () => ({ source: 'HR', sql: 'SELECT employee_id, team FROM hr_people' })`, contract: people }, { by: 'test' })
  await engine.define({ body: `export default () => ({ source: 'HR', sql: 'SELECT from_code, to_code, rate FROM hr_fx' })`, contract: fx }, { by: 'test' })
  return engine
}
const SEPTEMBER = { from: '2026-09-01', to: '2026-10-01' }

test('local rows converted at rates held in a SQL source', async () => {
  const engine = await setup()
  const r = await engine.call<any>('billed', { measures: ['billed'], during: SEPTEMBER, currency: 'AUD' })
  assert.ok(Math.abs(r.value.rows[0].billed - (100 * 0.9 + 50)) < 1e-9)
})

test('local rows split by an attribute of an entity held in a SQL source', async () => {
  const engine = await setup()
  const r = await engine.call<any>('billed', { measures: ['billed'], by: ['employee.team'], during: SEPTEMBER, currency: 'AUD' })
  assert.deepEqual(new Map(r.value.rows.map((x: any) => [x['employee.team'] ?? x.employee_team ?? x.team, x.billed])).size, 2)
})

test('refused: a source that holds back rows cannot be read here to join', async () => {
  const engine = await setup(true)
  await assert.rejects(engine.call('billed', { measures: ['billed'], during: SEPTEMBER, currency: 'AUD' }), /more rows than HR returns at once/)
})
