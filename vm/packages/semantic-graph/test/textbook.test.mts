// The cases the literature says go wrong, each with its right answer worked out by hand — and, for the fan and chasm
// traps, the wrong answer a plain join gives, so the test shows what the algebra prevents.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMove, canonical, check, conformance, counterfactual, evaluate, nextMoves, schemaProblems, type Question, type Schema } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'

const plan = (q: Question) => { const v = check(s, q); if (!v.ok) assert.fail(`${v.rule}: ${v.reason}`); return v.plan }
const run = (q: Question) => evaluate(s, I, plan(q)).rows
const refused = (q: Question, rule: string, pattern?: RegExp) => { const v = check(s, q); assert.equal(v.ok, false, 'expected a refusal'); if (!v.ok) { assert.equal(v.rule, rule, v.reason); if (pattern) assert.match(v.reason, pattern) } return v }
const close = (a: unknown, b: number) => assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`)

test('the schema is well formed and the data conforms to it', () => {
  assert.deepEqual(schemaProblems(s), [])
  assert.deepEqual(conformance(s, I), [])
})

test('fan trap: a contract is counted once per project, not once per sale', () => {
  const rows = run({ measures: ['Sale.hours', 'Contract.value'], by: [{ to: 'Branch', via: ['project', 'branch'] }], currency: 'AUD' })
  assert.deepEqual(rows, [['b1', 21, 10000], ['b3', 8, 5000]])
  // A plain join of sales to contracts, summed by branch, counts j1's contract four times.
  const naive = I.rows.Sale.filter((r) => r.arrows.project === 'j1').reduce((a) => a + I.rows.Contract[0].measures.value!, 0)
  assert.equal(naive, 40000)
})

test('fan trap: a sale cannot be grouped by something it is not kept by', () => {
  refused({ measures: ['Contract.value'], by: [{ to: 'Person', via: ['project', 'owner'] }, { attribute: 'commitment' }], currency: 'AUD' }, 'A1', /no fact asked about has the attribute|commitment/)
})

test('chasm trap: sales and budget are added up apart, then put side by side', () => {
  const q: Question = {
    measures: ['Sale.amount', 'Budget.budget', '[Sale.amount] / [Budget.budget]'],
    by: [{ to: 'Branch', via: { Sale: ['project', 'branch'], Budget: ['branch'] } }, { to: 'Month' }],
    where: [{ to: 'BudgetVersion', in: ['base'] }],
    span: { from: '2026-09-01', to: '2026-11-01' }, currency: 'AUD',
  }
  const p = plan(q)
  assert.equal(p.outputs[2].unit, 'ratio')
  const rows = run(q)
  assert.deepEqual(rows.map((r) => r.slice(0, 4)), [['b1', '2026-09', 1500, 2000], ['b1', '2026-10', 800, 1000], ['b3', '2026-09', 900, null]])
  close(rows[0][4], 0.75); close(rows[1][4], 0.8); assert.equal(rows[2][4], null)
  // Joining the rows first gives September's budget once per sale.
  const naiveBudget = I.rows.Sale.filter((r) => r.arrows.project === 'j1' && r.arrows.day.startsWith('2026-09')).length * 2000
  assert.equal(naiveBudget, 4000)
})

test('versions: a budget is never added across versions', () => {
  refused({ measures: ['Budget.budget'], by: [{ to: 'Month' }], currency: 'AUD' }, 'F1', /versions/)
  assert.deepEqual(run({ measures: ['Budget.budget'], by: [{ to: 'BudgetVersion' }], currency: 'AUD', span: { from: '2026-09-01', to: '2026-10-01' } }), [['base', 2000], ['forecast', 9999]])
})

test('a filter on one fact\'s version is about that fact; a filter on something another fact cannot reach is refused', () => {
  plan({ measures: ['Sale.hours', 'Budget.budget'], by: [{ to: 'Month' }], where: [{ to: 'BudgetVersion', in: ['base'] }], currency: 'AUD' })
  refused({ measures: ['Sale.hours', 'Budget.budget'], by: [{ to: 'Month' }], where: [{ to: 'Person', via: { Sale: ['person'] }, in: ['p1'] }, { to: 'BudgetVersion', in: ['base'] }], currency: 'AUD' }, 'C3')
})

test('role-playing: a sale reaches a branch through its project and through its person — the question says which', () => {
  const v = refused({ measures: ['Sale.hours'], by: [{ to: 'Branch' }] }, 'A2')
  const paths = (v as any).choices[0].paths as string[]
  for (const p of ['project.branch', 'person.branch', 'project.owner.branch']) assert.ok(paths.includes(p), p)
  // A manager's branch is another person's branch: taken when named, never one of the readings to choose from.
  assert.ok(!paths.includes('person.manager.branch'))
  assert.ok(check(s, { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['person', 'manager', 'branch'] }], span: { from: '2026-09-01', to: '2026-10-01' } }).ok)
})

test('a path is one link per step; a dotted name is refused, never read as some other path', () => {
  const v = check(s, { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['person.branch'] }] })
  assert.ok(!v.ok && /Sale has no link "person.branch" — its links are person, project, day/.test(v.reason))
})

test('path equations: a project\'s state through its branch is its state — one path, not two', () => {
  const v = refused({ measures: ['Sale.hours'], by: [{ to: 'State' }] }, 'A2')
  const paths = (v as any).choices[0].paths as string[]
  assert.ok(paths.includes('project.state') && !paths.includes('project.branch.state'))
  assert.deepEqual(run({ measures: ['Sale.hours'], by: [{ to: 'State', via: ['project', 'branch', 'state'] }] }), run({ measures: ['Sale.hours'], by: [{ to: 'State', via: ['project', 'state'] }] }))
})

test('as of: a person\'s branch is the one they were in on the day of the sale', () => {
  assert.deepEqual(run({ measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['person', 'branch'] }], span: { from: '2026-09-01', to: '2026-10-01' } }), [['b1', 18], ['b2', 5]])
})

test('a hierarchy that is not time: branch → state → region, drilled up and back down', () => {
  const q0: Question = { measures: ['Sale.hours'], by: [{ to: 'Branch', via: ['project', 'branch'] }] }
  assert.ok(nextMoves(s, q0).some((m) => m.reads === 'Branch → State (state)'))
  const q1 = applyMove(s, q0, { move: 'drill up', target: 0, along: 'state' })
  assert.ok(q1.verdict.ok)
  const q2 = applyMove(s, q1.question, { move: 'drill up', target: 0, along: 'region' })
  assert.deepEqual(evaluate(s, I, (q2.verdict as any).plan).rows, [['East', 21], ['West', 8]])
  const back = applyMove(s, q2.question, { move: 'drill down', target: 0 })
  assert.deepEqual(evaluate(s, I, (back.verdict as any).plan).rows, [['NSW', 21], ['WA', 8]])
  // A refused move leaves the state as it was.
  // Headcount reaches a branch by its own arrow, so it can stand beside the hours; a budget cannot without a version.
  assert.ok(applyMove(s, q0, { move: 'add measure', measure: 'Headcount.people' }).verdict.ok)
  const bad = applyMove(s, q0, { move: 'add measure', measure: 'Budget.budget' })
  assert.equal(bad.verdict.ok, false)
  assert.deepEqual(bad.question, q0)
})

test('time only rolls up, and a span is cut at a fact\'s own grain', () => {
  refused({ measures: ['Budget.budget'], by: [{ to: 'Day' }], where: [{ to: 'BudgetVersion', in: ['base'] }], currency: 'AUD' }, 'A1', /kept by month/)
  refused({ measures: ['Budget.budget'], where: [{ to: 'BudgetVersion', in: ['base'] }], currency: 'AUD', span: { from: '2026-09-15', to: '2026-10-01' } }, 'D4')
  assert.deepEqual(run({ measures: ['Sale.hours'], by: [{ to: 'Quarter' }] }), [['2026-Q3', 23], ['2026-Q4', 6]])
})

test('stock: headcount at the end of a quarter is its last month, not the sum of three', () => {
  assert.deepEqual(run({ measures: ['Headcount.people'], by: [{ to: 'Quarter' }] }), [['2026-Q3', 7]])
  assert.deepEqual(run({ measures: ['Headcount.people'], by: [{ to: 'Branch' }, { to: 'Quarter' }] }), [['b1', '2026-Q3', 7], ['b2', '2026-Q3', 0]])
  assert.deepEqual(run({ measures: ['Headcount.people'], by: [{ to: 'Month' }] }), [['2026-07', 8], ['2026-08', 9], ['2026-09', 7]])
  refused({ measures: ['Headcount.desks'], by: [{ to: 'Quarter' }] }, 'B1', /last, the first or the average/)
  plan({ measures: ['Headcount.desks'], by: [{ to: 'Month' }] })
})

test('money: added only in one currency — converted at the rate on the day, or kept apart', () => {
  const undated: Schema = structuredClone(s)
  delete undated.objects.Contract.arrows!.signed
  const v = check(undated, { measures: ['Contract.value'], currency: 'AUD' })
  assert.ok(!v.ok && v.rule === 'E2' && /has no date/.test(v.reason))
  refused({ measures: ['Sale.amount'] }, 'E1', /currency/)
  assert.deepEqual(run({ measures: ['Sale.amount'], by: [{ attribute: 'currency' }] }), [['AUD', 2300], ['NZD', 1000]])
  assert.deepEqual(run({ measures: ['Sale.amount'], currency: 'AUD' }), [[3200]])
})

test('units: hours are not added to money; money over hours is a rate', () => {
  refused({ measures: ['[Sale.amount] + [Sale.hours]'], currency: 'AUD' }, 'E1', /not the same unit/)
  assert.equal(plan({ measures: ['[Sale.amount] / [Sale.hours]'], currency: 'AUD' }).outputs[0].unit, 'money/h')
})

test('a rate is averaged weighted by its hours, never added', () => {
  close(run({ measures: ['Sale.rate'], currency: 'AUD' })[0][0], 3200 / 29)
  const bad: Schema = structuredClone(s)
  bad.objects.Sale.measures!.rate.aggregate = 'sum'
  assert.ok(schemaProblems(bad).some((p) => /value per unit/.test(p)))
})

test('count distinct: people are counted afresh in each group', () => {
  assert.deepEqual(run({ measures: ['Sale.people'], by: [{ to: 'Month' }] }), [['2026-09', 2], ['2026-10', 2]])
  assert.deepEqual(run({ measures: ['Sale.people'] }), [[3]])
})

test('a partial arrow keeps the rows with nothing at its end', () => {
  const q: Question = { measures: ['Sale.hours'], by: [{ to: 'Person', via: ['project', 'sponsor'] }] }
  assert.ok(plan(q).notes.some((n) => /none/.test(n)))
  assert.deepEqual(run(q), [['p3', 21], [null, 8]])
})

test('a self arrow: everyone under a manager', () => {
  assert.deepEqual(run({ measures: ['Sale.hours'], where: [{ to: 'Person', via: ['person'], under: 'manager', in: ['p1'] }] }), [[29]])
  assert.deepEqual(run({ measures: ['Sale.hours'], where: [{ to: 'Person', via: ['person'], under: 'manager', in: ['p2'] }] }), [[14]])
  refused({ measures: ['Sale.hours'], where: [{ to: 'Branch', via: ['project', 'branch'], under: 'state', in: ['b1'] }] }, 'A5')
})

test('names people use are members; a member that does not exist is refused', () => {
  assert.deepEqual(run({ measures: ['Sale.hours'], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['Sydney'] }] }), [[21]])
  refused({ measures: ['Sale.hours'], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['Hobart'] }] }, 'A1', /no member Hobart/)
})

test('the same question in different words has one canonical form', () => {
  const a = canonical(s, { measures: ['Sale.hours'], by: [{ to: 'State', via: ['project', 'branch', 'state'] }], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['Sydney'] }] })
  const b = canonical(s, { measures: ['Sale.hours'], by: [{ to: 'State', via: { Sale: ['project', 'state'] } }], where: [{ to: 'Branch', via: ['project', 'branch'], in: ['b1'] }] })
  assert.ok(a); assert.equal(a, b)
})

test('the schema refuses what is not well formed', () => {
  const bad: Schema = structuredClone(s)
  ;(bad.objects.State.arrows!.region as any).partial = true
  bad.objects.Region.arrows = { state: 'State' }
  const problems = schemaProblems(bad)
  assert.ok(problems.some((p) => /rollup is total/.test(p)))
  assert.ok(problems.some((p) => /belongs, through its arrows, to itself/.test(p)))
})

test('data that breaks the schema is named row by row', () => {
  const bad = structuredClone(I)
  bad.rows.Sale.push(structuredClone(bad.rows.Sale[0]))
  bad.elements.Person.p2.history!.branch.push({ from: '2026-06-01', value: 'b2' })
  bad.elements.Person.p1.arrows!.manager = 'p3'
  const problems = conformance(s, bad)
  assert.ok(problems.some((p) => /repeats the grain/.test(p)))
  assert.ok(problems.some((p) => /overlap/.test(p)))
  assert.ok(problems.some((p) => /comes back/.test(p)))
})

test('intervention and counterfactual: a changed rate flows into the revenue computed from it', () => {
  const mini: Schema = {
    name: 'rates',
    objects: {
      Person: { kind: 'entity' },
      Day: { kind: 'calendar', level: 'day' },
      RateCard: { kind: 'fact', arrows: { person: 'Person' }, measures: { rate: { unit: 'AUD/h', kind: 'value-per-unit', aggregate: 'max' } } },
      Work: { kind: 'fact', arrows: { person: 'Person', day: 'Day' }, measures: { hours: { unit: 'h', kind: 'flow', aggregate: 'sum' }, revenue: { unit: 'AUD', kind: 'flow', aggregate: 'sum' } } },
    },
  }
  const hours = [['p1', '2026-09-01', 8], ['p1', '2026-09-02', 6], ['p2', '2026-09-01', 7]] as const
  const model = {
    schema: mini,
    programs: [
      { produces: 'Person', reads: [], run: () => ({ p1: {}, p2: {} }) },
      { produces: 'RateCard', reads: ['Person'], run: () => [{ arrows: { person: 'p1' }, measures: { rate: 150 } }, { arrows: { person: 'p2' }, measures: { rate: 100 } }] },
      {
        produces: 'Work', reads: ['RateCard'],
        run: (inst: any) => hours.map(([person, day, h]) => ({ arrows: { person, day }, measures: { hours: h, revenue: h * inst.rows.RateCard.find((r: any) => r.arrows.person === person).measures.rate } })),
      },
    ],
  }
  const c = counterfactual(model, { measures: ['Work.revenue', '[Work.revenue] / [Work.hours]'], by: [{ to: 'Person' }] }, [{ on: 'RateCard', match: { person: 'p2' }, set: { rate: 200 } }])
  assert.deepEqual(c.rows.map((r) => [r.key[0], r.actual[0], r.intervened[0], r.difference[0]]), [['p1', 2100, 2100, 0], ['p2', 700, 1400, 700]])
  assert.equal(check(mini, { measures: ['[Work.revenue] / [Work.hours]'] }).ok && (check(mini, { measures: ['[Work.revenue] / [Work.hours]'] }) as any).plan.outputs[0].unit, 'AUD/h')
  assert.ok(c.notes.some((n) => /produced again: Work/.test(n)))
})
