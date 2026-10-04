import { unsettledSql } from './sql.js'

type Ctx = { set(p: Record<string, unknown>): void; slice: any; params: any; services: { query(source: string, sql: string, params?: Record<string, unknown>): Promise<any[]> } }

export async function run(state: any, ctx: Ctx) {
  const { sql, params } = unsettledSql(state.trips.branch)
  const rows = await ctx.services.query('TRIPS', sql, params)
  ctx.set({ count: rows.length })
  const total = rows.reduce((a, r) => a + Number(r.balance), 0)
  return { answer: { markdown: `${rows.length} trips${state.trips.branch ? ` at ${state.trips.branch}` : ''} are completed but not settled; ${total} to settle.\n:::table data/unsettled-trips.json`, files: ['data/unsettled-trips.json'] } }
}

export function nextPage(state: any, ctx: Ctx) {
  ctx.set({ page: state.trips.page + 1 })
}
