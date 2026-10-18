import type { Criterion } from './signal.js'

// "Increase ESG weight by 10%" means: bump that one weight multiplicatively,
// then shrink every OTHER weight proportionally so the set still sums to 1.
// Without that rescaling "weights sum to 1" stops being true and the
// BEST_OPTION score stops meaning what it used to -- this is the one real
// design decision a weight tweak has to make, so it's explicit, not buried.
export function adjustWeight(criteria: Criterion[], field: string, deltaPercent: number): Criterion[] {
  const target = criteria.find(c => c.field === field)
  if (!target) throw new Error(`no such criterion: ${field}`)

  const bumped = target.weight * (1 + deltaPercent / 100)
  const othersTotal = criteria.filter(c => c.field !== field).reduce((s, c) => s + c.weight, 0)
  const remaining = 1 - bumped

  return criteria.map(c =>
    c.field === field
      ? { ...c, weight: bumped }
      : { ...c, weight: othersTotal > 0 ? (c.weight / othersTotal) * remaining : 0 }
  )
}
