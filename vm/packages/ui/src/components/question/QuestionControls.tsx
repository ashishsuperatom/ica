// A QUESTION'S CONTROLS — the one way a view's question is edited, on every surface (a dashboard, a program's view in a
// session): every filter as a chip (is / is not / remove), adding a filter (the dimension, then its member — searched
// as a person types when the views can give members), the breakdown, the window and the assumptions, on one quiet line.
// Each control is one move (ops) on the question; what a move does is the caller's (edit in place, branch).
//
// What the controls offer comes from the views' description (a catalog: dimensions, capabilities, financial years);
// nothing here knows a dataset.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import Select from '../ui/Select'
import WindowControl from './WindowControl'

export type QuestionOp = Record<string, unknown>
export interface QuestionCatalog { financialYears?: string[]; dimensions: any[]; capabilities: any[]; today?: string }
export interface QuestionMember { key: string; keys?: string[]; label: string; recorded?: number }

const dimensionOf = (c: QuestionCatalog, key: string) => c.dimensions.find((x: any) => x.key === key)
const dimLabel = (c: QuestionCatalog, key: string): string => dimensionOf(c, key)?.label ?? key
/** A filter's value: one key, or every key one label is recorded under. */
export const memberKeys = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v === null || v === undefined ? [] : [String(v)])
const filterLabel = (f: any): string => String(f.label ?? memberKeys(f.value).join(', '))

export default function QuestionControls({ catalog, question: q, used = {}, today, seen = {}, members, disabled, onEdit }: {
  catalog: QuestionCatalog
  /** The question: what it looks at (focus), its filters (where), its breakdown (by), its window, its assumptions. */
  question: any
  /** What the answer used (its window, span, assumptions, the latest day with rows). */
  used?: any
  today?: string
  /** The values each column of the answer's tables takes (an attribute filter offers them). */
  seen?: Record<string, string[]>
  /** The members a dimension takes for what is typed, when the views can say. */
  members?: (dim: string, typed: string) => Promise<QuestionMember[]>
  disabled?: boolean
  onEdit: (ops: QuestionOp[]) => void
}) {
  const cap = q ? catalog.capabilities.find((x: any) => x.focus === q.focus) : undefined
  if (!q || !cap) return null
  const where: any[] = Array.isArray(q.where) ? q.where : []
  const by: string[] = cap.by ?? []
  const assume = cap.assume ?? {}
  const assumeKeys = Object.keys(assume).filter((k) => typeof assume[k] === 'number' || assume[k] === null)
  return (
    <div className="sa-question" data-copy="skip" aria-label="This question's controls">
      {where.map((f) => <Chip key={`${f.dim}:${memberKeys(f.value).join('|')}`} f={f} dim={dimLabel(catalog, f.dim)} disabled={disabled} onEdit={onEdit} />)}
      <FilterAdd catalog={catalog} honours={cap.honours ?? []} seen={seen} members={members} disabled={disabled} onPush={(op) => onEdit([op])} />
      {by.length > 0 && (
        <Select variant="chip" label="By" value={q.by ?? ''} disabled={disabled} onChange={(v: string) => onEdit([v ? { op: 'by', dim: v } : { op: 'by' }])}
          options={by.map((d) => ({ value: d, label: dimLabel(catalog, d) }))} emptyLabel="The whole" placeholder="the whole" />
      )}
      {where.length > 1 && <button onClick={() => onEdit([{ op: 'clear' }])} disabled={disabled} className="sa-btn sa-btn--link">Clear all</button>}
      {cap.window && (<>
        <span className="sa-divider" aria-hidden />
        <WindowControl kind={cap.window.kind} value={q.window} today={today || catalog.today || ''} latest={used.latest} years={catalog.financialYears ?? []} disabled={disabled} onChange={(w) => onEdit([{ op: 'window', window: w }])} />
      </>)}
      {assumeKeys.length > 0 && (<>
        <span className="sa-divider" aria-hidden />
        <span className="sa-label">Assume</span>
        {assumeKeys.map((k) => <AssumeInput key={k} name={k} fallback={assume[k]} value={used.assumptions?.[k] ?? q.assume?.[k] ?? null} disabled={disabled} onChange={(v) => onEdit([{ op: 'assume', assume: { [k]: v } }])} />)}
      </>)}
    </div>
  )
}

