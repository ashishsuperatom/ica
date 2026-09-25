// A small roster: people in teams, shifts by week with a target and the hours worked. Neutral names; every case the
// three measure laws need — a threshold, a row that is short, a row with nothing recorded, and a week with no shift.

import type { Schema } from '../../src/schema.js'
import type { Instance, Row } from '../../src/instance.js'

export const schema: Schema = {
  name: 'roster',
  objects: {
    Team: { kind: 'entity', members: { t1: 'Alpha', t2: 'Beta' } },
    Person: { kind: 'entity', arrows: { team: 'Team' }, attributes: { grade: { type: 'text', members: ['senior', 'junior'] } } },
    Week: { kind: 'calendar', level: 'week' },
    Shift: {
      kind: 'fact', arrows: { person: 'Person', week: 'Week' },
      attributes: { site: { type: 'text', members: ['north', 'south'] } },
      measures: {
        target: { unit: 'h', kind: 'flow', aggregate: 'sum' },
        worked: { unit: 'h', kind: 'flow', aggregate: 'sum' },
        people: { unit: 'people', kind: 'flow', aggregate: 'count distinct', of: 'person' },
        rate: { unit: 'ratio', kind: 'value-per-unit', aggregate: 'weighted average', weight: 'worked' },
        /** one per row, counted: a column of ones is what a count of rows counts. */
        shifts: { unit: 'shifts', kind: 'flow', aggregate: 'count' },
      },
    },
  },
  conditions: { 'senior person': { on: 'Person', where: [{ attribute: 'grade', in: ['senior'] }] } },
}

// Monday-keyed weeks; W4 (2026-01-26) has no shift for anyone.
export const W = ['2026-01-05', '2026-01-12', '2026-01-19', '2026-02-02', '2026-02-09', '2026-02-16']
const shift = (person: string, week: string, site: string, target: number, worked: number | null, rate: number): Row =>
  ({ arrows: { person, week }, attributes: { site }, measures: { target, worked, rate, shifts: 1, people: 1 } })

export const instance: Instance = {
  elements: {
    Team: { t1: { label: 'Alpha' }, t2: { label: 'Beta' } },
    Person: { p1: { label: 'Ana', arrows: { team: 't1' }, attributes: { grade: 'senior' } }, p2: { label: 'Ben', arrows: { team: 't2' }, attributes: { grade: 'junior' } } },
  },
  rows: {
    Shift: [
      shift('p1', W[0], 'north', 8, 6, 1.0), shift('p1', W[1], 'north', 8, 9, 1.5), shift('p1', W[2], 'south', 8, 9, 1.0),
      shift('p1', W[3], 'south', 8, 12, 2.0), shift('p1', W[4], 'north', 8, 9, 1.0), shift('p1', W[5], 'north', 8, 9, 1.0),
      shift('p2', W[0], 'north', 8, 8, 1.0), shift('p2', W[1], 'south', 8, 8, 1.0), shift('p2', W[2], 'south', 8, null, 1.0),
      shift('p2', W[3], 'north', 8, 8, 1.0), shift('p2', W[4], 'north', 8, 7, 1.0), shift('p2', W[5], 'south', 8, 8, 1.0),
    ],
  },
}
