import { money, num } from '@superatom/scaffold';

// EXAMPLE unit — shapes a ranking into a headline + top-N table answer card.
export const meta = {
  name: 'ranking-view',
  concept: 'ui',
  description: 'EXAMPLE: formats a ranked group list into the answer card (headline total + top-N table).',
  inputs: { grouped: 'output of sales-by-customer', topN: 'number' },
  outputs: { answer: 'the answer view-model' },
  logic: 'headline = money(grand total); table = top-N rows, the customer carrying its id and the amount its raw value.',
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
      // THE PROGRAM DECIDES HOW EACH FIGURE READS — it is the only thing holding both the raw value and what the
      // value means. The three cases below are the whole rule; the customer/sales/count here are just this
      // program's instance of it.
      //
      //   MOST CELLS ARE PLAIN. A number, a string. That is what sorts, right-aligns and totals, and it is the
      //   default — wrapping one that needs nothing adds a shape for the reader to see through.
      //
      //   { value, id }        the cell NAMES a thing the reader may want to open on its own. Send the id
      //                        whenever the computation already has it: it is the only handle on that thing,
      //                        and a name alone cannot be looked up again.
      //
      //   { value, display }   the way it reads cannot be derived from the value — a currency, a duration, any
      //                        unit the number does not carry. Send BOTH. The formatted string ALONE loses the
      //                        number, and with it the sorting, the alignment and the bar.
      //
      // Whatever is true of a whole COLUMN is said once on the column — never repeated on every row.
      sections: [{
        kind: 'table',
        title: 'Sales by customer',
        columns: [
          { label: 'Customer', entity: 'customer' },   // this column names things: its cells carry ids
          { label: 'Sales', good: 'high', bar: true }, // higher is better here; the program knows, the UI cannot
          { label: 'Orders' },                         // an ordinary count — nothing to declare, nothing to wrap
        ],
        rows: top.map((r) => [
          { value: r.customerName, id: r.customerId },        // identified
          { value: r.total, display: money(r.total, 'AUD') }, // formatted, and still a number
          r.n,                                                // plain, and that is the common case
        ]),
      }],
      status: 'answered',
    },
  };
}

export const ui = { category: 'dashboard' };
