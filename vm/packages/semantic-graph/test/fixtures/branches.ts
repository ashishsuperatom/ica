// A small made-up business with every case the textbooks warn about: a branch → state → region hierarchy, people who
// change branch, a manager hierarchy, projects with an owner and a sometimes-missing sponsor, sales in two currencies,
// a budget in versions, contracts (one row per project, the fan trap), headcount (a stock).

import type { Schema } from '../../src/schema.js'
import type { Instance, Row } from '../../src/instance.js'

export const schema: Schema = {
  name: 'branches',
  objects: {
    Region: { kind: 'entity' },
    State: { kind: 'entity', arrows: { region: { to: 'Region', kind: 'rollup' } } },
    Branch: { kind: 'entity', arrows: { state: { to: 'State', kind: 'rollup' } }, names: { Sydney: 'b1' }, members: { b1: 'Sydney', b2: 'Melbourne', b3: 'Perth' } },
    Person: { kind: 'entity', arrows: { branch: { to: 'Branch', kind: 'as-of' }, manager: { to: 'Person', partial: true } } },
    Project: { kind: 'entity', arrows: { branch: 'Branch', state: 'State', owner: 'Person', sponsor: { to: 'Person', partial: true } } },
    Currency: { kind: 'entity', members: { AUD: 'Australian dollar', NZD: 'New Zealand dollar' } },
    BudgetVersion: { kind: 'entity', members: { base: 'Base', forecast: 'Forecast' } },
    Day: { kind: 'calendar', level: 'day', arrows: { month: 'Month' } },
    Month: { kind: 'calendar', level: 'month', arrows: { quarter: 'Quarter' } },
    Quarter: { kind: 'calendar', level: 'quarter', arrows: { year: 'Year' } },
    Year: { kind: 'calendar', level: 'year' },
    Sale: {
      kind: 'fact', arrows: { person: 'Person', project: 'Project', day: 'Day' },
      attributes: { commitment: { members: ['Hard', 'Soft'] }, currency: {} },
      measures: {
        hours: { unit: 'h', kind: 'flow', aggregate: 'sum' },
        amount: { unit: 'money', kind: 'flow', aggregate: 'sum', currency: { attribute: 'currency' } },
        rate: { unit: 'money/h', kind: 'value-per-unit', aggregate: 'weighted average', weight: 'hours', currency: { attribute: 'currency' } },
        people: { unit: 'people', kind: 'flow', aggregate: 'count distinct', of: 'person' },
      },
    },
    Budget: {
      kind: 'fact', arrows: { branch: 'Branch', month: 'Month', version: { to: 'BudgetVersion', kind: 'version' }, currency: 'Currency' },
      measures: { budget: { unit: 'money', kind: 'flow', aggregate: 'sum', currency: ['currency'], versions: 'version' } },
    },
    Contract: {
      kind: 'fact', arrows: { project: 'Project', signed: 'Day' }, attributes: { currency: {} },
      measures: { value: { unit: 'money', kind: 'flow', aggregate: 'sum', currency: { attribute: 'currency' } } },
    },
    Headcount: {
      kind: 'fact', arrows: { branch: 'Branch', month: 'Month' },
      measures: {
        people: { unit: 'people', kind: 'stock', aggregate: 'sum', overTime: 'last' },
        desks: { unit: 'desks', kind: 'stock', aggregate: 'sum' },
      },
    },
    Rate: {
      kind: 'fact', arrows: { from: 'Currency', to: 'Currency', day: 'Day' },
      measures: { rate: { unit: 'ratio', kind: 'value-per-unit', aggregate: 'max' } },
    },
  },
  equations: [{ on: 'Project', paths: [['branch', 'state'], ['state']] }],
  conversion: { fact: 'Rate', from: 'from', to: 'to', day: 'day', rate: 'rate', at: 'row' },
}

const sale = (day: string, person: string, project: string, commitment: string, hours: number, amount: number, currency: string, rate: number): Row =>
  ({ arrows: { person, project, day }, attributes: { commitment, currency }, measures: { hours, amount, rate } })

export const instance: Instance = {
  elements: {
    Region: { East: {}, West: {} },
    State: { NSW: { arrows: { region: 'East' } }, VIC: { arrows: { region: 'East' } }, WA: { arrows: { region: 'West' } } },
    Branch: { b1: { label: 'Sydney', arrows: { state: 'NSW' } }, b2: { label: 'Melbourne', arrows: { state: 'VIC' } }, b3: { label: 'Perth', arrows: { state: 'WA' } } },
    Person: {
      p1: { arrows: { manager: null }, history: { branch: [{ from: '2026-01-01', to: '2026-09-15', value: 'b1' }, { from: '2026-09-15', value: 'b2' }] } },
      p2: { arrows: { manager: 'p1' }, history: { branch: [{ from: '2026-01-01', value: 'b1' }] } },
      p3: { arrows: { manager: 'p2' }, history: { branch: [{ from: '2026-01-01', value: 'b2' }] } },
    },
    Project: {
      j1: { arrows: { branch: 'b1', state: 'NSW', owner: 'p1', sponsor: 'p3' } },
      j2: { arrows: { branch: 'b3', state: 'WA', owner: 'p2', sponsor: null } },
    },
    Currency: { AUD: {}, NZD: {} },
    BudgetVersion: { base: {}, forecast: {} },
  },
  rows: {
    Sale: [
      sale('2026-09-10', 'p1', 'j1', 'Hard', 10, 1000, 'AUD', 100),
      sale('2026-09-20', 'p1', 'j1', 'Hard', 5, 500, 'AUD', 100),
      sale('2026-09-12', 'p2', 'j2', 'Soft', 8, 1000, 'NZD', 125),
      sale('2026-10-05', 'p3', 'j1', 'Hard', 4, 600, 'AUD', 150),
      sale('2026-10-06', 'p2', 'j1', 'Hard', 2, 200, 'AUD', 100),
    ],
    Budget: [
      { arrows: { branch: 'b1', month: '2026-09', version: 'base', currency: 'AUD' }, measures: { budget: 2000 } },
      { arrows: { branch: 'b1', month: '2026-10', version: 'base', currency: 'AUD' }, measures: { budget: 1000 } },
      { arrows: { branch: 'b1', month: '2026-09', version: 'forecast', currency: 'AUD' }, measures: { budget: 9999 } },
    ],
    Contract: [
      { arrows: { project: 'j1', signed: '2026-08-03' }, attributes: { currency: 'AUD' }, measures: { value: 10000 } },
      { arrows: { project: 'j2', signed: '2026-08-10' }, attributes: { currency: 'AUD' }, measures: { value: 5000 } },
    ],
    Headcount: [
      { arrows: { branch: 'b1', month: '2026-07' }, measures: { people: 5, desks: 5 } },
      { arrows: { branch: 'b1', month: '2026-08' }, measures: { people: 6, desks: 6 } },
      { arrows: { branch: 'b1', month: '2026-09' }, measures: { people: 7, desks: 7 } },
      { arrows: { branch: 'b2', month: '2026-07' }, measures: { people: 3, desks: 3 } },
      { arrows: { branch: 'b2', month: '2026-08' }, measures: { people: 3, desks: 3 } },
    ],
    Rate: [
      { arrows: { from: 'NZD', to: 'AUD', day: '2026-09-01' }, measures: { rate: 0.9 } },
      { arrows: { from: 'NZD', to: 'AUD', day: '2026-10-01' }, measures: { rate: 0.92 } },
    ],
  },
}
