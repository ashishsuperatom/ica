// EXAMPLE — a reference TEMPLATE, not a real program. NEVER run it, and NEVER point built.json at it.
// It shows a common shape: a compute unit (query → group → rank) → a view unit (headline + ranked table).
// The source/schema is ILLUSTRATIVE ('EXAMPLE_DB' is fake) — find your REAL tables/columns with `./find-schema`,
// then write your OWN program+units in this shape against them.
export const meta = {
  name: 'example.grouped-ranking',
  concept: 'program',
  description: 'EXAMPLE: top-N groups by a measure (e.g. top customers by sales).',
  inputs: {
    year: 'number, optional — explicit calendar year; overrides asOf',
    asOf: 'ISO date, optional (defaults to today)',
    topN: 'number, optional (default 10)',
  },
  outputs: { answer: 'the answer view-model' },
  logic: 'sales-by-customer → ranking-view',
  dataSources: ['EXAMPLE_DB.sales', 'EXAMPLE_DB.customer'],
};

export const question = 'EXAMPLE: Who are our top 10 customers by sales this year?';

export default async function (ctx, params) {
  const g = await ctx.use('sales-by-customer', { year: params?.year, asOf: params?.asOf });
  ctx.log(`Ranked ${g.rows.length} customers for ${g.year}.`);
  return ctx.use('ranking-view', { grouped: g, topN: params?.topN ?? 10 });
}

export const ui = { category: 'dashboard' };
