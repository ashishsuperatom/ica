// A question becomes an answer: the view it names is given the domains' programs in this application's clothes — the
// question's filters already as each program's own conditions, the window already a span, settings by name — and
// what it returns is wrapped with what a reader needs: the words, what was assumed, what it read, and the moves on.

import { DIMENSION, programWhere, lookups } from './dimensions.mjs'
import { factsFor } from './read.mjs'
import { WINDOWS } from './windows.mjs'
import { inWords, NotAllowed } from './state.mjs'

export async function answer(model, q, ctx) {
  const cap = model.capabilities.get(q.focus)
  if (!cap) throw new NotAllowed(`There is nothing to look at called "${q.focus}"`)
  const today = ctx.today
  const facts = factsFor(ctx)
  const used = { settings: {}, assumptions: { ...(cap.assume ?? {}), ...(q.assume ?? {}) }, window: q.window ? WINDOWS[q.window.kind].words(q.window, model) : null, span: null }
  const notes = []
  if (q.window && WINDOWS[q.window.kind].note) notes.push(WINDOWS[q.window.kind].note)
  const span = q.window ? WINDOWS[q.window.kind].span(q.window, today, model) : undefined
  used.span = span ?? null
  let looked = null
  const look = () => (looked ??= lookups((f, p) => facts.read(f, p)))
  const keep = (got) => { for (const n of got.notes) if (!notes.includes(n)) notes.push(n); return got.data }
  const c = {
    today, span, q,
    /** The question's filters as a program's own conditions, for the filters that fact carries. A filter it does not
     *  carry is refused with the sentence — unless the view names it in `except` and says what it does instead. */
    async where(fact, { except = [] } = {}) {
      const o = await look()
      return q.where.filter((f) => !except.includes(f.dim)).map((f) => { try { return programWhere(f, fact, o) } catch (e) { throw new NotAllowed(e.message) } })
    },
    /** Counts and sums by some of the fact's columns, computed by the source. */
    async totals(fact, by, where = [], params = {}) { return keep(await facts.read(fact, { today, span, ...params, totals: by, where })).rows },
    /** One page of a fact's rows, the page and order the question keeps for table `id` (else the first, in `order`).
     *  `at` asks for a given page — for a calculation that walks the pages in order, not for a table. */
    async page(fact, id, { order, where = [], size, at, ...params } = {}) {
      const kept = at ? undefined : q.pages?.[id]
      return { ...keep(await facts.read(fact, { today, span, ...params, page: at ?? kept?.page ?? 1, order: kept?.order ?? order, size, where })), id, order: kept?.order ?? order }
    },
    /** Groups of a fact's rows, one page of them, the page and order the question keeps for table `id`. */
    async groups(fact, id, by, { where = [], order, size, distinct = [], max = [], at, ...params } = {}) {
      const kept = at ? undefined : q.pages?.[id]
      return { ...keep(await facts.read(fact, { today, span, ...params, totals: by, distinct, max, page: at ?? kept?.page ?? 1, order: kept?.order ?? order, size, where })), id, order: kept?.order ?? order }
    },
    /** A setting of the organisation, from the composition graph, recorded on the answer as used. */
    async settingOf(name) { const v = await facts.setting(name); used.settings[name] = v; return v },
    /** A fact read as it is (a search, a latest day). */
    readFact: (fact, params) => facts.read(fact, params),
    /** The window's periods (months, days), for filling a chart. */
    periods: q.window && WINDOWS[q.window.kind].periods ? WINDOWS[q.window.kind].periods(q.window, today, model) : [],
    /** The financial calendars (years and months, with their bounds). */
    calendars: model.calendars ?? {},
    assume: used.assumptions,
    /** One of the question's filters by dimension, or undefined. */
    filter(dim) { return q.where.find((f) => f.dim === dim) },
    label(dim) { return DIMENSION.get(dim)?.label ?? dim },
    note(text) { if (!notes.includes(text)) notes.push(text) },
  }
  const started = Date.now()
  const out = await cap.answer(q, c)
  const asked = facts.calls.map((x) => ({ question: { program: x.program, args: x.args }, rows: x.rows, ms: x.ms, ...(x.remembered ? { remembered: true } : {}), ...(x.notes ? { notes: x.notes } : {}) }))
  const next = (cap.next?.(q, out, c) ?? []).map((n) => ({ ...n, ops: n.ops ?? [] }))
  return {
    question: q, focus: q.focus, label: cap.label, words: inWords(model, q), title: out.title ?? cap.label,
    blocks: out.blocks ?? [], next, used: { ...used, ...(out.latest !== undefined ? { latest: out.latest } : {}) }, notes: [...notes, ...(out.notes ?? [])], asked, ms: Date.now() - started, today,
  }
}
