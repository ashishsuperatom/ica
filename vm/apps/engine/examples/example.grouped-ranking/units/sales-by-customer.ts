// EXAMPLE unit — illustrative only. Replace EXAMPLE_DB + the columns with your REAL source (./find-schema),
// and write the query for THAT source's dialect (JOIN to whatever table carries the label you want to rank by).
export const meta = {
  name: 'sales-by-customer',
  concept: 'aggregate',
  description: 'EXAMPLE: sales totals per customer for a year, ranked high→low.',
  inputs: { year: 'number, optional', asOf: 'ISO date, optional' },
  outputs: { year: 'number', rows: '[{ customerId, customerName, total, n }]', total: 'number' },
  logic: 'JOIN sales→customer; GROUP BY customer; SUM(amount); ORDER BY total DESC',
  dataSources: ['EXAMPLE_DB.sales', 'EXAMPLE_DB.customer'],
};

export default async function (ctx, params) {
  const asOf = params?.asOf ? new Date(params.asOf) : new Date();
  const year = params?.year ?? asOf.getFullYear();

  const raw = await ctx.query(
    'EXAMPLE_DB',
    `SELECT s.customer_id AS customerId, c.name AS customerName,
            SUM(s.amount) AS total, COUNT(*) AS n
     FROM sales s JOIN customer c ON c.id = s.customer_id
     WHERE EXTRACT(YEAR FROM s.sale_date) = ${year}
     GROUP BY s.customer_id, c.name`
  );
  ctx.decide('year', true, `"this year" resolved to ${year} from asOf`);

  // Rank in code (keep the query about the data; keep presentation choices like top-N out of the SQL).
  const rows = raw
    .map((r) => ({ customerId: r.customerid, customerName: r.customername, total: Number(r.total), n: Number(r.n) }))
    .sort((a, b) => b.total - a.total);

  return { year, rows, total: rows.reduce((s, r) => s + r.total, 0) };
}

export const ui = { category: 'simple' };
