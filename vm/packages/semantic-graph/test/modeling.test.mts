// What modeling a real business needs beyond arrows and measures: attributes of the records a fact reaches (a project's
// RAG, its go-live date), ranges on dates and numbers, conditions people name and keep to ("an at-risk project"), the
// conditions a fact is always kept to, and sources that hold only the current state — the same in memory and in SQL.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { check, evaluate, find, nodeText, resolveTerms, runSql, schemaProblems, type Question, type Schema, type Instance } from '../src/index.js'
import { instance as base, schema as branches } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const s: Schema = {
  ...branches,
  objects: {
    ...branches.objects,
    Project: { ...branches.objects.Project, attributes: {
      rag: { type: 'text', members: ['Red', 'Amber', 'Green'], description: 'the project health rating' },
      golive: { type: 'date', synonyms: ['go-live date'] },
      budget: { type: 'number' },
    } },
  },
  conditions: {
    'at-risk project': { on: 'Project', description: 'rated Red or Amber', synonyms: ['risky project'], where: [{ attribute: 'rag', in: ['Red', 'Amber'] }] },
    'hard sale': { on: 'Sale', description: 'a committed sale', where: [{ attribute: 'commitment', in: ['Hard'] }] },
    'sydney project': { on: 'Project', where: [{ to: 'Branch', via: ['branch'], in: ['Sydney'] }] },
  },
}
const I: Instance = { ...base, elements: { ...base.elements, Project: {
  j1: { ...base.elements.Project.j1, attributes: { rag: 'Red', golive: '2026-10-20', budget: 100 } },
  j2: { ...base.elements.Project.j2, attributes: { rag: 'Green', golive: '2026-12-01', budget: null } },
} } }
const { query, sources } = toSqlite(s, I)
const same = async (q: Question, expected: unknown[][], context = {}) => {
  const v = check(s, q, context)
  if (!v.ok) assert.fail(`${JSON.stringify(q)}: ${v.reason}`)
  assert.deepEqual(evaluate(s, I, v.plan).rows, expected, `memory: ${JSON.stringify(q)}`)
  assert.deepEqual((await runSql(s, sources, v.plan, query)).rows, expected, `SQL: ${JSON.stringify(q)}`)
  return v.plan
}

test('the schema with attributes on a dimension and named conditions is sound', () => {
  assert.deepEqual(schemaProblems(s), [])
  assert.match(schemaProblems({ ...s, objects: { ...s.objects, Sale: { ...s.objects.Sale, keptTo: ['nothing like it'] } } }).join(), /not a condition/)
})

test('an attribute of what a fact reaches: grouped by, and kept to by value or by range', async () => {
  await same({ measures: ['Sale.hours'], by: [{ attribute: 'rag', of: 'Project' }] }, [['Green', 8], ['Red', 21]])
  await same({ measures: ['Sale.hours'], where: [{ attribute: 'golive', of: 'Project', range: { from: '2026-10-01', to: '2026-11-01' } }] }, [[21]])
  await same({ measures: ['Sale.hours'], where: [{ attribute: 'budget', of: 'Project', range: { from: 50 } }] }, [[21]])
  const unknown = check(s, { measures: ['Sale.hours'], where: [{ attribute: 'rag', of: 'Project', in: ['Purple'] }] })
  assert.ok(!unknown.ok && /no value Purple — its values are Red, Amber, Green/.test(unknown.reason))
  const unsaid = check(s, { measures: ['Sale.hours'], by: [{ attribute: 'rag' }] })
  assert.ok(!unsaid.ok && /"of": "Project"/.test(unsaid.reason), 'says whose attribute it is')
  const dimension = check(s, { measures: ['Sale.hours'], where: [{ to: 'Branch', via: ['project', 'branch'], range: { from: 'a' } }] })
  assert.ok(!dimension.ok && /range keeps dates or numbers/.test(dimension.reason))
})

test('a named condition, reached from the fact through the object it is about', async () => {
  await same({ measures: ['Sale.hours'], where: [{ condition: 'at-risk project' }] }, [[21]])
  await same({ measures: ['Sale.hours'], by: [{ to: 'Month' }], where: [{ condition: 'sydney project' }] }, [['2026-09', 15], ['2026-10', 6]])
  // The same condition from a fact that reaches the object more than one way needs the path.
  const unknown = check(s, { measures: ['Sale.hours'], where: [{ condition: 'no such thing' }] })
  assert.ok(!unknown.ok && /its conditions are at-risk project, hard sale, sydney project/.test(unknown.reason))
})

test('a fact always kept to its conditions, unless a question sets one aside', async () => {
  const kept: Schema = { ...s, objects: { ...s.objects, Sale: { ...s.objects.Sale, keptTo: ['hard sale'] } } }
  const v = check(kept, { measures: ['Sale.hours'] })
  assert.ok(v.ok)
  assert.deepEqual(evaluate(kept, I, v.plan).rows, [[21]])
  assert.ok(v.plan.notes.some((n) => /Sale: kept to hard sale \(a committed sale\)/.test(n)))
  const all = check(kept, { measures: ['Sale.hours'], without: ['hard sale'] })
  assert.ok(all.ok)
  assert.deepEqual(evaluate(kept, I, all.plan).rows, [[29]])
  assert.ok(!all.plan.notes.some((n) => /kept to/.test(n)))
})

test('a source that holds only the current state answers now, and refuses an earlier day', () => {
  const current: Schema = { ...s, objects: { ...s.objects, Sale: { ...s.objects.Sale, history: 'current' } } }
  const now = check(current, { measures: ['Sale.hours'] }, { today: '2026-09-15' })
  assert.ok(now.ok && now.plan.notes.some((n) => /as it stands now/.test(n)))
  const then = check(current, { measures: ['Sale.hours'], asOf: '2026-07-14' }, { today: '2026-09-15' })
  assert.ok(!then.ok && then.rule === 'F2' && /cannot be read back/.test(then.reason))
})

