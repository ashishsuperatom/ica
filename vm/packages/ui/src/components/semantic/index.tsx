// THE SEMANTIC COMPONENTS — named for what they are, not how they look. A screen composes these and writes no CSS of its
// own; each owns its styles (design/semantic.css) on the tokens, so a theme is a handful of token overrides.
//
//   Form, Field, Choices   a form in a block: fields stacked, its actions at the foot; a sent form locks (it became a record)
//   Receipt                what a sent form, a decision or a change became: its facts as pairs
//   RecordList             records in rows: columns declared once, a row may open the next step
//   Status                 the state of a thing in one word: ok · attention · critical · running · neutral
//   AttentionList          what needs a decision, worst first: each opens its step
//   ActionBar              the paths at the end of a block
//   Empty                  nothing here yet, said plainly, with what will appear

import type { FormEvent, ReactNode } from 'react'
import { Icon } from '@iconify/react'

export type State = 'ok' | 'attention' | 'critical' | 'running' | 'neutral'

export function Form({ onSubmit, locked = false, error, actions, children }: { onSubmit: () => void; locked?: boolean; error?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <form className="sa-form" data-locked={locked} onSubmit={(e: FormEvent) => { e.preventDefault(); if (!locked) onSubmit() }}>
      <fieldset className="sa-form__fields" disabled={locked}>{children}</fieldset>
      {error && <p className="sa-form__error" role="alert">{error}</p>}
      {!locked && actions && <div className="sa-form__actions">{actions}</div>}
    </form>
  )
}

export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <label className="sa-field-row">
      <span className="sa-field-row__label">{label}</span>
      {children}
      {help && <span className="sa-field-row__help">{help}</span>}
    </label>
  )
}

/** Several choices, each a checkbox or radio: given as children. */
export function Choices({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="sa-field-row" role="group" aria-label={label}>
      <span className="sa-field-row__label">{label}</span>
      <div className="sa-choices">{children}</div>
      {help && <span className="sa-field-row__help">{help}</span>}
    </div>
  )
}

export function Receipt({ items }: { items: [string, ReactNode][] }) {
  return <dl className="sa-receipt">{items.map(([k, v]) => <div key={k} className="sa-receipt__row"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
}

export interface Column<R> { key: string; label: string; align?: 'start' | 'end'; render?: (row: R) => ReactNode; wrap?: boolean }
export function RecordList<R extends Record<string, any>>({ columns, rows, keyOf, onRow, empty }: { columns: Column<R>[]; rows: R[]; keyOf: (r: R) => string; onRow?: (r: R) => void; empty?: ReactNode }) {
  if (!rows.length) return <Empty>{empty ?? 'Nothing here yet.'}</Empty>
  return (
    <div className="sa-records">
      <table className="sa-records__table">
        <thead><tr>{columns.map((c) => <th key={c.key} data-align={c.align ?? 'start'}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={keyOf(r)} data-opens={!!onRow} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined}
            onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(r) } : undefined}>
            {columns.map((c) => <td key={c.key} data-align={c.align ?? 'start'} data-wrap={!!c.wrap}>{c.render ? c.render(r) : String(r[c.key] ?? '—')}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  )
}

export function Status({ state, children }: { state: State; children: ReactNode }) {
  return <span className="sa-status-word" data-state={state}>{children}</span>
}

export interface Attention { id: string; state: Exclude<State, 'neutral'>; title: string; detail?: string; where?: string; action?: string }
export function AttentionList<T extends Attention>({ items, onOpen, empty }: { items: T[]; onOpen: (a: T) => void; empty?: ReactNode }) {
  if (!items.length) return <Empty icon="lucide:check-circle-2">{empty ?? 'Nothing needs a decision.'}</Empty>
  const order: Record<string, number> = { critical: 0, attention: 1, running: 2, ok: 3 }
  return (
    <ul className="sa-attention">
      {[...items].sort((a, b) => order[a.state] - order[b.state]).map((a) => (
        <li key={a.id} className="sa-attention__item" data-state={a.state}>
          <button className="sa-attention__main" onClick={() => onOpen(a)}>
            <span className="sa-attention__title">{a.title}</span>
            {a.detail && <span className="sa-attention__detail">{a.detail}</span>}
          </button>
          {a.where && <span className="sa-attention__where">{a.where}</span>}
          <span className="sa-attention__action">{a.action ?? 'Open'} <Icon icon="lucide:arrow-right" /></span>
        </li>
      ))}
    </ul>
  )
}

export function ActionBar({ children }: { children: ReactNode }) { return <div className="sa-actionbar">{children}</div> }

export function Empty({ icon = 'lucide:circle-dashed', children }: { icon?: string; children: ReactNode }) {
  return <p className="sa-empty"><Icon icon={icon} /> <span>{children}</span></p>
}
