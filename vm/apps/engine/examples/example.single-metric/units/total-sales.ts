// EXAMPLE unit — illustrative only. Replace EXAMPLE_DB + the columns with your REAL source (./find-schema),
// and write the query for THAT source's dialect. This file teaches structure, not schema.
export const meta = {
  name: 'total-sales',
  concept: 'aggregate',
  description: 'EXAMPLE: total sales amount for a calendar year.',
  inputs: { year: 'number, optional', asOf: 'ISO date, optional' },
  outputs: { year: 'number', total: 'number', currency: 'string', n: 'number' },
  logic: 'SUM(sales.amount) WHERE year(sale_date) = year',
  dataSources: ['EXAMPLE_DB.sales'],
};

export default async function (ctx, params) {
  // Compute relative time from asOf — never a frozen date.
  const asOf = params?.asOf ? new Date(params.asOf) : new Date();
  const year = params?.year ?? asOf.getFullYear();

  // Values go inline (no @name binds). Compare against how a value is ACTUALLY stored (check with ./find-schema).
  const [row] = await ctx.query(
    'EXAMPLE_DB',
    `SELECT SUM(amount) AS total, COUNT(*) AS n
     FROM sales
     WHERE EXTRACT(YEAR FROM sale_date) = ${year}`
  );
  ctx.decide('year', true, `"this year" resolved to ${year} from asOf`);

  return { year, total: Number(row?.total ?? 0), currency: 'AUD', n: Number(row?.n ?? 0) };
}

export const ui = { category: 'simple' };