function Chip({ f, dim, disabled, onEdit }: { f: any; dim: string; disabled?: boolean; onEdit: (ops: QuestionOp[]) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const not = f.op === 'is not'
  const label = filterLabel(f)
  const flip = (toNot: boolean) => { setOpen(false); if (toNot !== not) onEdit([{ op: 'pop', dim: f.dim }, { op: 'push', dim: f.dim, value: f.value, ...(f.label ? { label: f.label } : {}), ...(toNot ? { not: true } : {}) }]) }
  const remove = () => { setOpen(false); onEdit([{ op: 'pop', dim: f.dim }]) }
  return (
    <span ref={box} className={`sa-chip${not ? ' sa-chip--not' : ''}`} title={`${dim} ${not ? 'is not' : 'is'} ${label}`}>
      <button type="button" className="sa-chip__btn" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>
        <span className="sa-chip__dim">{dim}{not ? ' is not' : ''}</span>
        <span className="sa-chip__text truncate">{label}</span>
      </button>
      <button className="sa-icon-btn sa-icon-btn--sm" aria-label={`Drop ${dim}`} onClick={remove} disabled={disabled}><Icon icon="lucide:x" /></button>
      {open && (
        <span role="menu" className="sa-dropdown" aria-label={`${dim} ${label}`}>
          <button type="button" role="menuitemradio" aria-checked={!not} className="sa-dropdown__item" onClick={() => flip(false)}><Icon icon={not ? 'lucide:circle' : 'lucide:check'} />is</button>
          <button type="button" role="menuitemradio" aria-checked={not} className="sa-dropdown__item" onClick={() => flip(true)}><Icon icon={not ? 'lucide:check' : 'lucide:circle'} />is not</button>
          <button type="button" role="menuitem" className="sa-dropdown__item sa-dropdown__item--danger" onClick={remove}><Icon icon="lucide:x" />remove</button>
        </span>
      )}
    </span>
  )
}

function OpToggle({ not, onChange }: { not: boolean; onChange: (not: boolean) => void }) {
  return (
    <span className="sa-toggle" role="radiogroup" aria-label="Include or exclude">
      <button type="button" role="radio" aria-checked={!not} data-on={!not} className="sa-toggle__btn sa-toggle__btn--text" onClick={() => onChange(false)}>is</button>
      <button type="button" role="radio" aria-checked={not} data-on={not} className="sa-toggle__btn sa-toggle__btn--text" onClick={() => onChange(true)}>is not</button>
    </span>
  )
}

const memberCache = new Map<string, QuestionMember[]>()

function FilterAdd({ catalog, honours, seen, members, disabled, onPush }: { catalog: QuestionCatalog; honours: string[]; seen: Record<string, string[]>; members?: (dim: string, typed: string) => Promise<QuestionMember[]>; disabled?: boolean; onPush: (op: QuestionOp) => void }) {
  const [dim, setDim] = useState('')
  const [not, setNot] = useState(false)
  const [matches, setMatches] = useState<Array<{ value: string; label: string; member: QuestionMember; note?: string }>>([])
  const [loading, setLoading] = useState(false)
  const d = dim ? dimensionOf(catalog, dim) : undefined
  const asks = !!d && !!members && (d.kind === 'entity' || !!d.searchable)
  // One option per label; its value carries every key the label is recorded under.
  const options = (ms: QuestionMember[]) => {
    const byId = new Map<string, QuestionMember>()
    for (const m of ms) { const id = (m.keys ?? [m.key]).join('\u0000'); if (!byId.has(id)) byId.set(id, m) }
    return [...byId.entries()].map(([id, m]) => ({ value: id, label: m.label, member: m, ...(m.recorded && m.recorded > 1 ? { note: `recorded ${m.recorded} times` } : {}) }))
  }
  const query = (typed: string) => {
    if (!d || !asks) return
    const k = `${d.key}\u0000${typed}`
    const had = memberCache.get(k)
    if (had) setMatches(options(had))
    setLoading(!had)
    members!(d.key, typed).then((ms) => { memberCache.set(k, ms); setMatches(options(ms)); setLoading(false) }, () => { if (!had) setMatches([]); setLoading(false) })
  }
  useEffect(() => { setMatches([]); if (asks) query('') }, [dim])   // eslint-disable-line react-hooks/exhaustive-deps
  const values = d ? (seen[d.key] ?? []) : []
  const opts: Array<{ value: string; label: string; note?: string }> = !d ? [] : d.kind === 'flag' ? [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]
    : [...matches, ...values.filter((v) => !matches.some((m) => m.label === v)).map((v) => ({ value: v, label: v }))]
  const choose = (v: string) => {
    if (!v) return
    const m = matches.find((o) => o.value === v)?.member
    onPush(m ? { op: 'push', dim, value: m.key, label: m.label, ...(not ? { not: true } : {}) } : { op: 'push', dim, value: v, label: opts.find((o) => o.value === v)?.label ?? v, ...(not ? { not: true } : {}) })
    setDim('')
  }
  return (
    <span className="sa-row sa-row--tight">
      <Select variant="chip" label="Filter" value={dim} disabled={disabled || !honours.length} onChange={setDim}
        options={honours.filter((k) => !dimensionOf(catalog, k)?.byOnly).map((k) => { const x = dimensionOf(catalog, k); return { value: k, label: x?.label ?? k, note: x?.means } })}
        placeholder="add" lead={<Icon icon="lucide:filter" />} />
      {d && (
        <Select key={d.key} autoOpen variant="chip" label={not ? `${d.label} is not` : d.label} value="" onChange={choose} options={opts}
          head={<OpToggle not={not} onChange={setNot} />}
          placeholder={d.kind === 'flag' ? 'Yes or No' : `a ${String(d.label).toLowerCase()}`} allowCustom={d.kind === 'attribute'} onQuery={asks ? query : undefined} loading={loading} />
      )}
    </span>
  )
}

function AssumeInput({ name, fallback, value, disabled, onChange }: { name: string; fallback: unknown; value: unknown; disabled?: boolean; onChange: (v: number | null) => void }) {
  const shown = value === null || value === undefined ? '' : String(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    if (text === shown) return
    if (text.trim() === '') return onChange(null)
    const n = Number(text); if (Number.isFinite(n)) onChange(n); else setText(shown)
  }
  return (
    <label className="sa-field" title={`${name} (default ${fallback === null ? 'not set' : String(fallback)})`}>
      <span className="sa-field__label">{name}</span>
      <input className="sa-input sa-input--sm sa-input--num" type="number" step="any" value={text} placeholder={fallback === null ? '—' : String(fallback)} disabled={disabled}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </label>
  )
}
