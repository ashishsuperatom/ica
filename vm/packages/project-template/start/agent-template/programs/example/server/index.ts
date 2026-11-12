// The program's Node side: its functions. Each gets the whole STATE (frozen) and a context whose set() changes only this
// program's slice; data comes only through ctx.services.query (the reader's data access is applied for you).
//
// STATE is inputs and derived: the person sets the inputs (here `group`, a filter, and `key`, a drill), the program
// derives the rest. The data is fetched once per scope (`data.basis` says for which) and kept in the slice, so a run with
// nothing new asks nothing. At most 100 rows are shown; the total and the count come from the source.
//
// THE STEP STANDARD (docs/program-contract.md "The view"): the answer is markdown in the order a step reads —
//   **Title** — _one line_            the block frame's title and the line under it
//   :::filters <slice>.filters        the filter row: declared in the manifest, its choices computed by groupOptions()
//   :::kpis …                         the headline figures
//   ## A heading, then 2–3 sentences  words first, said from the data
//   :::bars …                         a chart, drawn plainly: its table behind a quiet button
//   :::table …                        a table, shown open: its first 10 rows, "Show more"; its expand button opens it
//                                     full screen for analysis (search, a filter per column, group-by, sort, every row)
// The framework draws all of it; nothing here lays a screen out. What a program is given (query, append, who…): the
// platform's own types (`platform/program` in a cloned project).
import type { OptionContext, ProgramContext } from '@superatom/program'
import { keysQuery, groupChoicesQuery, type Scope } from './query.js'

type Row = { key: string; value: number }
type Data = { basis: string; rows: Row[]; total: number; count: number }
type Slice = Scope & { data: Data | null }
type Ctx = ProgramContext<Slice>
type Reading = Pick<OptionContext, 'services'>

const basisOf = (s: Scope) => JSON.stringify([s.group, s.key])
const scopeOf = (s: Slice): Scope => ({ group: s.group, key: s.key })

async function fetchData(s: Scope, ctx: Reading): Promise<Data> {
  const { sql, params } = keysQuery(s)
  const got = await ctx.services.query('SOURCE', sql, params)
  return { basis: basisOf(s), rows: got.map((r) => ({ key: String(r.key), value: Number(r.value) })), total: Number(got[0]?.total ?? 0), count: Number(got[0]?.keys ?? 0) }
}

/** The step's words: what stands out, said from the figures — two or three plain sentences, never a fixed phrase. */
function reading(d: Data): string[] {
  const top = d.rows[0]
  if (!top || !d.total) return ['Nothing is recorded in this scope.']
  const share = Math.round((100 * top.value) / d.total)
  const said = [`${top.key} carries ${share}% of the total, the largest of ${d.count} key${d.count === 1 ? '' : 's'}.`]
  const rest = d.rows.slice(1, 3).map((r) => r.key)
  if (rest.length) said.push(`${rest.join(' and ')} come${rest.length === 1 ? 's' : ''} next; the rest share what is left.`)
  return said
}

export async function run(state: { example: Slice }, ctx: Ctx) {
  const s = state.example
  let d = s.data && s.data.basis === basisOf(scopeOf(s)) ? s.data : null
  if (!d) { d = await fetchData(scopeOf(s), ctx); ctx.set({ data: d }) }
  const where = [s.group, s.key].filter(Boolean).join(' · ')
  const drill = { dim: 'key', key: 'key', label: 'label' }
  const blocks = {
    'example-kpis': { type: 'kpis', items: [
      { label: 'Total', value: d.total, unit: 'count', hint: where ? `for ${where}` : 'every key' },
      { label: 'Keys', value: d.count, unit: 'count', hint: d.count > d.rows.length ? `the largest ${d.rows.length} shown` : 'all shown' },
    ] },
    'example-bars': { type: 'bars', title: 'The largest keys', says: 'Open one to narrow to it', axis: 'key', unit: 'count',
      series: [{ key: 'value', label: 'Amount' }], rows: d.rows.slice(0, 12).map((r) => ({ label: r.key, key: r.key, values: { value: r.value } })), rowMove: drill },
    'example-table': { type: 'table', title: 'Every key', says: 'Open one to narrow to it', rowMove: { dim: 'key', key: 'key', label: 'key' },
      columns: [{ key: 'key', label: 'Key' }, { key: 'value', label: 'Amount', unit: 'count' }], rows: d.rows },
  }
  const markdown = [
    `**Example** — _${d.count} keys${where ? ` in ${where}` : ''}, ${d.total} in total_`,
    ':::filters example.filters',
    ':::kpis example-kpis',
    '## What stands out',
    reading(d).join(' '),
    ':::bars example-bars',
    ':::table example-table',
  ].join('\n\n')
  return { answer: { markdown, blocks } }
}

// ── The filter's choices ─────────────────────────────────────────────────────────────────────────────────────────────
// Named in the manifest (`package.filters[].options`): the platform calls it after every answer, with the STATE as the
// run left it and services that only read, and draws the row. It returns the choices that hold something in the current
// scope — each with how many keys it holds and their amount — so no choice can give an empty view. Never a list typed
// here or in the manifest: the build refuses one.

/** The groups to choose from, in the scope the drill leaves. */
export async function groupOptions(state: { example: Slice }, ctx: Reading) {
  const { sql, params } = groupChoicesQuery(scopeOf(state.example))
  const got = await ctx.services.query('SOURCE', sql, params)
  return got.filter((r) => Number(r.count) > 0).map((r) => ({ value: String(r.value), label: String(r.value), count: Number(r.count), amount: Number(r.amount) }))
}

// ── Options: the next moves this program offers at a step ───────────────────────────────────────────────────────────
// Each option is a function, listed in the manifest's `package.options`. It is given the step — the whole STATE (frozen),
// ctx.context (what the session was started with), ctx.history (its answers down to here) — and services that only
// read. It works out whether its move makes sense HERE, from what is there, and returns it — a label said from the data,
// and one of this program's functions to call or ops on its own slice — or null: then nothing is offered. It never does
// the work itself and changes nothing; it is quick (a time limit applies). A fixed list of moves is not an option.

/** With a key opened: the way back to every key in scope, saying how many more there are. */
export async function everyKey(state: { example: Slice }, ctx: OptionContext) {
  const s = state.example
  if (!s.key || !s.data) return null
  const { sql, params } = keysQuery({ group: s.group, key: null })
  const [all] = await ctx.services.query('SOURCE', sql, params)
  const more = Number(all?.keys ?? 0) - 1
  return more > 0 ? { label: `Every key — ${more} more besides ${s.key}`, ops: [{ op: 'set' as const, path: 'example.key', value: null }], to: 'current' as const } : null
}

/** Without a key opened: the key that carries most of the total, when one does (a third or more of it). */
export function largestKey(state: { example: Slice }) {
  const d = state.example.data
  const top = d?.rows[0]
  if (state.example.key || !d || !top || !d.total || top.value / d.total < 1 / 3) return null
  return { label: `${top.key}: ${Math.round((100 * top.value) / d.total)}% of the total`, call: { fn: 'row', params: { row: { key: top.key } } }, to: 'new' as const }
}

/** A key clicked (a bar or a row): the new block below it, narrowed to that key (a call does not re-run its own program). */
export async function row(state: { example: Slice }, ctx: Ctx) {
  const key = String(((ctx.params.row ?? {}) as Record<string, unknown>).key ?? '')
  if (!key) return run(state, ctx)
  ctx.set({ key })
  return run({ ...state, example: { ...state.example, key } }, ctx)
}
