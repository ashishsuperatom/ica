// The window, edited by its kind: months chosen in a list (a draft while open, committed on close), weeks as past and
// future steppers, days with presets, a range of dates, the financial year stepped through the years the organisation
// names. Every commit is one `window` move.

import { Icon } from '../ui/Icon'
import MultiSelect from '../ui/MultiSelect'
import { useDraft } from '../../lib/draft'
import { month as monthWords, shortDate } from '../../lib/format'

const pad = (n: number) => String(n).padStart(2, '0')
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}` }
const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d) }
const mondayOf = (s: string) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return isoDay(d) }

type W = Record<string, any>
type Props = { kind: string; value?: W; today: string; latest?: string; years: string[]; disabled?: boolean; onChange: (w: W) => void }

function Stepper({ label, value, min, step = 1, disabled, onChange }: { label: string; value: number; min: number; step?: number; disabled?: boolean; onChange: (n: number) => void }) {
  return (
    <span className="sa-stepper" title={label}>
      <span className="sa-stepper__label">{label}</span>
      <button className="sa-icon-btn sa-icon-btn--sm sa-icon-btn--framed" disabled={disabled || value - step < min} onClick={() => onChange(value - step)} aria-label={`${label} less`}><Icon icon="lucide:minus" /></button>
      <span className="sa-stepper__value">{value}</span>
      <button className="sa-icon-btn sa-icon-btn--sm sa-icon-btn--framed" disabled={disabled} onClick={() => onChange(value + step)} aria-label={`${label} more`}><Icon icon="lucide:plus" /></button>
    </span>
  )
}

export default function WindowControl({ kind, value, today, latest, years, disabled, onChange }: Props) {
  const w: W = value && value.kind === kind ? value : { kind }
  const t = /^\d{4}-\d{2}-\d{2}/.test(today) ? today.slice(0, 10) : new Date().toISOString().slice(0, 10)
  if (kind === 'months') return <Months w={w} thisMonth={t.slice(0, 7)} disabled={disabled} onChange={onChange} />
  if (kind === 'range') return <Range w={w} today={t} latest={latest} disabled={disabled} onChange={onChange} />
  if (kind === 'weeks') {
    const past = w.past ?? 4, future = w.future ?? 4
    const set = (p: number, f: number) => p + f > 0 && onChange({ kind, past: p, future: f })
    return (
      <span className="sa-row">
        <span className="sa-label">Weeks</span>
        <Stepper label="past" value={past} min={0} disabled={disabled} onChange={(n) => set(n, future)} />
        <Stepper label="future" value={future} min={0} disabled={disabled} onChange={(n) => set(past, n)} />
      </span>
    )
  }
  if (kind === 'days' || kind === 'pastDays') {
    const days = w.days ?? 30
    return (
      <span className="sa-row">
        <span className="sa-label">{kind === 'days' ? 'Next' : 'Last'}</span>
        <Stepper label="days" value={days} min={1} step={days <= 7 ? 1 : 7} disabled={disabled} onChange={(n) => onChange({ kind, days: n })} />
        <span className="sa-toggle" role="radiogroup" aria-label="Preset">
          {[30, 60, 90].map((n) => <button key={n} role="radio" aria-checked={days === n} data-on={days === n} disabled={disabled} onClick={() => onChange({ kind, days: n })} className="sa-toggle__btn sa-toggle__btn--text">{n}</button>)}
        </span>
      </span>
    )
  }
  const i = w.year ? years.indexOf(w.year) : -1
  const go = (d: number) => { const next = years[i + d]; if (next) onChange({ kind, year: next }) }
  return (
    <span className="sa-row">
      <span className="sa-label">Financial year</span>
      <span className="sa-stepper" role="group" aria-label="Financial year">
        <button type="button" className="sa-icon-btn" disabled={disabled || i <= 0} onClick={() => go(-1)} aria-label="The year before" title="The year before"><Icon icon="lucide:chevron-left" /></button>
        <span className="sa-stepper__value">{w.year ?? '—'}</span>
        <button type="button" className="sa-icon-btn" disabled={disabled || i < 0 || i >= years.length - 1} onClick={() => go(1)} aria-label="The year after" title="The year after"><Icon icon="lucide:chevron-right" /></button>
      </span>
    </span>
  )
}

function Months({ w, thisMonth, disabled, onChange }: { w: W; thisMonth: string; disabled?: boolean; onChange: (w: W) => void }) {
  const months = useDraft<string[]>([...(w.months ?? [])].sort(), (v) => v.length && onChange({ kind: 'months', months: [...v].sort() }))
  const chosen = months.value
  const first = chosen[0] && chosen[0] < addMonths(thisMonth, -3) ? chosen[0] : addMonths(thisMonth, -3)
  const last = chosen[chosen.length - 1] && chosen[chosen.length - 1] > addMonths(thisMonth, 8) ? chosen[chosen.length - 1] : addMonths(thisMonth, 8)
  const all: string[] = []
  for (let m = first; m <= last && all.length < 36; m = addMonths(m, 1)) all.push(m)
  const quarters = [0, 1, 2, 3].map((qi) => ({ value: `q${qi + 1}`, label: `Q${qi + 1}`, values: all.filter((m) => Math.floor((Number(m.slice(5)) - 1) / 3) === qi) })).filter((g) => g.values.length)
  return (
    <span className="sa-row sa-row--tight">
      <Icon icon="lucide:calendar-days" className="sa-btn__icon" />
      <MultiSelect variant="chip" label={months.dirty ? 'Months (editing)' : 'Months'} noun={['month', 'months']} value={chosen} disabled={disabled} onChange={months.set} onOpen={months.start} onClose={months.close}
        options={all.map((m) => ({ value: m, label: monthWords(m) }))} groups={quarters} groupsLabel="Quarters" allLabel="The next four months" />
    </span>
  )
}

function Range({ w, today, latest, disabled, onChange }: { w: W; today: string; latest?: string; disabled?: boolean; onChange: (w: W) => void }) {
  const from = w.from ?? mondayOf(today), through = w.through ?? addDays(mondayOf(today), 6)
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s)
  const set = (f: string, th: string, said?: string, compare = w.compare) => { if (ok(f) && ok(th) && f <= th) onChange({ kind: 'range', from: f, through: th, ...(said ? { said } : {}), ...(compare ? { compare: true } : {}) }) }
  const monthEnd = (s: string) => addDays(addMonths(s.slice(0, 7), 1) + '-01', -1)
  const presets: Array<[string, string, string, string?]> = [
    ...(latest && ok(latest) ? [['Last week with entries', mondayOf(latest), addDays(mondayOf(latest), 6), 'the last week with entries'] as [string, string, string, string]] : []),
    ['This week', mondayOf(today), addDays(mondayOf(today), 6)],
    ['Last week', addDays(mondayOf(today), -7), addDays(mondayOf(today), -1)],
    ['This month', `${today.slice(0, 7)}-01`, monthEnd(today)],
  ]
  return (
    <span className="sa-row">
      <span className="sa-label">Days</span>
      <label className="sa-field" title="From"><input className="sa-input sa-input--sm sa-input--date" type="date" value={from} max={through} disabled={disabled} onChange={(e) => set(e.target.value, through)} aria-label="From" /></label>
      <span className="sa-faint">–</span>
      <label className="sa-field" title="Through"><input className="sa-input sa-input--sm sa-input--date" type="date" value={through} min={from} disabled={disabled} onChange={(e) => set(from, e.target.value)} aria-label="Through" /></label>
      <span className="sa-toggle" role="radiogroup" aria-label="Preset">
        {presets.map(([label, f, th, said]) => <button key={label} role="radio" aria-checked={from === f && through === th} data-on={from === f && through === th} disabled={disabled} onClick={() => set(f, th, said)} className="sa-toggle__btn sa-toggle__btn--text" title={`${shortDate(f)} – ${shortDate(th)}`}>{label}</button>)}
      </span>
      <button type="button" role="switch" aria-checked={!!w.compare} data-on={!!w.compare} disabled={disabled} className="sa-toggle sa-toggle__btn sa-toggle__btn--text" title="Put the same span one period back beside each figure" onClick={() => set(from, through, w.said, !w.compare)}>
        <Icon icon={w.compare ? 'lucide:check' : 'lucide:git-compare-arrows'} className="sa-btn__icon" />vs the period before
      </button>
    </span>
  )
}
