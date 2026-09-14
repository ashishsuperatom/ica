// UTILISATION = utilised hours ÷ available hours.
//
// Available hours are FTE × the working week × the weeks in the span, with FTE averaged over the span's
// month-ends — so people who joined or left part-way count for part of it. The working week, and which pillars
// are not delivery capacity at all, are assumptions: the organisation's, or the caller's.
//
// A ratio is a value per unit, so it is never added up. Every row's ratio is computed from that row's own
// hours and available hours, and the total is the ratio of the totals.
const DAY = 864e5
const weeks = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY / 7

export default async function (ctx, { during, by = [], pillar }) {
  // ── stage 1: what was typed becomes an id, before any number is asked for ────────────────────────────────
  const weekHours = ctx.assume('working week')
  const target = ctx.assume('utilisation target')
  const outside = ctx.assume('pillars outside capacity').map(String)
  const where = {}
  if (pillar) {
    const resolved = await ctx.call('resolve pillar', { name: pillar })
    if (resolved.status !== 'resolved') return resolved
    if (!ctx.decide('the pillar is delivery capacity', !outside.includes(String(resolved.id)), `${resolved.name} is ${outside.includes(String(resolved.id)) ? '' : 'not '}among the pillars outside capacity`)) {
      return { status: 'outside capacity', pillar: resolved.name }
    }
    where.pillar = resolved.id
  } else if (outside.length) {
    where.pillar = { notIn: outside }
    ctx.caveat(`${outside.length} pillar(s) are not counted as delivery capacity`)
  }

  // ── stage 2: a span that runs past today would divide part of a period's hours by all of its capacity ─────
  const today = ctx.today
  let { from, to } = ctx.span(during)
  if (!ctx.decide('the span has ended', to <= today, `span ends ${to}, today is ${today}`)) {
    to = today
    ctx.caveat(`the span is cut at ${today}: hours not yet recorded would otherwise count as unused capacity`)
  }

  // ── stage 3: the two concepts, asked the same question ────────────────────────────────────────────────────
  const hours = await ctx.call('utilised hours', { by, where, during: { from, to } })
  const byMonth = by.includes('month')
  const fte = await ctx.call('fte', byMonth
    ? { measures: ['fte'], by, where, during: { from, to } }
    : { measures: ['fte'], by, where, during: { from, to }, rollup: { time: 'average' } })

  // Weeks each row's capacity covers: the whole span, or the part of the span inside that row's month.
  const weeksFor = (row) => {
    if (!byMonth) return weeks(from, to)
    const start = `${row.month}-01`
    const next = new Date(Date.UTC(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)), 1)).toISOString().slice(0, 10)
    return weeks(start < from ? from : start, next > to ? to : next)
  }

  // ── stage 4: join on the split, and compute each row's ratio from its own parts ───────────────────────────
  const key = (row) => JSON.stringify(by.map((d) => row[d] ?? null))
  const rows = new Map()
  for (const r of fte.rows) {
    rows.set(key(r), { ...pick(r, fte.columns), hours: 0, available: r.fte * weekHours * weeksFor(r) })
  }
  for (const r of hours.rows) {
    const k = key(r)
    // Hours with no capacity behind them: someone recorded time in a pillar or month where they were not employed.
    if (!rows.has(k)) rows.set(k, { ...pick(r, hours.columns), hours: 0, available: 0 })
    rows.get(k).hours += r.hours
  }
  const ratio = (r) => (r.available > 0 ? r.hours / r.available : null)
  // The gap to a target is in points: 0.62 against 0.70 is −0.08, not a percentage of anything.
  const gap = (u) => (target == null || u == null ? {} : { gap: u - target })
  const out = [...rows.values()].map((r) => ({ ...r, utilisation: ratio(r), ...gap(ratio(r)) }))

  const unmatched = out.filter((r) => r.available === 0 && r.hours > 0)
  if (unmatched.length) {
    ctx.caveat(`${unmatched.length} row(s) have recorded hours and no capacity — time booked by people not employed there at the time; their utilisation is not given`)
  }

  // ── the check: the parts carry every hour and every available hour the whole has ──────────────────────────
  const total = { hours: sum(out, 'hours'), available: sum(out, 'available') }
  const allHours = sum(hours.rows, 'hours')
  await ctx.verify('every utilised hour is in exactly one row', () => Math.abs(total.hours - allHours) < 1e-6,
                   `rows ${round(total.hours)} · concept ${round(allHours)}`)

  return {
    columns: [
      ...hours.columns.filter((c) => c.role !== 'measure'),
      { name: 'hours', role: 'measure', unit: 'h', kind: 'flow' },
      { name: 'available', role: 'measure', unit: 'h', kind: 'flow' },
      { name: 'utilisation', role: 'measure', unit: 'ratio', kind: 'ratio' },
      ...(target == null ? [] : [{ name: 'gap', role: 'measure', unit: 'points', kind: 'ratio' }]),
    ],
    rows: out,
    total: { ...total, utilisation: ratio(total), ...gap(ratio(total)) },
    caveats: [],
  }
}

const pick = (row, columns) => Object.fromEntries(columns.filter((c) => c.role !== 'measure').map((c) => [c.name, row[c.name]]))
const sum = (rows, m) => rows.reduce((a, r) => a + Number(r[m] ?? 0), 0)
const round = (n) => Math.round(n * 1000) / 1000
