// ── HOW PROGRAMS ARE WRITTEN, FOR THE AGENTS THAT WRITE THEM ──────────────────────────────────────────────────
// One reference, read by the composer and the analyst alike, so the two can never describe different contracts.
// It describes packages/graph as it is; when the engine changes, this changes with it.

export const GRAPH_REFERENCE = `# Programs

Everything that answers a question is a PROGRAM in the graph: a directory programs/<name>/ holding contract.json and
program.mjs, defined with \`./define programs/<name>\`. A program is identified by the hash of its body and contract;
its name points at it, and every question in the organisation shares it. \`--replace "<why>"\` corrects a program that is
wrong — every caller gets the correction, and a replacement that would break its callers is refused. It is never how a
follow-up is answered: a follow-up is a message.

Name a program for the idea it computes — \`utilised hours\`, \`capacity\`, \`utilisation\` — never for the question that
first asked for it. A concept's definition is a decision about the data: which rows count, which flag or type means what.
Establish it with ./query before writing it, and say it in the description.

## Two kinds

- A **concept** reads a data source. It is the only kind that may. \`"reads": { "sources": ["<SOURCE>"], "programs": [] }\`
- A **program** reads other programs, never a source. \`"reads": { "sources": [], "programs": ["<name>", …] }\`

## What a program returns — \`"returns"\`

- \`relation\` — a query not yet run, which callers ask with coordinates. Written as SQL at its finest grain.
- \`answer\` — what a person's question gets: data, views, narration, next steps. The program a question starts.
- \`value\` or \`rows\` — anything else.

## contract.json

\`\`\`json
{ "name": "utilised hours", "kind": "concept", "description": "One to three sentences: what this is.",
  "reads": { "sources": ["F5NETSUITE"], "programs": [] },
  "params": { "pillar": "a pillar as the person typed it" },
  "assumes": { "working week": { "description": "hours in a full-time week", "unit": "h", "default": 40 } },
  "returns": "relation",
  "shape": {
    "dimensions": { "employee": { "column": "employee_id", "label": "employee_name", "history": "stable", "entity": "employee", "description": "…" },
                    "pillar": { "column": "pillar_id", "label": "pillar_name", "history": "current" } },
    "measures": { "hours": { "aggregate": "sum", "column": "hours", "unit": "h", "kind": "flow", "description": "…" },
                  "per_entry": { "expression": "hours / entries", "unit": "h", "kind": "ratio" } },
    "time": "worked_on" } }
\`\`\`

- A relation's measures are all **flows** (they add over time: hours, revenue) or all **stocks** (true at an instant:
  headcount). A **ratio** is a derived measure (\`expression\` over other measures) and is never added up.
- \`aggregate\`: sum, count, count distinct, min, max, average, median. A flow needs \`time\`.
- \`history\`: stable (an identity), current (as it is today), as-at (as it was).
- \`entity\` on a dimension names what it identifies. \`"grain": "<dimension>"\` on a shape says each row is one member of
  that entity (one row per employee); then any relation with that entity can reach its dimensions as
  \`employee.manager\`.
- For money, \`"currency": "<dimension holding the code>"\` on the measure.
- Names and columns are lower-case identifiers, and never words SQL reserves.

## program.mjs

A concept returning a relation — SQL at its finest grain, every column the shape names in its output:
\`\`\`js
// A flow: called with { from, to }. A stock: called with { asAt }. Both YYYY-MM-DD.
export default (ctx, { from, to }) => ({
  source: 'F5NETSUITE',
  sql: \\\`SELECT tb.trandate AS worked_on, e.id AS employee_id, e.entityid AS employee_name, TO_NUMBER(tb.hours) AS hours
          FROM timebill tb JOIN employee e ON e.id = tb.employee
         WHERE tb.trandate >= TO_DATE(@from, 'YYYY-MM-DD') AND tb.trandate < TO_DATE(@to, 'YYYY-MM-DD')\\\`,
  params: { from, to },
})
\`\`\`

A program returning a relation — SQL over relations named in braces, never over tables:
\`\`\`js
export default () => ({ sql: "SELECT h.* FROM {{utilised hours}} h WHERE h.billable = 'T'" })
\`\`\`

Any other program — JavaScript:
\`\`\`js
export default async (ctx, { pillar, during }) => {
  const span = ctx.span(during)                        // relative dates → { from, to }
  const hours = await ctx.call('utilised hours', { by: ['month'], during: span, where: { pillar } })
  ctx.decide('the span has ended', span.to <= ctx.today, 'why')
  const hire = ctx.decideAt('utilised above the threshold', 0.72, '>', ctx.assume('hiring threshold'))
  await ctx.verify('every hour is counted once', () => true, 'detail')
  ctx.caveat('what the reader must know')
  return …
}
\`\`\`
\`ctx\`: call, decide, decideAt, verify, caveat, assume(name), span, today, who, expectation — and query(source, sql, params)
for a concept only. Never read the clock: use ctx.today.

## Asking a relation — coordinates

\`{ measures, by, where, having, order, limit, limitPer, during, at, rollup, compare, cumulative, rolling, fill, totals,
share, detail, currency }\`
- \`by\`: dimensions, attribute paths (employee.manager), and at most one time grain: day, week, month, quarter, year.
- \`where\`: \`{ pillar: '5' }\`, a list for any of, null for missing, or \`{ gte, lt, ne, in, notIn, contains, startsWith, isNull }\`;
  a label as \`pillar_label\`.
- \`during\`: \`{ from, to }\` (to exclusive), or \`{ this: 'quarter' }\`, \`{ this: 'month', toDate: true }\`, \`{ previous: 'month', count: 3 }\`,
  \`{ last: 30, unit: 'day' }\`. A stock takes \`at\` (a date, 'today', or \`{ endOf: 'month' }\`), or \`during\` with a time grain or a
  \`rollup: { time: 'last' | 'average' }\`.
- \`compare\`: \`{ offset: { years: 1 } }\`, \`{ during }\` or \`{ at }\` — adds \`<measure>_compare\`, \`_change\`, \`_change_ratio\`.
- \`order: [{ "by": "hours", "desc": true }]\` — required for \`limit\`. \`limitPer: ['pillar']\` keeps \`limit\` rows per group.
- \`totals: [['pillar'], []]\` adds totals at coarser splits. \`share: { measures, within }\`.
- \`detail: { limit }\` with an order returns the rows themselves.
A question the engine cannot answer correctly as asked is refused, with the reason — change the question, not the check.

## An answer — \`"returns": "answer"\`

The program a question asks. Its params are the question — so a follow-up is a message that changes them, and the
program never has to change for one. Take the coordinates the relation understands and pass them on:

\`\`\`js
// params: { "during": "the span", "by": "splits and a time grain", "where": "filters" }
export default async (ctx, { during = { previous: 'quarter' }, by = ['pillar'], where }) => {
  const result = await ctx.call('utilisation', { measures: ['utilisation', 'hours'], by, where, during: ctx.span(during),
                                                 order: [{ by: 'utilisation', desc: true }], totals: [[]] })
  const top = result.rows[0]
  const x = by.find((d) => d !== 'pillar') ?? 'pillar'
  const label = result.columns.some((c) => c.name === x + '_label') ? x + '_label' : x
  return {
    data: { result, total: { columns: result.totals[0].columns, rows: result.totals[0].rows } },
    views: [{ id: 'main', component: 'bar', data: 'result', title: 'Utilisation', encode: { x: label, y: 'utilisation' } }],
    narration: [
      { text: 'Overall utilisation was {all}; ' + top.pillar_label + ' was highest at {top}.',
        cites: { all: { data: 'total', column: 'utilisation' }, top: { data: 'result', row: 1, column: 'utilisation' } },
        why: 'utilised hours over available hours, for the span asked' },
    ],
    nextSteps: [{ label: 'By month', message: { set: { by: [...by, 'month'] } } },
                { label: 'Look into ' + top.pillar_label, message: { filter: { pillar: top.pillar } } }],
  }
}
\`\`\`
**A narration never types a number.** Each number is a {slot} citing a cell; the engine writes it from the data, and a
typed number is refused. Say what matters in the numbers — the total, the largest, the change, what stands out — not
that numbers are shown. Next steps are messages the person's data session can apply to this question's state; views
read the columns the result actually has, so they follow the splits.

## The person's data session — ./ask

Every answer is a step of the person's data session: a state (a program and what is asked of it) and its answer.
\`./ask '<message>'\` applies a message to the current state and answers it:
- \`{"ask":"<program>","request":{…}}\` — a new question; \`"keep": true\` carries the span and filters over
- \`{"set":{…}}\`, \`{"filter":{…}}\`, \`{"unfilter":[…]}\`, \`{"split":{"add":[…],"remove":[…]}}\`, \`{"measures":{"add":[…]}}\`
- \`{"assume":{…}}\`, \`{"intervene":{…}}\`, \`{"asOf":"YYYY-MM-DD"}\`
\`./find '{"row":3}'\` finds what the person was shown — "the third one" — and \`./find '{"text":"acme"}'\` anything named.
`
