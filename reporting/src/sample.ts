// A representative Answer used by the local sample render AND by the deployed
// worker's /sample route, so what you see in a browser is what the test produces.
// Deliberately oversized (60 rows, 9 columns, 8 figures) so the fit heuristics fire.
import type { Answer } from './types.js'

const rows: unknown[][] = []
const branches = ['Auckland Central','Hamilton','Tauranga','Wellington','Christchurch','Dunedin','Palmerston North','Napier','Rotorua','Invercargill','New Plymouth','Whangarei']
for (let i = 0; i < 60; i++) {
  const b = branches[i % branches.length] + (i >= branches.length ? ` Depot ${Math.floor(i / branches.length) + 1}` : '')
  const rev = 4_200_000 - i * 61_000
  const marg = (28.4 - i * 0.31).toFixed(1)
  rows.push([b, '$' + rev.toLocaleString('en-US'), marg + '%', (1200 - i * 13).toLocaleString('en-US'),
    '$' + Math.round(rev / (1200 - i * 13)).toLocaleString('en-US'), (i % 7) - 3 + '%', 'NZ', 'Freight', i % 3 === 0 ? 'Yes' : 'No'])
}

export const sampleAnswer: Answer = {
  status: 'answered',
  category: 'profitability_analysis',
  answer: 'Six branches carry the network. Auckland Central, Hamilton and Tauranga together produce 41% of revenue at above-average margin, while the eleven smallest depots contribute under 6% combined and three of them run below the 12% margin floor.\n\nThe gap is widening: the top quartile improved margin 1.8pts year on year, the bottom quartile lost 2.4pts.',
  period: 'FY2026 year to date (1 Apr – 20 Aug 2026)',
  scope: 'All branches · freight only · excludes intercompany',
  figures: [
    { label: 'Network revenue', display: '$104.2M', sub: '+7.3% YoY', neg: false },
    { label: 'Gross margin', display: '19.6%', sub: '−0.8pts YoY', neg: true },
    { label: 'Branches above floor', display: '9 of 12' },
    { label: 'Loss-making depots', display: '3', sub: 'Invercargill, Whangarei, Napier', neg: true },
    { label: 'Revenue concentration', display: '41%', sub: 'top 3 branches' },
    { label: 'Consignments', display: '1.42M', sub: '+2.1% YoY', neg: false },
    { label: 'Avg revenue / consignment', display: '$73.40' },
    { label: 'Cost to serve', display: '$59.00', sub: '+4.9% YoY', neg: true },
  ],
  table: {
    columns: ['Branch', 'Revenue', 'Margin %', 'Consignments', 'Rev / consignment', 'YoY Δ', 'Region', 'Division', 'Above floor'],
    rows,
    totalRows: 240,
    total: ['Total', '$104,208,000', '19.6%', '1,420,000', '$73.40', '+2%', '—', '—', '9'],
  },
  sections: [
    { kind: 'kpis', title: 'Bottom quartile', items: [
      { label: 'Invercargill', display: '−4.2%', sub: 'margin', neg: true },
      { label: 'Whangarei', display: '−1.1%', sub: 'margin', neg: true },
      { label: 'Napier', display: '2.8%', sub: 'margin', neg: true },
    ]},
    { kind: 'table', title: 'Below the 12% margin floor', columns: ['Branch', 'Margin %', 'Revenue', 'Months below'],
      rows: [['Invercargill','−4.2%','$1.02M','9'],['Whangarei','−1.1%','$1.44M','7'],['Napier','2.8%','$2.11M','4']],
      note: 'Margin floor is the FY2026 board target of 12%.' },
    { kind: 'text', title: 'What changed', body: 'Cost to serve rose 4.9% against a 2.1% lift in volume, so the smaller depots lost the scale that was covering their fixed costs. **Fuel and linehaul** account for roughly two thirds of the increase.' },
  ],
  caveat: 'Excludes 4 branches onboarded after 1 July 2026, which have under 60 days of trading history.',
}
