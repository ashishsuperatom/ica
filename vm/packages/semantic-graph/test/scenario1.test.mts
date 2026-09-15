// Scenario 1 on simulated data. Every expected number is computed straight from the raw simulated records, without
// the schema, paths or evaluator — so a pass means the graph's answer equals the answer worked out by hand.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMove, canonical, check, conformance, counterfactual, evaluate, materialise, schemaProblems, type Question } from '../src/index.js'
import { allocations, budgets, exchange, model, people, projects, rates, schema as s } from './fixtures/fusion5-sim.js'

const I = materialise(model)
const answer = (q: Question) => { const v = check(s, q); if (!v.ok) assert.fail(`${v.rule}: ${v.reason}`); return evaluate(s, I, v.plan).rows }
const refusal = (q: Question) => { const v = check(s, q); assert.equal(v.ok, false); return v as Extract<typeof v, { ok: false }> }
const round = (rows: unknown[][]) => rows.map((r) => r.map((x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : x)))
const project = (id: string) => projects.find((p) => p.id === id)!

/** Every allocated day, flat, from the raw records. */
const days = allocations.flatMap((a) => a.days.map((day) => {
  const rate = rates.get(`${a.project}|${a.person}`)
  return { ...a, day, month: day.slice(0, 7), hours: a.hoursPerDay, revenue: rate === undefined ? 0 : a.hoursPerDay * rate }
}))
const sumBy = <T,>(xs: T[], key: (x: T) => string, value: (x: T) => number) => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + value(x))
  return m
}

test('the Scenario 1 schema is well formed and the simulated data conforms', () => {
  assert.deepEqual(schemaProblems(s), [])
  assert.deepEqual(conformance(s, I), [])
  assert.ok(I.rows.AllocationDay.length > 200)
})

test('projected revenue from allocations for AU, September and October, hard and soft', () => {
  const rows = answer({
    measures: ['AllocationDay.revenue'], by: [{ to: 'Month' }, { attribute: 'commitment' }],
    where: [{ to: 'Subsidiary', via: ['project', 'subsidiary'], in: ['AU'] }],
    span: { from: '2026-09-01', to: '2026-11-01' }, currency: 'AUD',
  })
  const expected = sumBy(days.filter((d) => project(d.project).subsidiary === '2'), (d) => `${d.month}|${d.commitment}`, (d) => d.revenue)
  assert.deepEqual(round(rows), round([...expected].sort().map(([k, v]) => [...k.split('|'), v])))
})

test('both subsidiaries in AUD: NZD revenue converted at the rate on the last day of the span', () => {
  const rows = answer({ measures: ['AllocationDay.revenue'], by: [{ to: 'Month' }], span: { from: '2026-09-01', to: '2026-11-01' }, currency: 'AUD' })
  const rateAtEnd = exchange.filter((x) => x.day <= '2026-10-31').sort((a, b) => b.day.localeCompare(a.day))[0].rate
  const expected = sumBy(days, (d) => d.month, (d) => d.revenue * (project(d.project).currency === 'NZD' ? rateAtEnd : 1))
  assert.deepEqual(round(rows), round([...expected].sort()))
})

test('AU revenue against the Base Budget by project pillar and month', () => {
  const rows = answer({
    measures: ['AllocationDay.revenue', 'BudgetLine.budget', '[AllocationDay.revenue] - [BudgetLine.budget]'],
    by: [{ to: 'Pillar', via: { AllocationDay: ['project', 'pillar'], BudgetLine: ['pillar'] } }, { to: 'Month' }],
    where: [{ to: 'Subsidiary', via: { AllocationDay: ['project', 'subsidiary'], BudgetLine: ['subsidiary'] }, in: ['AU'] }, { to: 'BudgetCategory', in: ['Base Budget'] }],
    span: { from: '2026-09-01', to: '2026-11-01' }, currency: 'AUD',
  })
  const revenue = sumBy(days.filter((d) => project(d.project).subsidiary === '2'), (d) => `${project(d.project).pillar}|${d.month}`, (d) => d.revenue)
  const budget = sumBy(budgets.filter((b) => b.subsidiary === '2' && b.category === '5'), (b) => `${b.pillar}|${b.month}`, (b) => b.amount)
  const keys = [...new Set([...revenue.keys(), ...budget.keys()])].sort()
  const expected = keys.map((k) => { const r = revenue.get(k) ?? null, b = budget.get(k) ?? null; return [...k.split('|'), r, b, r === null || b === null ? null : r - b] })
  assert.deepEqual(round(rows), round(expected))
})

