import { money, num } from '@superatom/scaffold';

// EXAMPLE unit — shapes one metric into the answer card. The @superatom/scaffold import resolves from the
// monorepo exactly as it does for a real unit (that is why examples live under programs/, not a separate dir).
export const meta = {
  name: 'single-metric-view',
  concept: 'ui',
  description: 'EXAMPLE: formats a single metric into the answer card.',
  inputs: { metric: 'output of total-sales' },
  outputs: { answer: 'the answer view-model' },
  logic: 'headline = the one number, labelled and formatted; caveat = what it covers.',
  dataSources: [],
};

// THE ANSWER CONTRACT. `headline` is an OBJECT — { label, display, value } — not a string. The renderer reads
// `headline.display` to draw the KPI, and the engine's degenerate-run check reads `headline.value` to know a
// number came back at all. A bare string gives neither, so the card renders empty AND a perfectly good answer
// is counted as nothing. This example taught the string form to BOTH agents; it stayed invisible only because
// the analyst's own role prompt overrides it and a wrong-shaped composer answer escalates to the analyst.
export default async function (_ctx, params) {
  const m = params.metric;
  return {
    answer: {
      headline: { label: 'Total sales', display: money(m.total, m.currency), value: m.total },
      caveat: `${num(m.n)} sales in ${m.year}`,
      status: 'answered',
    },
  };
}

export const ui = { category: 'kpi' };
