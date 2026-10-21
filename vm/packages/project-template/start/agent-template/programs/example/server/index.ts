// The program's Node side: its functions. Each gets the whole STATE (frozen) and a context whose set() changes only this
// program's slice; data comes only through ctx.services.query (the reader's data access is applied for you).
//
// STATE is inputs and derived: the person sets the inputs (here `filter`), the program derives the rest. The data is
// fetched once per input (`data.basis` says for which) and kept in the slice, so a run with nothing new asks nothing.
// The answer is markdown: a first line `**Title** — _what it says_`, then a marker line per block (:::kpis, :::table…).
// A table's rowMove makes its rows clickable: a click is a step taken — it opens a new block below, answered by row().
// At most 100 rows are shown; the total and the count come from the source, never from adding up the rows shown.
// What a program is given (query, append, who…): the platform's own types (`platform/program` in a cloned project).
import type { OptionContext, ProgramContext } from '@superatom/program'
import { exampleQuery } from './query.js'

type Row = { key: string; value: number }
type Data = { basis: string | null; rows: Row[]; total: number; count: number }
type Slice = { filter: string | null; data: Data | null }
type Ctx = ProgramContext<Slice>

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

// ── Options: the next moves this program offers at a step ───────────────────────────────────────────────────────────
// Each option is a function, listed in the manifest's `package.options`. It is given the step — the whole STATE (frozen),
// ctx.context (what the session was started with), ctx.history (its answers down to here) — and services that only
// read. It works out whether its move makes sense HERE, from what is there, and returns it — a label said from the data,
// and one of this program's functions to call or ops on its own slice — or null: then nothing is offered. It never does
// the work itself and changes nothing; it is quick (a time limit applies). A fixed list of moves is not an option.

/** With a filter in force: the way back to every key, saying how much more there is. */
export async function everyKey(state: { example: Slice }, ctx: OptionContext) {
  const s = state.example
  if (!s.filter || !s.data) return null
  const { sql, params } = exampleQuery(null)
  const [all] = await ctx.services.query('SOURCE', sql, params)
  const more = Number(all?.keys ?? 0) - 1
  return more > 0 ? { label: `Every key — ${more} more besides ${s.filter}`, ops: [{ op: 'set' as const, path: 'example.filter', value: null }], to: 'current' as const } : null
}

/** Without a filter: the key that carries most of the total, when one does (a third or more of it). */
export function largestKey(state: { example: Slice }) {
  const d = state.example.data
  const top = d?.rows[0]
  if (state.example.filter || !d || !top || !d.total || top.value / d.total < 1 / 3) return null
  return { label: `${top.key}: ${Math.round((100 * top.value) / d.total)}% of the total`, call: { fn: 'row', params: { row: { key: top.key } } }, to: 'new' as const }
}

/** A row clicked in the table: the new block below it, narrowed to the row's key (a call does not re-run its own program). */
export async function row(state: { example: Slice }, ctx: Ctx) {
  const key = String(((ctx.params.row ?? {}) as Record<string, unknown>).key ?? '')
  if (!key) return run(state, ctx)
  ctx.set({ filter: key })
  return run({ ...state, example: { ...state.example, filter: key } }, ctx)
}
