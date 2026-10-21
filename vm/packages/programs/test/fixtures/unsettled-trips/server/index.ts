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
  return state.trips.count > state.trips.page * 100 ? { label: `Page ${state.trips.page + 1}`, call: { fn: 'nextPage' }, to: 'current' } : null
}
