// Simulated data for a made-up consultancy: made-up people, projects, allocations, a rate
// card, budgets and exchange rates, produced by programs the way real ones would read a source. Deterministic.
// `raw` is what the programs read; tests compute expected answers from `raw` directly, without the graph.

import { readFileSync } from 'node:fs'
import type { Model } from '../../src/model.js'
import type { Element, Row } from '../../src/instance.js'
import type { Schema } from '../../src/schema.js'

export const schema: Schema = JSON.parse(readFileSync(new URL('./consultancy.json', import.meta.url), 'utf8'))

let seed = 7
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]

const practices = ['15', '42', '37', '5']
export const people = Array.from({ length: 12 }, (_, i) => ({
  id: `e${i + 1}`, company: i < 8 ? '2' : '3', practice: practices[i % 4], manager: i < 2 ? null : `e${(i % 2) + 1}`,
  // e3 moves from Data to Security on 1 October.
  moves: i === 2 ? { on: '2026-10-01', to: '37' } : undefined,
}))
export const projects = Array.from({ length: 8 }, (_, i) => ({
  id: `j${i + 1}`, company: i < 6 ? '2' : '3', currency: i < 6 ? 'AUD' : 'NZD', practice: practices[(i + 1) % 4], customer: `c${(i % 3) + 1}`,
  type: ['1', '14', '3'][i % 3], manager: `e${(i % 4) + 1}`, sponsor: i % 2 ? `e${i + 3}` : null,
}))
/** A rate card: hourly rate by project and person; some pairs have none (unpriced). */
export const rates = new Map<string, number>()
for (const p of projects) for (const e of people) if (p.type !== '3' && rand() > 0.2) rates.set(`${p.id}|${e.id}`, 150 + Math.round(rand() * 10) * 10)

const workingDays = (from: string, to: string) => {
  const out: string[] = []
  for (const d = new Date(from + 'T00:00:00Z'); d.toISOString().slice(0, 10) < to; d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10))
  return out
}
const pairs = new Set<string>()
export const allocations = Array.from({ length: 40 }, () => {
  const person = pick(people), project = pick(projects)
  // One allocation per person and project, so a day's row is one allocation's.
  if (pairs.has(person.id + project.id)) return undefined
  pairs.add(person.id + project.id)
  const days = workingDays('2026-09-01', '2026-11-01')
  const start = Math.floor(rand() * 30)
  return { person: person.id, project: project.id, commitment: rand() > 0.35 ? 'Hard' : 'Soft', days: days.slice(start, start + 5 + Math.floor(rand() * 15)), hoursPerDay: pick([4, 6, 8]) }
}).filter((a) => a !== undefined)
export const budgets = [
  ...['2026-09', '2026-10'].flatMap((month) => practices.flatMap((practice) => ['2', '3'].flatMap((company) => [
    { company, practice, account: '5005', category: '5', month, amount: 10000 + Math.round(rand() * 50) * 1000 },
    { company, practice, account: '5102', category: '5', month, amount: Math.round(rand() * 10) * 1000 },
    { company, practice, account: '5005', category: '7', month, amount: 99999 },
  ]))),
]
export const exchange = [{ from: 'NZD', to: 'AUD', day: '2026-09-01', rate: 0.91 }, { from: 'NZD', to: 'AUD', day: '2026-10-15', rate: 0.93 }]

const practiceHistory = (p: (typeof people)[number]) => p.moves
  ? [{ from: '2020-01-01', to: p.moves.on, value: p.practice }, { from: p.moves.on, value: p.moves.to }]
  : [{ from: '2020-01-01', value: p.practice }]

export const model: Model = {
  schema,
  programs: [
    { produces: 'Currency', reads: [], run: () => ({ AUD: {}, NZD: {} }) },
    { produces: 'Company', reads: [], run: () => ({ '2': { label: 'Acme Consulting Pty Ltd', arrows: { currency: 'AUD' } }, '3': { label: 'Acme Consulting Ltd', arrows: { currency: 'NZD' } } }) },
    { produces: 'Practice', reads: [], run: () => Object.fromEntries(practices.map((p) => [p, {}])) },
    { produces: 'Customer', reads: [], run: () => ({ c1: {}, c2: {}, c3: {} }) },
    { produces: 'ProjectType', reads: [], run: () => ({ '1': {}, '14': {}, '3': {} }) },
    { produces: 'Account', reads: [], run: () => ({ '5005': {}, '5102': {}, '5010': {} }) },
    { produces: 'BudgetCategory', reads: [], run: () => ({ '5': {}, '7': {} }) },
    {
      produces: 'Person', reads: ['Company', 'Practice'],
      run: () => Object.fromEntries(people.map((p): [string, Element] => [p.id, { arrows: { company: p.company, manager: p.manager }, history: { practice: practiceHistory(p) } }])),
    },
    {
      produces: 'Project', reads: ['Person', 'Customer', 'Company', 'Practice', 'Currency', 'ProjectType'],
      run: () => Object.fromEntries(projects.map((p): [string, Element] => [p.id, { arrows: { company: p.company, practice: p.practice, customer: p.customer, currency: p.currency, type: p.type, manager: p.manager, 'sponsor': p.sponsor } }])),
    },
    {
      produces: 'RateCard', reads: [],
      run: () => [...rates].map(([k, rate]) => { const [project, person] = k.split('|'); return { arrows: { project, person }, measures: { rate } } }),
    },
    {
      // Allocation spread over working days; revenue is hours × the rate card's rate, or unpriced when there is none.
      produces: 'BookingDay', reads: ['Person', 'Project', 'RateCard'],
      run: (I) => {
        const card = new Map((I.rows.RateCard ?? []).map((r) => [`${r.arrows.project}|${r.arrows.person}`, r.measures.rate]))
        const rows = new Map<string, Row>()
        for (const a of allocations) for (const day of a.days) {
          const k = `${a.person}|${a.project}|${day}`
          const rate = card.get(`${a.project}|${a.person}`)
          const priced = rate !== undefined && rate !== null
          rows.set(k, { arrows: { person: a.person, project: a.project, day }, attributes: { commitment: a.commitment }, measures: { hours: a.hoursPerDay, revenue: priced ? a.hoursPerDay * rate : 0, 'unpriced hours': priced ? 0 : a.hoursPerDay } })
        }
        return [...rows.values()]
      },
    },
    { produces: 'TimesheetLine', reads: ['Person', 'Project'], run: () => [] },
    {
      produces: 'PlanLine', reads: ['Company', 'Practice', 'Account', 'BudgetCategory'],
      run: () => budgets.map((b) => ({ arrows: { company: b.company, practice: b.practice, account: b.account, category: b.category, month: b.month }, measures: { budget: b.amount } })),
    },
    { produces: 'ExchangeRate', reads: ['Currency'], run: () => exchange.map((x) => ({ arrows: { from: x.from, to: x.to, day: x.day }, measures: { rate: x.rate } })) },
  ],
}
