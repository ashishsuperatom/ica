// The dialects. DuckDB runs the same questions as SQLite on the same data and must give the evaluator's answers (when
// the duckdb CLI is installed). Oracle — NetSuite's SuiteQL — and SQL Server cannot run here: their statements are
// checked for the forms those databases need, and are not claimed to be verified.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, compileSql, duckdb, evaluate, mssql, oracle, runSql, type Question, type Schema } from '../src/index.js'
import { instance as I, schema as base } from './fixtures/branches.js'
import { duckdbInstalled, toDuckdb } from './fixtures/duckdb.js'
import { toSqlite } from './fixtures/sqlite.js'

const B = { to: 'Branch', via: ['project', 'branch'] }
function schema(): Schema {
  const s: Schema = structuredClone(base)
  s.objects.Day.arrows = { month: 'Month', week: 'Week', fq: 'FiscalQuarter' }
  s.objects.Month.arrows = { quarter: 'Quarter', fq: 'FiscalQuarter' }
  s.objects.Week = { kind: 'calendar', level: 'week' }
  s.objects.FiscalQuarter = { kind: 'calendar', fiscal: { period: 'quarter', startMonth: 7 } }
  s.objects.Sale.measures!.medianHours = { unit: 'h', kind: 'flow', aggregate: 'median' }
  return s
}
const QUESTIONS: Question[] = [
  { measures: ['Sale.hours', 'Contract.value'], by: [B], currency: 'AUD' },
  { measures: ['Sale.amount', 'Budget.budget'], by: [{ to: 'Branch', via: { Sale: ['project', 'branch'], Budget: ['branch'] } }, { to: 'Month' }], where: [{ to: 'BudgetVersion', in: ['base'] }], span: { from: '2026-09-01', to: '2026-11-01' }, currency: 'AUD' },
  { measures: ['Sale.hours'], by: [{ to: 'Region', via: ['person', 'branch', 'state', 'region'] }, { to: 'Week' }] },
  { measures: ['Sale.hours'], by: [{ to: 'FiscalQuarter' }, { to: 'Quarter' }] },
  { measures: ['Headcount.people'], by: [{ to: 'Branch' }, { to: 'Quarter' }] },
  { measures: ['Sale.rate', 'Sale.people', 'Sale.medianHours'], by: [{ attribute: 'commitment' }], currency: 'AUD' },
  { measures: ['Sale.hours'], where: [{ to: 'Person', via: ['person'], under: 'manager', in: ['p2'] }] },
  { measures: ['Sale.hours'], by: [{ to: 'Person', via: ['project', 'sponsor'] }], totals: [[]] },
]

test('DuckDB gives the evaluator\'s answers', { skip: !duckdbInstalled && 'the duckdb CLI is not installed' }, async () => {
  const s = schema()
  const { query, sources } = toDuckdb(s, I)
  for (const q of QUESTIONS) {
    const v = check(s, q)
    if (!v.ok) assert.fail(v.reason)
    const got = await runSql(s, sources, v.plan, query, duckdb)
    const round = (rows: unknown[][]) => rows.map((r) => r.map((x) => (typeof x === 'number' ? Math.round(x * 1e6) / 1e6 : x)))
    assert.deepEqual(round(got.rows), round(evaluate(s, I, v.plan).rows), JSON.stringify(q))
  }
})

test('Oracle and SQL Server statements take the forms those databases need', () => {
  const s = schema()
  const { sources } = toSqlite(s, I)
  const v = check(s, { measures: ['Sale.amount', 'Sale.medianHours'], by: [{ to: 'Branch', via: ['person', 'branch'] }, { to: 'FiscalQuarter' }], span: { from: '2026-07-01', to: '2026-10-01' }, currency: 'AUD', asOf: '2026-09-15' })
  assert.ok(v.ok)
  const [ora] = compileSql(s, sources, v.plan, oracle)
  assert.match(ora.sql, /TO_DATE\(@p\d+, 'YYYY-MM-DD'\)/)
  assert.match(ora.sql, /MEDIAN\(/)
  assert.match(ora.sql, /FETCH FIRST 1 ROWS ONLY/)
  assert.match(ora.sql, /ADD_MONTHS\(TRUNC\(/)
  assert.doesNotMatch(ora.sql, /LIMIT|strftime|json_group_array| AS j\d/)
  const [ms] = compileSql(s, sources, v.plan, mssql)
  assert.match(ms.sql, /SELECT TOP 1 /)
  assert.match(ms.sql, /STRING_AGG\(/)
  assert.match(ms.sql, /CAST\(@p\d+ AS date\)/)
  assert.doesNotMatch(ms.sql, /LIMIT|strftime|f\."|j0\."/)
  const under = check(s, { measures: ['Sale.hours'], where: [{ to: 'Person', via: ['person'], under: 'manager', in: ['p2'] }] })
  assert.ok(under.ok)
  assert.throws(() => compileSql(s, sources, under.plan, mssql), /not compiled for mssql/)
  assert.match(compileSql(s, sources, under.plan, oracle)[0].sql, /WITH up\(k, anc\) AS \(.*UNION ALL/)
})
