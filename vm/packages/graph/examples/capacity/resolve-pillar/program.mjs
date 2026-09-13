// There are only a few dozen pillars, so the list is fetched whole and matched here. Resolution is a decision
// point: its answer — which pillar — is what the next query needs, so it has to run before anything else can.
const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

export default async function (ctx, { name }) {
  const pillars = await ctx.call('pillars')
  const typed = norm(name)
  const scored = pillars
    .map((p) => ({ id: p.id, name: p.name, distance: distance(typed, norm(p.name)) }))
    .sort((a, b) => a.distance - b.distance)

  const best = scored[0]
  // A typo is a handful of edits, not a different word. Past that, the honest answer is that nothing matched.
  const tolerance = Math.max(1, Math.floor(typed.length / 4))
  if (!ctx.decide('something close enough was typed', best.distance <= tolerance,
                  `closest is "${best.name}" at ${best.distance} edit(s); tolerance ${tolerance}`)) {
    return { status: 'no match', typed: name, closest: scored.slice(0, 3).map((p) => p.name) }
  }

  // TWO PILLARS CAN SHARE A NAME. Picking one would be a guess presented as a lookup.
  const tied = scored.filter((p) => p.distance === best.distance)
  if (!ctx.decide('exactly one pillar fits', tied.length === 1, `${tied.length} pillar(s) at ${best.distance} edit(s)`)) {
    ctx.caveat(`"${name}" matches ${tied.length} pillars with the same name — which one is meant is a choice, not a lookup`)
    return { status: 'ambiguous', typed: name, candidates: tied.map((p) => ({ id: p.id, name: p.name })) }
  }
  if (best.distance > 0) ctx.caveat(`read "${name}" as "${best.name}"`)
  return { status: 'resolved', id: best.id, name: best.name }
}
