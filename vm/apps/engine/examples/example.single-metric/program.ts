// EXAMPLE — a reference TEMPLATE, not a real program. NEVER run it, and NEVER point built.json at it.
// It shows the SHAPE of the simplest program: one compute unit → one view unit. The source/schema below is
// ILLUSTRATIVE ('EXAMPLE_DB' is fake) — find your REAL source + columns with `./sources` and `./find-schema`,
// then write your OWN program+units in this shape against them (its imports resolve because it lives in programs/).
export const meta = {
  name: 'example.single-metric',
  concept: 'program',
  description: 'EXAMPLE: a single headline metric (e.g. total sales this year).',
  inputs: { year: 'number, optional — explicit calendar year; overrides asOf', asOf: 'ISO date, optional (defaults to today)' },
  outputs: { answer: 'the answer view-model' },   // the UNIT's output name; the program returns view.answer
  logic: 'total-sales → single-metric-view',
  dataSources: ['EXAMPLE_DB.sales'],
};

export const question = 'EXAMPLE: What were our total sales this year?';

// A PROGRAM RETURNS THE VIEW-MODEL — not the unit's envelope.
//
// A unit may have several named outputs, so `ctx.use()` hands back an object of them; a UI unit's is `answer`.
// Returning that object directly makes the program's output an envelope with the view one level down, and
// every consumer then has to remember to unwrap it. Three of them did not: they spread the envelope, so the
// answer card read the whole view-model as its prose and printed "[object Object]" while the KPI and every
// table silently disappeared.
//
// The program picks the output that IS the answer. One rule, no unwrapping anywhere downstream.
export default async function (ctx, params) {
  const m = await ctx.use('total-sales', { year: params?.year, asOf: params?.asOf });
  ctx.log(`Total sales for ${m.year}: ${m.total}`);
  const view = await ctx.use('single-metric-view', { metric: m });
  return view.answer;
}

export const ui = { category: 'kpi' };
