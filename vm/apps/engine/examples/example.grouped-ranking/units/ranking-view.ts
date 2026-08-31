import { money, num } from '@superatom/scaffold';

// EXAMPLE unit — shapes a ranking into a headline + top-N table answer card.
export const meta = {
  name: 'ranking-view',
  concept: 'ui',
  description: 'EXAMPLE: formats a ranked group list into the answer card (headline total + top-N table).',
  inputs: { grouped: 'output of sales-by-customer', topN: 'number' },
  outputs: { answer: 'the answer view-model' },
  logic: 'headline = money(grand total); table = top-N rows [name, amount].',
  dataSources: [],
};

export default async function (_ctx, params) {
  const g = params.grouped;
  const top = g.rows.slice(0, params.topN ?? 10);
  return {
    answer: {
      headline: money(g.total, 'AUD'),
      subtitle: `${num(g.rows.length)} customers in ${g.year}`,
      table: {
        columns: ['Customer', 'Sales'],
        rows: top.map((r) => [r.customerName, money(r.total, 'AUD')]),
      },
      status: 'answered',
    },
  };
}

export const ui = { category: 'dashboard' };
