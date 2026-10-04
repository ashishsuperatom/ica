// The window, edited by its kind: months are chosen in the MultiSelect (a draft while open, committed on close —
// lib/draft), weeks are past/future steppers, days a stepper with presets, the fiscal year a stepper (each click is
// a choice and commits at once). Every commit is one `window` operation on the block.

import { useApp } from '@/lib/catalog'
import { Icon } from '@iconify/react'
import { MultiSelect, useDraft } from '@superatom/ui'
import { month as monthWords, shortDate } from '@superatom/ui'
import type { Window, WindowKind } from '@/lib/wire'

const pad = (n: number) => String(n).padStart(2, '0')
const addMonths = (ym: string, n: number) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}` }

function Stepper({ label, value, min, step = 1, disabled, onChange }: { label: string; value: number; min: number; step?: number; disabled: boolean; onChange: (n: number) => void }) {
  return (
    <span className="sa-stepper" title={label}>
      <span className="sa-stepper__label">{label}</span>
      <button className="sa-icon-btn sa-icon-btn--sm sa-icon-btn--framed" disabled={disabled || value - step < min} onClick={() => onChange(value - step)} aria-label={`${label} less`}><Icon icon="lucide:minus" /></button>
      <span className="sa-stepper__value">{value}</span>
      <button className="sa-icon-btn sa-icon-btn--sm sa-icon-btn--framed" disabled={disabled} onClick={() => onChange(value + step)} aria-label={`${label} more`}><Icon icon="lucide:plus" /></button>
    </span>
  )
}

export default function WindowControl({ kind, value, today, latest, disabled, onChange }: { kind: WindowKind; value: Window | undefined; today: string; latest?: string; disabled: boolean; onChange: (w: Window) => void }) {
  const w: Window = value && value.kind === kind ? value : { kind }
  const thisMonth = /^\d{4}-\d{2}/.test(today) ? today.slice(0, 7) : new Date().toISOString().slice(0, 7)
  if (kind === 'months') return <Months w={w} thisMonth={thisMonth} disabled={disabled} onChange={onChange} />
  if (kind === 'range') return <Range w={w} today={today} latest={latest} disabled={disabled} onChange={onChange} />
  return <Steppers kind={kind} w={w} today={today} disabled={disabled} onChange={onChange} />
}

/** Months: a draft while the list is open, one `window` move when it closes changed (lib/draft). */
function Months({ w, thisMonth, disabled, onChange }: { w: Window; thisMonth: string; disabled: boolean; onChange: (w: Window) => void }) {
  const months = useDraft<string[]>([...(w.months ?? [])].sort(), (v) => v.length && onChange({ kind: 'months', months: [...v].sort() }))
  {
    const chosen = months.value
    const first = chosen[0] && chosen[0] < addMonths(thisMonth, -3) ? chosen[0] : addMonths(thisMonth, -3)
    const last = chosen[chosen.length - 1] && chosen[chosen.length - 1] > addMonths(thisMonth, 8) ? chosen[chosen.length - 1] : addMonths(thisMonth, 8)
    const all: string[] = []
    for (let m = first; m <= last && all.length < 36; m = addMonths(m, 1)) all.push(m)
    const quarters = [0, 1, 2, 3].map((qi) => { const ms = all.filter((m) => Math.floor((Number(m.slice(5)) - 1) / 3) === qi); return { value: `q${qi + 1}`, label: `Q${qi + 1}`, values: ms } }).filter((g) => g.values.length)
    return (
      <span className="sa-row sa-row--tight">
        <Icon icon="lucide:calendar-days" className="sa-btn__icon" />
        <MultiSelect variant="chip" label={months.dirty ? 'Months (editing)' : 'Months'} noun={['month', 'months']} value={chosen} disabled={disabled} onChange={months.set} onOpen={months.start} onClose={months.close}
          options={all.map((m) => ({ value: m, label: monthWords(m) }))} groups={quarters} groupsLabel="Quarters" allLabel="The next four months" />
      </span>
    )
  }
}

const isoDay = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d) }
const mondayOf = (s: string) => { const d = new Date(`${s}T00:00:00Z`); const off = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - off); return isoDay(d) }

/** A range of whole days: two dates, each committing on change, and the presets a person reaches for. */
function Range({ w, today, latest, disabled, onChange }: { w: Window; today: string; latest?: string; disabled: boolean; onChange: (w: Window) => void }) {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(today) ? today : new Date().toISOString().slice(0, 10)
  const from = w.from ?? mondayOf(t), through = w.through ?? addDays(mondayOf(t), 6)
  const set = (f: string, th: string, said?: string, compare = w.compare) => { if (/^\d{4}-\d{2}-\d{2}$/.test(f) && /^\d{4}-\d{2}-\d{2}$/.test(th) && f <= th) onChange({ kind: 'range', from: f, through: th, ...(said ? { said } : {}), ...(compare ? { compare: true } : {}) }) }
  const presets: Array<[string, string, string, string?]> = [
    ...(latest && /^\d{4}-\d{2}-\d{2}$/.test(latest) ? [['Last week with entries', mondayOf(latest), addDays(mondayOf(latest), 6), 'the last week with entries'] as [string, string, string, string]] : []),
    ['This week', mondayOf(t), addDays(mondayOf(t), 6)],
    ['Last week', addDays(mondayOf(t), -7), addDays(mondayOf(t), -1)],
    ['This month', `${t.slice(0, 7)}-01`, addDays(`${t.slice(0, 4)}-${pad(Number(t.slice(5, 7)) % 12 + 1)}-01`.replace(/^(\d{4})-01-01$/, (m) => `${Number(m.slice(0, 4)) + (Number(t.slice(5, 7)) === 12 ? 1 : 0)}-01-01`), -1)],
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
      {w.said && <span className="sa-note truncate" style={{ maxWidth: '16rem' }} title={w.said}>· {w.said}</span>}
      {/* The comparison lives with the window: one toggle, commit on choose. */}
      <button type="button" role="switch" aria-checked={!!w.compare} data-on={!!w.compare} disabled={disabled} className="sa-toggle sa-toggle__btn sa-toggle__btn--text" title="Put the same span one period back beside each figure" onClick={() => set(from, through, w.said, !w.compare)}>
        <Icon icon={w.compare ? 'lucide:check' : 'lucide:git-compare-arrows'} className="sa-btn__icon" />vs the period before
      </button>
    </span>
  )
}

/** Weeks, days and the fiscal year: each click is a choice, so each commits at once. */
function Steppers({ kind, w, today, disabled, onChange }: { kind: WindowKind; w: Window; today: string; disabled: boolean; onChange: (w: Window) => void }) {
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
  return <YearStepper year={w.year} disabled={disabled} onChange={(year) => onChange({ kind, year })} />
}

/** The financial year, stepped through the years the organisation's calendar names ("FY 2025-26"), never a number. */
function YearStepper({ year, disabled, onChange }: { year?: string; disabled?: boolean; onChange: (year: string) => void }) {
  const years = useApp().catalog.financialYears
  const i = year ? years.indexOf(year) : -1
  const go = (d: number) => { const next = years[i + d]; if (next) onChange(next) }
  return (
    <span className="sa-row">
      <span className="sa-label">Financial year</span>
      <span className="sa-stepper" role="group" aria-label="Financial year">
        <button type="button" className="sa-icon-btn" disabled={disabled || i <= 0} onClick={() => go(-1)} aria-label="The year before" title="The year before"><Icon icon="lucide:chevron-left" /></button>
        <span className="sa-stepper__value">{year ?? '—'}</span>
        <button type="button" className="sa-icon-btn" disabled={disabled || i < 0 || i >= years.length - 1} onClick={() => go(1)} aria-label="The year after" title="The year after"><Icon icon="lucide:chevron-right" /></button>
      </span>
    </span>
  )
}
