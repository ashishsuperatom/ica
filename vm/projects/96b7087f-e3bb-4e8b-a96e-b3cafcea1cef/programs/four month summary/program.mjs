const firstOfMonth = (day, add = 0) => {
  const d = new Date(day.slice(0, 7) + '-01T00:00:00Z')
  d.setUTCMonth(d.getUTCMonth() + add)
  return d.toISOString().slice(0, 10)
}

export default async (ctx, { during, subsidiary = '2', pillar, top = 7, currency }) => {
  const span = ctx.span(during ?? { from: firstOfMonth(ctx.today), to: firstOfMonth(ctx.today, 4) })
  const reporting = currency ? { currency } : {}
  const months = await ctx.call('revenue against budget', { during: span, subsidiary, ...(pillar ? { pillar } : {}), ...reporting })
  const softProjects = await ctx.call('allocation revenue', {
    measures: ['revenue'], by: ['month', 'project'], during: span, ...reporting,
    where: { project_subsidiary: String(subsidiary), commitment: 'Soft', ...(pillar ? { project_pillar_label: pillar } : {}) },
    order: [{ by: 'month' }, { by: 'revenue', desc: true }], limit: Number(top), limitPer: ['month'],
  })

  const unit = months.columns.find((c) => c.name === 'projected_revenue').unit
  const sum = (k) => months.rows.reduce((n, r) => n + Number(r[k] ?? 0), 0)
  const totalBudget = months.rows.every((r) => r.budget != null) ? sum('budget') : null
  const total = {
    columns: [{ name: 'projected_revenue', role: 'measure', unit }, { name: 'budget', role: 'measure', unit }, { name: 'attainment', role: 'measure', unit: 'ratio' }],
    rows: [{ projected_revenue: sum('projected_revenue'), budget: totalBudget, attainment: totalBudget ? sum('projected_revenue') / totalBudget : null }],
    caveats: [],
  }
  const priced = months.rows.filter((r) => r.attainment != null)
  const worst = [...priced].sort((a, b) => a.attainment - b.attainment)[0]
  const scope = pillar ? `${pillar} ` : ''

  const narration = []
  if (totalBudget) narration.push({
    text: `Across these months ${scope}projected revenue is {projected} against a base budget of {budget}, {attainment} of it.`,
    cites: { projected: { data: 'total', column: 'projected_revenue' }, budget: { data: 'total', column: 'budget' }, attainment: { data: 'total', column: 'attainment' } },
    why: 'allocated hours times charge-out rate, hard and soft, against the base budget',
  })
  if (worst) narration.push({
    text: `{month} is the furthest from budget at {attainment}, with {soft} of its projected revenue still soft allocation.`,
    cites: { month: { data: 'months', row: { month: worst.month }, column: 'month' }, attainment: { data: 'months', row: { month: worst.month }, column: 'attainment' },
             soft: { data: 'months', row: { month: worst.month }, column: 'soft_share' } },
    why: 'the month with the lowest projected revenue against budget; soft allocation is revenue that may not convert',
  })
  const topSoft = worst && softProjects.rows.find((r) => r.month === worst.month)
  if (topSoft) narration.push({
    text: 'The largest soft allocation that month is {project}, at {amount}.',
    cites: { project: { data: 'soft', row: { month: worst.month, project: topSoft.project }, column: 'project_label' },
             amount: { data: 'soft', row: { month: worst.month, project: topSoft.project }, column: 'revenue' } },
    why: 'the project with the most soft revenue to convert in that month',
  })

  return {
    data: { months, total, soft: softProjects },
    views: [
      { id: 'against-budget', component: 'bar', data: 'months', title: 'Projected revenue against base budget', encode: { x: 'month', y: ['hard_revenue', 'soft_revenue'], target: 'budget' } },
      { id: 'months', component: 'table', data: 'months', title: 'By month', encode: { columns: ['month', 'projected_revenue', 'budget', 'attainment', 'hard_share', 'soft_share'] } },
      { id: 'soft-projects', component: 'table', data: 'soft', title: 'Remaining soft by project', encode: { columns: ['month', 'project_label', 'revenue'] } },
    ],
    narration,
    nextSteps: [
      { label: 'If 80% of hard and 10% of soft converts', message: { assume: { 'hard conversion': 0.8, 'soft conversion': 0.1 } }, why: 'a realistic conversion, and what it leaves short of budget' },
      ...(pillar ? [{ label: 'All pillars', message: { set: { pillar: null } } }] : [{ label: 'For one pillar', message: { set: { pillar: 'CEC' } } }]),
      { label: 'In NZ', message: { set: { subsidiary: '3' } } },
    ],
  }
}
