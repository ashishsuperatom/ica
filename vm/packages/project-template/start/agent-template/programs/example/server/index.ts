// The program's Node side: its functions. Each gets the whole STATE (frozen) and a context whose set() changes only this
// program's slice; data comes only through ctx.services.query (the reader's data access is applied for you).
//
// STATE is inputs and derived: the person sets the inputs (here `filter`), the program derives the rest. The data is
// fetched once per input (`data.basis` says for which) and kept in the slice, so a run with nothing new asks nothing.
// The answer is markdown: a first line `**Title** — _what it says_`, then a marker line per block (:::kpis, :::table…).
// A table's rowMove makes its rows clickable: a click is a step taken — it opens a new block below, answered by row().
// At most 100 rows are shown; the total and the count come from the source, never from adding up the rows shown.
import { exampleQuery } from './query.js'

type Row = { key: string; value: number }
type Data = { basis: string | null; rows: Row[]; total: number; count: number }
type Slice = { filter: string | null; data: Data | null }
type Ctx = { set(patch: Record<string, unknown>): void; params: Record<string, unknown>; services: { query(source: string, sql: string, params?: Record<string, unknown>): Promise<any[]> } }

async function fetchData(filter: string | null, ctx: Ctx): Promise<Data> {
  const { sql, params } = exampleQuery(filter)
  const got = await ctx.services.query('SOURCE', sql, params)
  return { basis: filter, rows: got.map((r) => ({ key: String(r.key), value: Number(r.value) })), total: Number(got[0]?.total ?? 0), count: Number(got[0]?.keys ?? 0) }
}

export async function run(state: { example: Slice }, ctx: Ctx) {
  const s = state.example
  let d = s.data && s.data.basis === s.filter ? s.data : null
  if (!d) { d = await fetchData(s.filter, ctx); ctx.set({ data: d }) }
  const blocks = {
    'example-kpis': { type: 'kpis', items: [
      { label: 'Total', value: d.total, unit: 'count', hint: s.filter ? `for ${s.filter}` : 'every key' },
      { label: 'Keys', value: d.count, unit: 'count', hint: d.count > d.rows.length ? `the largest ${d.rows.length} shown` : 'all shown' },
    ] },
    'example-table': { type: 'table', title: 'Every key — open one to narrow to it', rowMove: { dim: 'key', key: 'key', label: 'key' },
      columns: [{ key: 'key', label: 'Key' }, { key: 'value', label: 'Value', unit: 'count' }], rows: d.rows },
  }
  return { answer: { markdown: [`**Example** — _${d.count} keys${s.filter ? ` for ${s.filter}` : ''}, ${d.total} in total_`, ':::kpis example-kpis', ':::table example-table'].join('\n'), blocks } }
}

/** A row clicked in the table: the new block below it, narrowed to the row's key (a call does not re-run its own program). */
export async function row(state: { example: Slice }, ctx: Ctx) {
  const key = String(((ctx.params.row ?? {}) as Record<string, unknown>).key ?? '')
  if (!key) return run(state, ctx)
  ctx.set({ filter: key })
  return run({ ...state, example: { ...state.example, filter: key } }, ctx)
}
