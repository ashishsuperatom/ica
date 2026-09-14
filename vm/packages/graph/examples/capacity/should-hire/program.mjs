// A decision, recorded with the number it turned on: last quarter's utilisation for the pillar against the
// organisation's hiring threshold. Asked again later — review — "last quarter" is a later quarter, and the decision
// reopens if it now goes the other way.
export default async function (ctx, { pillar }) {
  const threshold = ctx.assume('hiring threshold')
  const answer = await ctx.call('utilisation', { during: { previous: 'quarter' }, by: [], pillar })
  if (!answer.total) return answer
  const hire = ctx.decideAt('last quarter was utilised above the hiring threshold', answer.total.utilisation, '>', threshold)
  return { pillar, utilisation: answer.total.utilisation, threshold, hire }
}
