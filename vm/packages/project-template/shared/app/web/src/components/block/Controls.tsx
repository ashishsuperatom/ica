// The block's question, on one quiet line: every filter as a chip (× drops it), the filter-add, the grouping as a
// chip Select, then the window and the assumptions. Each is an app:move that edits the block in place. How a block
// is DRAWN is each card's own hover toggle — never a control here.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
import Select from '@/components/ui/Select'
import { capabilityOf, dimLabel, useApp } from '@/lib/catalog'
import type { Node } from '@/runtime/thread'
import { filterLabel, memberKeys, type Answer, type AssumeValue, type Filter, type Op } from '@/lib/wire'
import WindowControl from './WindowControl'
import FilterAdd from './FilterAdd'

export default function Controls({ block, answer, onEdit }: { block: Node; answer: Answer; onEdit: (ops: Op[]) => void }) {
  const { catalog } = useApp()
  const q = block.question
  const cap = capabilityOf(catalog, q.focus)
  const by = cap?.by ?? []
  // An assumption is a number a what-if turns; anything else a capability declares is not shown here.
  const assume = cap?.assume ?? {}
  const assumeKeys = Object.keys(assume).filter((k) => typeof assume[k] === 'number' || assume[k] === null)
  const busy = block.busy

  return (
    <div className="sa-question" data-copy="skip" aria-label="This block's question">
      {q.where.map((f) => <Chip key={`${f.dim}:${memberKeys(f.value).join('|')}`} f={f} dim={dimLabel(catalog, f.dim)} busy={busy} onEdit={onEdit} />)}
      {cap && <FilterAdd capability={cap} answer={answer} onPush={(op) => onEdit([op])} disabled={busy} />}
      {by.length > 0 && (
        <Select variant="chip" label="By" value={q.by ?? ''} disabled={busy} onChange={(v) => onEdit([v ? { op: 'by', dim: v } : { op: 'by' }])}
          options={by.map((d) => ({ value: d, label: dimLabel(catalog, d) }))} emptyLabel="The whole" placeholder="the whole" />
      )}
      {q.where.length > 1 && <button onClick={() => onEdit([{ op: 'clear' }])} disabled={busy} className="sa-btn sa-btn--link">Clear all</button>}
      {cap?.window && (
        <>
          <span className="sa-divider" aria-hidden />
          <WindowControl kind={cap.window.kind} value={q.window} today={answer.today || catalog.today} latest={answer.used.latest} disabled={busy} onChange={(w) => onEdit([{ op: 'window', window: w }])} />
        </>
      )}
      {assumeKeys.length > 0 && (
        <>
          <span className="sa-divider" aria-hidden />
          <span className="sa-label">Assume</span>
          {assumeKeys.map((k) => <AssumeInput key={k} name={k} fallback={assume[k]} value={answer.used.assumptions[k] ?? q.assume?.[k] ?? null} disabled={busy} onChange={(v) => onEdit([{ op: 'assume', assume: { [k]: v } }])} />)}
        </>
      )}
    </div>
  )
}

/** One filter as a chip: "Status Closed" or "Status is not Closed". The words open a small menu — is / is not / remove —
 * that commits on choose (a flip is one move: pop, then push with the other operator). */
function Chip({ f, dim, busy, onEdit }: { f: Filter; dim: string; busy: boolean; onEdit: (ops: Op[]) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as globalThis.Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  const not = f.op === 'is not'
  const label = filterLabel(f)
  const recorded = memberKeys(f.value).length
  const flip = (toNot: boolean) => { setOpen(false); if (toNot !== not) onEdit([{ op: 'pop', dim: f.dim }, { op: 'push', dim: f.dim, value: f.value, ...(f.label ? { label: f.label } : {}), ...(toNot ? { not: true } : {}) }]) }
  const remove = () => { setOpen(false); onEdit([{ op: 'pop', dim: f.dim }]) }
  return (
    <span ref={box} className={`sa-chip${not ? ' sa-chip--not' : ''}`} title={`${dim} ${f.op} ${label}${recorded > 1 ? ` (recorded ${recorded} times)` : ''}`}>
      <button type="button" className="sa-chip__btn" aria-haspopup="menu" aria-expanded={open} disabled={busy} onClick={() => setOpen(!open)}>
        <span className="sa-chip__dim">{dim}{not ? ' is not' : ''}</span>
        <span className="sa-chip__text truncate">{label}</span>
      </button>
      <button className="sa-icon-btn sa-icon-btn--sm" aria-label={`Drop ${dim}`} onClick={remove} disabled={busy}><Icon icon="lucide:x" /></button>
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

/** One numeric assumption: a small field labelled by what it means, with its default as the placeholder; committed
 * on Enter or blur when it changed — emptied, it drops the assumption back to the default. */
function AssumeInput({ name, fallback, value, disabled, onChange }: { name: string; fallback: AssumeValue; value: AssumeValue; disabled: boolean; onChange: (v: AssumeValue) => void }) {
  const numeric = true
  const shown = value === null || value === undefined ? '' : String(value)
  const [text, setText] = useState(shown)
  useEffect(() => setText(shown), [shown])
  const commit = () => {
    if (text === shown) return
    if (text.trim() === '') return onChange(null)
    if (numeric) { const n = Number(text); if (Number.isFinite(n)) onChange(n); else setText(shown) }
    else onChange(text)
  }
  return (
    <label className="sa-field" title={`${name} (default ${fallback === null ? 'not set' : String(fallback)})`}>
      <span className="sa-field__label">{name}</span>
      <input className={`sa-input sa-input--sm ${numeric ? 'sa-input--num' : 'sa-input--text'}`} type="number" step="any" value={text} placeholder={fallback === null ? '—' : String(fallback)} disabled={disabled}
        onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </label>
  )
}
