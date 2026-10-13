// Reads the facts (facts.mjs) the views stand on: each fact is a program of a domain (the composition graph's), run
// through the program context (ctx.run — the platform's one way to run a domain's program: placed from the graph as it
// is now, as the reader with their data access, remembered five minutes) and read as JSON rows, with its NOTE lines (a
// read that reached its row limit). Every run is recorded for the answer: which program, which arguments, how many
// rows, how long, what it noted.

import { FACTS } from './facts.mjs'

/** What a view asks of a paged program: totals by some columns, or one page in an order; and conditions. */
function pagedArgs(name, { totals, page, size, order, where = [], distinct = [], max = [], min = [], ratio = [], having = [], pivot }) {
  if (!totals && !page) throw new Error(`${name} answers in totals and pages: ask it for those, never every row`)
  const list = (flag, xs) => (xs.length ? [flag, xs.join(',')] : [])
  return [
    ...(totals ? ['--totals', totals.join(',')] : []), ...list('--distinct', distinct), ...list('--max', max), ...list('--min', min),
    ...ratio.flatMap((r) => ['--ratio', typeof r === 'string' ? r : `${r.name}=${r.num}/${r.den}`]),
    ...(pivot ? ['--pivot', `${pivot.column}=${pivot.values.join(',')}`] : []),
    ...having.flatMap((h) => ['--having', h]),
    ...(page ? ['--page', page, ...(size ? ['--size', size] : []), ...(order ? ['--order', order] : [])] : []), ...where.flatMap((w) => ['--where', w]),
  ]
}

/** The facts for one answer: rows by name, the settings, and the record of every run. `ctx` is views' context (index.ts). */
export function factsFor(ctx) {
  const calls = []
  const domains = () => [...new Set(Object.values(FACTS).map((f) => f.domain))]
  return {
    calls,
    /** What one fact's program prints: its rows, or for a program the source runs, totals or a page. */
    async read(name, params = {}) {
      const f = FACTS[name]
      if (!f) throw new Error(`there is no fact "${name}"`)
      const args = [...f.args(params), ...(f.paged && !params.latest ? pagedArgs(name, params) : [])].map(String)
      const started = Date.now()
      const got = await ctx.run(f.domain, f.program, args)
      calls.push({ fact: name, program: f.program, args, rows: Array.isArray(got.rows) ? got.rows.length : null, ms: Date.now() - started, ...(got.notes.length ? { notes: got.notes } : {}) })
      return { data: got.rows, notes: got.notes }
    },
    /** Every setting the domains' compositions give, by name. */
    async settings() {
      const out = {}
      for (const d of domains()) Object.assign(out, await ctx.settings(d))
      return out
    },
    /** A setting of the organisation, as the domain's composition gives it. */
    async setting(name, domain) {
      for (const d of domain ? [domain] : domains()) {
        const all = await ctx.settings(d)
        if (name in all) return all[name]
      }
      throw new Error(`no domain gives the setting "${name}"`)
    },
  }
}
