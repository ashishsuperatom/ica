// Two stages, because the second cannot be written until the first has run: which pillar was meant has to be
// known before anyone can count within it.
export default async function (ctx, { pillar }) {
  const resolved = await ctx.call('resolve pillar', { name: pillar })
  if (resolved.status !== 'resolved') return resolved

  const { headcount } = await ctx.call('active headcount', { pillarId: resolved.id })
  return { pillar: resolved.name, headcount }
}
