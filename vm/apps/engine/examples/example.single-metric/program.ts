// EXAMPLE — a reference TEMPLATE, not a real program. NEVER run it, and NEVER point built.json at it.
// It shows the SHAPE of the simplest program: one compute unit → one view unit. The source/schema below is
// ILLUSTRATIVE ('EXAMPLE_DB' is fake) — find your REAL source + columns with `./sources` and `./find-schema`,
// then write your OWN program+units in this shape against them (its imports resolve because it lives in programs/).
export const meta = {
  name: 'example.single-metric',
  concept: 'program',
  description: 'EXAMPLE: a single headline metric (e.g. total sales this year).',
  inputs: { year: 'number, optional — explicit calendar year; overrides asOf', asOf: 'ISO date, optional (defaults to today)' },
  outputs: { answer: 'the answer view-model' },
  logic: 'total-sales → single-metric-view',
  dataSources: ['EXAMPLE_DB.sales'],
};

export const question = 'EXAMPLE: What were our total sales this year?';

export default async function (ctx, params) {
  const m = await ctx.use('total-sales', { year: params?.year, asOf: params?.asOf });
  ctx.log(`Total sales for ${m.year}: ${m.total}`);
  return ctx.use('single-metric-view', { metric: m });
}

export const ui = { category: 'kpi' };
