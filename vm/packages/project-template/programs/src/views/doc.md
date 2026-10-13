# views — the project's own views (a library)

Questions the project's data answers the same way every time, with no model: a figure, its breakdown, its trend — each a
**view** named by its focus (`revenue`, `payment-types`). Any program uses them (`"uses": ["views"]`, `import { ask } from
'@lib/views'`); the `app-views` program shows them in a session, with their filters, window and next moves.

## Asking

`ask(payload, ctx)` — `ctx` is the program function's own context (it runs as the person asking, with their data access).

| payload | reply |
|---|---|
| `{ t: 'app:start', focus, where? }` | `app:answer` — the view as it opens (its default window) |
| `{ t: 'app:ask', question }` | `app:answer` — exactly that question: `{ focus, where: [{ dim, op, value }], by?, window? }` |
| `{ t: 'app:move', question, ops }` | `app:answer` — the question after the moves (`focus`, `push`, `drop`, `by`, `window`…) |
| `{ t: 'app:catalog' }` | `app:catalog` — the dimensions, the views, the starting points |
| `{ t: 'app:members', dim, typed }` | `app:members` — members of a dimension a person can choose |

An answer carries `title`, `blocks` (the platform's answer blocks: kpis, table, bars, line…), `next` (moves a person can
take), `question` (as answered), `used` (window, settings), `asked` (every program run, with its rows and notes) and
`notes`. A refusal is `app:refused` with a sentence; a view that does not exist names the views there are.

## Writing a view

`server/app/` holds two parts:

- **The engine** — `index.mjs`, `loader.mjs`, `resolve.mjs`, `state.mjs`, `windows.mjs`, `read.mjs`: the same in every
  project; it comes with the template and is never edited in a project.
- **The project's part** — yours:
  - `facts.mjs` — `FACTS`: each fact a program of a domain (the composition graph's) the views read:
    `{ domain, program: '<file>.mjs', grain: 'one booking', paged: true, args: (p) => [...] }`. A paged program is asked
    for totals and pages, never every row.
  - `dimensions.mjs` — `DIMENSIONS`: what a question may be narrowed or broken down by, and the column carrying it on
    each fact (`fields: { <fact>: '<column>' }`). A fact without the column cannot be narrowed by it: refused, said.
  - `project.mjs` — the project's name, locale, currency, its starting points (`SCENARIOS`), how members are found.
  - `lib/` — helpers your views share.
  - `capabilities/<focus>/index.mjs` — one folder per view:

```js
export default {
  focus: 'payment-types',                       // its name — what a question's focus says
  label: 'Revenue by payment type',
  scenario: 'revenue',                          // which starting point it belongs to (project.mjs)
  whenToUse: 'How a year\'s revenue splits by how bookings are paid.',
  facts: ['bookings'],                          // the facts it reads (facts.mjs)
  honours: ['branch', 'client', 'from', 'to'],  // the filters it takes; any other is refused
  lenses: ['bars', 'table'],
  window: { kind: 'fiscal' },                   // its default time window (windows.mjs)
  async answer(q, c) {                          // q: the question; c: totals(fact, by, where), where(fact), read, today
    const types = await c.totals('bookings', ['payment_type'], await c.where('bookings'))
    const rows = types.map((x) => ({ key: x.payment_type, label: x.payment_type ?? 'not recorded', amount: x.amount }))
    return { title: 'Payment types', rows, notes: [], blocks: [
      { type: 'bars', title: 'Revenue by payment type', axis: 'payment-type', unit: 'money', series: [{ key: 'amount', label: 'Revenue' }],
        rows: rows.map((x) => ({ label: x.label, key: x.key, values: { amount: x.amount } })),
        rowMove: { dim: 'payment-type', key: 'key', label: 'label', focus: 'revenue' } },   // a click narrows another view
    ] }
  },
  next() { return [] },                         // moves to offer after the answer
}
```

Totals come from the source (`c.totals`), never from adding up rows shown; at most 100 rows reach a screen. A view
says nothing a fact does not give: a number is read, never typed.

Build it like any program: `sacli program build programs/views`, try it in your environment (`sacli dev`), then
`sacli program publish views` — and build the programs that use it again, so they link the new build.