test('refused, with the reason: the questions that went wrong in the trials', () => {
  assert.match(refusal({ measures: ['AllocationDay.revenue', 'BudgetLine.budget'], by: [{ to: 'Customer' }], where: [{ to: 'BudgetCategory', in: ['5'] }], currency: 'AUD' }).reason, /BudgetLine does not reach Customer/)
  const pillar = refusal({ measures: ['AllocationDay.hours'], by: [{ to: 'Pillar' }] })
  assert.equal(pillar.rule, 'A2')
  assert.ok(pillar.choices![0].paths.includes('project.pillar') && pillar.choices![0].paths.includes('person.pillar'))
  assert.equal(refusal({ measures: ['BudgetLine.budget'], by: [{ to: 'Day' }], where: [{ to: 'BudgetCategory', in: ['5'] }], currency: 'AUD' }).rule, 'A1')
  assert.equal(refusal({ measures: ['BudgetLine.budget'], by: [{ to: 'Month' }], currency: 'AUD' }).rule, 'F1')
  assert.match(refusal({ measures: ['AllocationDay.hours'], where: [{ to: 'Subsidiary', via: ['project', 'subsidiary'], in: ['Singapore'] }] }).reason, /no member Singapore/)
})

test('people by the pillar they were in that day: someone who moved counts where they were', () => {
  const rows = answer({ measures: ['AllocationDay.hours'], by: [{ to: 'Pillar', via: ['person', 'pillar'] }, { to: 'Month' }] })
  const pillarOn = (id: string, day: string) => { const p = people.find((x) => x.id === id)!; return p.moves && day >= p.moves.on ? p.moves.to : p.pillar }
  const expected = sumBy(days, (d) => `${pillarOn(d.person, d.day)}|${d.month}`, (d) => d.hours)
  assert.deepEqual(rows, [...expected].sort().map(([k, v]) => [...k.split('|'), v]))
})

test('people allocated each month are counted once each', () => {
  const rows = answer({ measures: ['AllocationDay.people'], by: [{ to: 'Month' }] })
  const expected = [...new Set(days.map((d) => d.month))].sort().map((m) => [m, new Set(days.filter((d) => d.month === m).map((d) => d.person)).size])
  assert.deepEqual(rows, expected)
})

test('drill up from projects to their pillars gives the same numbers as asking by project pillar', () => {
  const byProject: Question = { measures: ['AllocationDay.hours'], by: [{ to: 'Project' }] }
  const up = applyMove(s, byProject, { move: 'drill up', target: 0, along: 'pillar' })
  assert.ok(up.verdict.ok)
  assert.deepEqual(evaluate(s, I, (up.verdict as any).plan).rows, answer({ measures: ['AllocationDay.hours'], by: [{ to: 'Pillar', via: ['project', 'pillar'] }] }))
  assert.equal(canonical(s, up.question), canonical(s, { measures: ['AllocationDay.hours'], by: [{ to: 'Pillar', via: ['project', 'pillar'] }] }))
})

test('what if j1 were charged at 300 an hour: only j1\'s priced hours change, and revenue is produced again from the new rate', () => {
  const c = counterfactual(model, { measures: ['AllocationDay.revenue'], by: [{ to: 'Project' }], currency: 'AUD', span: { from: '2026-09-01', to: '2026-11-01' } }, [{ on: 'RateCard', match: { project: 'j1' }, set: { rate: 300 } }])
  const expected = days.filter((d) => d.project === 'j1' && rates.has(`j1|${d.person}`)).reduce((a, d) => a + d.hours * (300 - rates.get(`j1|${d.person}`)!), 0)
  for (const r of c.rows) assert.equal(r.difference[0], r.key[0] === 'j1' ? expected : 0, String(r.key[0]))
  assert.ok(c.notes.some((n) => /produced again: AllocationDay/.test(n)))
})

test('AU and 2 are the same question', () => {
  const q = (v: string): Question => ({ measures: ['AllocationDay.hours'], where: [{ to: 'Subsidiary', via: ['project', 'subsidiary'], in: [v] }] })
  assert.equal(canonical(s, q('AU')), canonical(s, q('2')))
})

test('as of 15 September, the rate dated 15 October is not known yet: the latest known rate converts', () => {
  const q: Question = { measures: ['AllocationDay.revenue'], span: { from: '2026-09-01', to: '2026-11-01' }, currency: 'AUD' }
  const nzd = days.filter((d) => project(d.project).currency === 'NZD').reduce((a, d) => a + d.revenue, 0)
  const aud = days.filter((d) => project(d.project).currency === 'AUD').reduce((a, d) => a + d.revenue, 0)
  assert.deepEqual(round(answer({ ...q, asOf: '2026-09-15' })), round([[aud + nzd * 0.91]]))
  assert.deepEqual(round(answer({ ...q, asOf: '2026-10-20' })), round([[aud + nzd * 0.93]]))
})
