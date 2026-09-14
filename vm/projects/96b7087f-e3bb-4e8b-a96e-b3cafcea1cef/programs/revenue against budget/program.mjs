// One row per month of the span. Budget is held by accounting period and department; its departments are named as
// the pillars, so a pillar is matched on its name.
const monthsOf = (from, to) => {
  const out = []
  for (let d = new Date(from.slice(0, 7) + '-01T00:00:00Z'); d.toISOString().slice(0, 10) < to; d.setUTCMonth(d.getUTCMonth() + 1)) out.push(d.toISOString().slice(0, 7))
  return out
}

export default async (ctx, { during = { this: 'month' }, subsidiary = '2', pillar, currency }) => {
  const span = ctx.span(during)
  const hardConversion = Number(ctx.assume('hard conversion'))
  const softConversion = Number(ctx.assume('soft conversion'))
  const reporting = currency ? { currency } : {}

  const revenue = await ctx.call('allocation revenue', {
    measures: ['revenue', 'unpriced_hours'], by: ['month', 'commitment'], during: span, ...reporting,
    where: { project_subsidiary: String(subsidiary), ...(pillar ? { project_pillar_label: pillar } : {}) },
  })
  const budget = await ctx.call('base budget', {
    measures: ['budget'], by: ['month'], during: span, ...reporting,
    where: { subsidiary: String(subsidiary), ...(pillar ? { pillar_label: pillar } : {}) },
  })
  const unit = revenue.columns.find((c) => c.name === 'revenue')?.unit ?? 'money'

  const rows = monthsOf(span.from, span.to).map((month) => {
    const of = (commitment, measure) => revenue.rows.filter((r) => r.month === month && r.commitment === commitment).reduce((n, r) => n + Number(r[measure] ?? 0), 0)
    const hard = of('Hard', 'revenue'), soft = of('Soft', 'revenue')
    const projected = hard * hardConversion + soft * softConversion
    const base = budget.rows.find((r) => r.month === month)?.budget
    return {
      month,
      hard_revenue: hard, soft_revenue: soft, projected_revenue: projected,
      budget: base ?? null,
      attainment: base ? projected / base : null,
      shortfall: base != null ? base - projected : null,
      hard_share: hard + soft ? hard / (hard + soft) : null,
      soft_share: hard + soft ? soft / (hard + soft) : null,
      unpriced_hours: of('Hard', 'unpriced_hours') + of('Soft', 'unpriced_hours'),
    }
  })

  const unpriced = rows.reduce((n, r) => n + r.unpriced_hours, 0)
  if (unpriced > 0) ctx.caveat(`${Math.round(unpriced).toLocaleString('en-AU')} allocated hours have no charge-out rate, so they project no revenue`)
  if (hardConversion !== 1 || softConversion !== 1) ctx.caveat(`projected revenue assumes ${Math.round(hardConversion * 100)}% of hard and ${Math.round(softConversion * 100)}% of soft allocation converts`)
  for (const r of rows) if (r.budget == null) ctx.caveat(`there is no base budget for ${r.month}`)

  const money = { role: 'measure', unit, kind: 'flow' }
  return {
    columns: [
      { name: 'month', role: 'time' },
      { name: 'hard_revenue', ...money }, { name: 'soft_revenue', ...money }, { name: 'projected_revenue', ...money },
      { name: 'budget', ...money }, { name: 'attainment', role: 'measure', unit: 'ratio' }, { name: 'shortfall', ...money },
      { name: 'hard_share', role: 'measure', unit: 'ratio' }, { name: 'soft_share', role: 'measure', unit: 'ratio' },
      { name: 'unpriced_hours', role: 'measure', unit: 'h', kind: 'flow' },
    ],
    rows,
    caveats: [],
  }
}
