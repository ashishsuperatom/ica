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
//   PageHeader             a screen's name, one line on what it is for, and its actions
//   Tabs                   the parts of one thing, one shown at a time
//   Notice                 a sentence the person should read: a note, a warning, a failure
//   Code                   a value to be read exactly (an id, a key's prefix, a command)
//   Figures                a row of headline figures (each a Kpi)
//   Toolbar                the controls above a list: search, filters, the action that adds one
//   Dialog                 a question that needs an answer first, over the page

import { useState, type FormEvent, type ReactNode } from 'react'
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
/**
 * Records in rows. It never jumps: while `loading` (or while `rows` is still null — not yet read) it draws rows of the
 * size the records will have, never "nothing here" that then fills in; with `pageSize` it
 * shows that many at a time with a pager (a page never grows); with `search` it finds among all of them, whatever page.
 */
export function RecordList<R extends Record<string, any>>({ columns, rows: given, keyOf, onRow, empty, loading: busy = false, loadingRows, search, searchLabel = 'Find…', pageSize }: {
  columns: Column<R>[]; rows: R[] | null | undefined; keyOf: (r: R) => string; onRow?: (r: R) => void; empty?: ReactNode
  /** The records are on their way: rows of their size are drawn instead. */
  loading?: boolean
  loadingRows?: number
  /** What a record is found by (its words); a search box is drawn above. */
  search?: (r: R) => string
  searchLabel?: string
  /** At most this many at a time, with a pager. */
  pageSize?: number
}) {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const loading = busy || given == null
  const rows = given ?? []
  const found = search && q.trim() ? rows.filter((r) => search(r).toLowerCase().includes(q.trim().toLowerCase())) : rows
  const pages = pageSize ? Math.max(1, Math.ceil(found.length / pageSize)) : 1
  const at = Math.min(page, pages - 1)
  const shown = pageSize ? found.slice(at * pageSize, at * pageSize + pageSize) : found
  const head = search && (rows.length > 0 || loading) && (
    <div className="sa-records__find"><Icon icon="lucide:search" /><input className="sa-records__input" placeholder={searchLabel} value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} aria-label={searchLabel} /></div>
  )
  if (!loading && !rows.length) return <Empty>{empty ?? 'Nothing here yet.'}</Empty>
  return (
    <div className="sa-records">
      {head}
      <table className="sa-records__table">
        <thead><tr>{columns.map((c) => <th key={c.key} data-align={c.align ?? 'start'}>{c.label}</th>)}</tr></thead>
        <tbody>{loading
          ? Array.from({ length: loadingRows ?? pageSize ?? 4 }, (_, i) => (
              <tr key={`loading-${i}`} aria-hidden>{columns.map((c, j) => <td key={c.key}><span className="sa-skeleton sa-skeleton--inline" style={{ width: j === 0 ? '60%' : '40%', height: 12 }} /></td>)}</tr>))
          : shown.map((r) => (
              <tr key={keyOf(r)} data-opens={!!onRow} onClick={onRow ? () => onRow(r) : undefined} tabIndex={onRow ? 0 : undefined}
                onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(r) } : undefined}>
                {columns.map((c) => <td key={c.key} data-align={c.align ?? 'start'} data-wrap={!!c.wrap}>{c.render ? c.render(r) : String(r[c.key] ?? '—')}</td>)}
              </tr>))}
          {!loading && !shown.length && <tr><td colSpan={columns.length} className="sa-records__none">Nothing matches “{q}”.</td></tr>}
        </tbody>
      </table>
      {pageSize && !loading && found.length > pageSize && (
        <div className="sa-pager" data-copy="skip">
          <span className="sa-pager__count">{`${at * pageSize + 1}–${Math.min(found.length, at * pageSize + pageSize)} of ${found.length}`}</span>
          <div className="sa-pager__nav">
            <button className="sa-btn" disabled={at === 0} onClick={() => setPage(at - 1)}><Icon icon="lucide:chevron-left" className="sa-btn__icon" />Previous</button>
            <span className="sa-pager__page">{at + 1} / {pages}</span>
            <button className="sa-btn" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next<Icon icon="lucide:chevron-right" className="sa-btn__icon" /></button>
          </div>
        </div>
      )}
    </div>
  )
}

/** A chart's place while its numbers are on their way: a shimmer as tall as the chart will be (`height`: the chart's
 *  own, its legend and axis included). Loaded, the chart takes the height it needs — the frame never clips it. */
export function ChartFrame({ loading = false, height = 240, children }: { loading?: boolean; height?: number; children: ReactNode }) {
  return <div className="sa-chartframe" style={{ minHeight: height }}>{loading ? <span className="sa-skeleton" style={{ width: '100%', height }} aria-label="Loading" /> : children}</div>
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
  return <p className="sa-empty-line"><Icon icon={icon} /> <span>{children}</span></p>
}

/** A screen's name, one line on what it is for, and its actions at the end. */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="sa-pagehead">
      <div className="sa-pagehead__words"><h1 className="sa-pagehead__title">{title}</h1>{subtitle && <p className="sa-pagehead__subtitle">{subtitle}</p>}</div>
      {actions && <div className="sa-pagehead__actions">{actions}</div>}
    </header>
  )
}

/** The parts of one thing, one shown at a time; each tab may carry a count. */
export function Tabs<K extends string>({ items, value, onChange, label = 'Parts' }: { items: { key: K; label: string; count?: number; icon?: string }[]; value: K; onChange: (k: K) => void; label?: string }) {
  return (
    <div className="sa-tabs" role="tablist" aria-label={label}>
      {items.map((t) => (
        <button key={t.key} role="tab" type="button" aria-selected={t.key === value} className="sa-tabs__tab" onClick={() => onChange(t.key)}>
          {t.icon && <Icon icon={t.icon} />}{t.label}{t.count !== undefined && <span className="sa-tabs__count">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

/** A sentence the person should read: a note, a warning or a failure, with what to do about it. */
export function Notice({ state = 'neutral', children, action }: { state?: 'neutral' | 'attention' | 'critical' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const icon = state === 'critical' ? 'lucide:octagon-alert' : state === 'attention' ? 'lucide:triangle-alert' : state === 'ok' ? 'lucide:circle-check' : 'lucide:info'
  return <div className="sa-notice" data-state={state} role={state === 'critical' ? 'alert' : 'status'}><Icon icon={icon} /><div className="sa-notice__text">{children}</div>{action}</div>
}

/** A value to be read exactly: an id, a key's prefix, a command. */
export function Code({ children, title }: { children: ReactNode; title?: string }) { return <code className="sa-code" title={title}>{children}</code> }

/** A row of headline figures: give it Kpi children. */
export function Figures({ children }: { children: ReactNode }) { return <div className="sa-kpi-grid sa-figures" data-card="figures">{children}</div> }

/** The controls above a list: search, filters, and the action that adds one (at the end). */
export function Toolbar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return <div className="sa-toolbar">{children}{end && <div className="sa-toolbar__end">{end}</div>}</div>
}

/** A question that needs an answer before anything else: over the page, closed by its own buttons, Escape, or a
 *  click outside. Its actions sit at the foot (the one that changes something, last). */
export function Dialog({ title, children, actions, onClose }: { title: ReactNode; children: ReactNode; actions?: ReactNode; onClose: () => void }) {
  return (
    <div className="sa-dialog" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="sa-dialog__box" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <h2 className="sa-dialog__title">{title}</h2>
        <div className="sa-dialog__body">{children}</div>
        {actions && <div className="sa-dialog__actions">{actions}</div>}
      </div>
    </div>
  )
}
