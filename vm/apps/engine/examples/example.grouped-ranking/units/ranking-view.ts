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
  // THE ANSWER CONTRACT, in the shape the renderer actually draws:
  //   headline  an OBJECT — { label, display, value }. A bare string draws no KPI at all, and the engine's
  //             degenerate-run check reads `headline.value` to decide whether anything came back.
  //   answer    the PROSE — a string, or an array of short lines. Never the view-model itself.
  //   sections  the current format for tables. A flat top-level `table` still renders, but only for
  //             backward compatibility with programs written before sections existed.
  // `subtitle` was here and is not part of the contract — it rendered nowhere.
  return {
    answer: {
      headline: { label: `Total sales ${g.year}`, display: money(g.total, 'AUD'), value: g.total },
      answer: `Top ${top.length} of ${num(g.rows.length)} customers by sales in ${g.year}.`,
      sections: [{
        kind: 'table',
        title: 'Sales by customer',
        columns: ['Customer', 'Sales'],
        rows: top.map((r) => [r.customerName, money(r.total, 'AUD')]),
      }],
      status: 'answered',
    },
  };
}

export const ui = { category: 'dashboard' };
