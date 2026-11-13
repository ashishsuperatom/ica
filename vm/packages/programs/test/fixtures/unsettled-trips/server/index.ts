import { defineProgram, fn, field } from '@superatom/program'
import { unsettledSql } from './sql.js'

type Ctx = { set(p: Record<string, unknown>): void; slice: any; params: any; services: { query(source: string, sql: string, params?: Record<string, unknown>): Promise<any[]> } }

export async function run(state: any, ctx: Ctx) {
  const { sql, params } = unsettledSql(state.trips.branch)
  const rows = await ctx.services.query('TRIPS', sql, params)
  ctx.set({ count: rows.length })
  const total = rows.reduce((a, r) => a + Number(r.balance), 0)
  const table = { title: 'Unsettled trips', columns: [{ key: 'trip_no', label: 'Trip' }, { key: 'balance', label: 'Balance' }], rows }
  return { answer: { markdown: `${rows.length} trips${state.trips.branch ? ` at ${state.trips.branch}` : ''} are completed but not settled; ${total} to settle.\n:::table unsettled.json`, blocks: { 'unsettled.json': table } } }
}

export function nextPage(state: any, ctx: Ctx) {
  ctx.set({ page: state.trips.page + 1 })
}

// Options: each computes the move it offers at a step, from what is there — or none.
export function everyBranch(state: any) {
  return state.trips.branch ? { label: `Every branch, not only ${state.trips.branch}`, ops: [{ op: 'set', path: 'trips.branch', value: null }], to: 'current' } : null
}
export function morePages(state: any) {
  return state.trips.count > state.trips.page * 100 ? { label: `Page ${state.trips.page + 1}`, call: 'nextPage', to: 'current' } : null
}

// What it offers (docs/programs-design.md "Where a program says what it is").
export const program = defineProgram({
  state: { branch: field.nullable('string'), completed: field.boolean(true), settled: field.nullable('boolean'), page: field.number(1), count: field.number(0) },
  functions: {
    run: fn(run, { produces: 'view', doc: 'The unsettled trips, for the branch chosen' }),
    nextPage: fn(nextPage, { produces: 'data', doc: 'The next page of them' }),
  },
  options: [everyBranch, morePages],
})
