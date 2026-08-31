import { money, num } from '@superatom/scaffold';

// EXAMPLE unit — shapes one metric into the answer card. The @superatom/scaffold import resolves from the
// monorepo exactly as it does for a real unit (that is why examples live under programs/, not a separate dir).
export const meta = {
  name: 'single-metric-view',
  concept: 'ui',
  description: 'EXAMPLE: formats a single metric into the answer card.',
  inputs: { metric: 'output of total-sales' },
  outputs: { answer: 'the answer view-model' },
  logic: 'headline = money(total); subtitle = count + year.',
  dataSources: [],
};

export default async function (_ctx, params) {
  const m = params.metric;
  return {
    answer: {
      headline: money(m.total, m.currency),
      subtitle: `${num(m.n)} sales in ${m.year}`,
      status: 'answered',
    },
  };
}

export const ui = { category: 'kpi' };