test('the agent finds conditions and attributes, and reads them in the graph', () => {
  assert.deepEqual(find(s, 'risky project').map((f) => f.kind), ['condition'])
  const terms = resolveTerms(s, 'hours on at-risk projects', '2026-09-15')
  assert.ok(terms.terms.some((t) => t.means.some((m: any) => m.kind === 'condition' && m.condition === 'at-risk project')), JSON.stringify(terms))
  const text = nodeText(s, 'Project')
  assert.match(text, /rag\s+text\s+Red, Amber, Green — the project health rating/)
  assert.match(text, /at-risk project\s+rated Red or Amber/)
})

test('a condition about one of the facts asked about keeps that fact alone', async () => {
  const v = check(s, { measures: ['Sale.hours', 'Budget.budget'], by: [{ to: 'Branch', via: { Sale: ['project', 'branch'] } }], where: [{ condition: 'hard sale' }, { to: 'BudgetVersion', in: ['base'] }], currency: 'AUD', span: { from: '2026-09-01', to: '2026-11-01' } })
  if (!v.ok) assert.fail(v.reason)
  const hard = evaluate(s, I, v.plan).rows
  const all = check(s, { measures: ['Sale.hours', 'Budget.budget'], by: [{ to: 'Branch', via: { Sale: ['project', 'branch'] } }], where: [{ to: 'BudgetVersion', in: ['base'] }], currency: 'AUD', span: { from: '2026-09-01', to: '2026-11-01' } })
  if (!all.ok) assert.fail(all.reason)
  const every = evaluate(s, I, all.plan).rows
  const budgetBy = (rows: unknown[][]) => Object.fromEntries(rows.filter((r) => r[2] !== null).map((r) => [r[0], r[2]]))
  assert.deepEqual(budgetBy(hard), budgetBy(every), 'the budget is not kept to hard sales')
  assert.ok(hard.reduce((n, r) => n + Number(r[1] ?? 0), 0) < every.reduce((n, r) => n + Number(r[1] ?? 0), 0), 'the sales are')
  assert.deepEqual((await runSql(s, sources, v.plan, query)).rows, hard)
})

test('money on a fact with no time converts at the rates of the day it is answered', async () => {
  const timeless: Schema = { ...s, objects: { ...s.objects, Contract: { ...s.objects.Contract, arrows: { project: 'Project' } } } }
  const t = toSqlite(timeless, I)
  const v = check(timeless, { measures: ['Contract.value'], currency: 'AUD' }, { today: '2026-12-31' })
  if (!v.ok) assert.fail(v.reason)
  assert.ok(v.plan.notes.some((n) => /at the rates of 2026-12-31/.test(n)))
  assert.deepEqual((await runSql(timeless, t.sources, v.plan, t.query)).rows, evaluate(timeless, I, v.plan).rows)
  assert.ok(!check(timeless, { measures: ['Contract.value'], currency: 'AUD' }).ok, 'without a day to answer on, it asks for one')
})

test('totals and shares are checked as their question was: the same day, the same conditions set aside', () => {
  const timeless: Schema = { ...s, objects: { ...s.objects, Contract: { ...s.objects.Contract, arrows: { project: 'Project' }, keptTo: ['sydney project'] } } }
  const v = check(timeless, { measures: ['Contract.value'], by: [{ attribute: 'rag', of: 'Project' }], currency: 'AUD', totals: [[]], without: ['sydney project'] }, { today: '2026-12-31' })
  if (!v.ok) assert.fail(v.reason)
  assert.deepEqual(evaluate(timeless, I, v.plan).totals?.[0].rows, [[15000]], 'both projects, as the question set the condition aside')
})

test('a fact states its grain and is sliced by dimensions: entities, attributes and calendar levels, each by its paths', async () => {
  const { dimensions, conformedDimensions, grainOf } = await import('../src/index.js')
  assert.deepEqual(grainOf(s, 'Sale'), ['person', 'project', 'day'])
  assert.deepEqual(schemaProblems({ ...s, objects: { ...s.objects, Sale: { ...s.objects.Sale, grain: ['person', 'day'] } } }).filter((p) => /grain/.test(p)).length, 1)
  assert.deepEqual(schemaProblems({ ...s, objects: { ...s.objects, Sale: { ...s.objects.Sale, grain: ['day', 'person', 'project'] } } }), [])
  const d = new Map(dimensions(s, 'Sale').map((x) => [x.name, x]))
  assert.equal(d.get('Month')?.kind, 'calendar')
  assert.deepEqual(d.get('Project')?.default, ['project'])
  assert.equal(d.get('Branch')?.default, undefined, 'several paths and no default: a question says which')
  assert.ok((d.get('Branch')?.paths.length ?? 0) > 1)
  assert.deepEqual([d.get('commitment')?.kind, d.get('commitment')?.of], ['attribute', 'Sale'])
  assert.deepEqual([d.get('Project.rag')?.kind, d.get('Project.rag')?.of, d.get('Project.rag')?.default], ['attribute', 'Project', ['project']])
  assert.ok(d.get('Person')?.partial, 'a sponsor may be none')
  assert.deepEqual(conformedDimensions(s, ['Sale', 'Budget']).map((x) => x.name), ['Month', 'Quarter', 'Year', 'Branch', 'Region', 'State'])
  assert.throws(() => dimensions(s, 'Project'), /dimensions belong to facts/)
})
