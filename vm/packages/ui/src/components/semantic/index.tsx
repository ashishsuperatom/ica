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

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { Pager } from '../ui/Section'

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

/** A value typed in: text or a number, inside a Field (its label) or a toolbar. Empty is null for a number, so a cleared
 *  field says "not given" rather than 0. */
export function Input({ id, value, onChange, kind = 'text', placeholder, label, disabled, compact }: {
  id: string; value: string | number | null; onChange: (v: string) => void; kind?: 'text' | 'number'
  placeholder?: string; /** Said to assistive tech when no Field labels it. */ label?: string; disabled?: boolean; compact?: boolean
}) {
  return (
    <input id={id} className={`sa-input${compact ? ' sa-input--sm' : ''}${kind === 'number' ? ' sa-input--num' : ''}`} type={kind === 'number' ? 'number' : 'text'} step={kind === 'number' ? 'any' : undefined}
      value={value ?? ''} placeholder={placeholder} aria-label={label} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
  )
}

/** One field a connector asks for (its manifest's): a setting, or a secret — typed once, sealed, never shown again. */
export interface FormField { name: string; label: string; type: 'text' | 'secret' | 'number' | 'url' | 'select' | 'textarea'; required?: boolean; options?: string[]; help?: string; placeholder?: string; when?: Record<string, string>; default?: string }
/** The form a connector asks for, made from its fields: a field asked only when another has a value (`when`) shows only
 *  then; a secret is a password input, and — when one is kept already (`kept`) — left empty keeps it. */
export function ConnectorFields({ fields, values, onChange, kept = [], idPrefix = 'cf' }: {
  fields: FormField[]; values: Record<string, string>; onChange: (v: Record<string, string>) => void; /** secrets kept already */ kept?: string[]; idPrefix?: string
}) {
  // asked only when another is asked and has its value (a chain: storage → its key)
  const asked = new Set<string>()
  for (let changed = true; changed;) { changed = false; for (const f of fields) if (!asked.has(f.name) && Object.entries(f.when ?? {}).every(([k, want]) => (asked.has(k) || !fields.some((x) => x.name === k)) && (values[k] ?? '') === want)) { asked.add(f.name); changed = true } }
  const shown = fields.filter((f) => asked.has(f.name))
  const set = (name: string, v: string) => onChange({ ...values, [name]: v })
  return (<>
    {shown.map((f) => {
      const id = `${idPrefix}-${f.name}`, keptOne = f.type === 'secret' && kept.includes(f.name)
      const help = [f.help, keptOne ? 'One is kept — leave empty to keep it.' : f.type === 'secret' ? 'Sealed once sent; never shown again.' : ''].filter(Boolean).join(' ')
      return (
        <Field key={f.name} label={`${f.label}${f.required && !keptOne ? ' *' : ''}`} help={help || undefined}>
          {f.type === 'select'
            ? <select id={id} className="sa-input" value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}><option value="" />{f.options?.map((o) => <option key={o}>{o}</option>)}</select>
            : f.type === 'textarea' || (f.type === 'secret' && /key|certificate|pem/i.test(f.label))
              ? <textarea id={id} className="sa-input" rows={4} value={values[f.name] ?? ''} placeholder={keptOne ? '•••• kept' : f.placeholder} onChange={(e) => set(f.name, e.target.value)} />
              : <input id={id} className="sa-input" type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'} autoComplete={f.type === 'secret' ? 'new-password' : 'off'}
                  placeholder={keptOne ? '•••• kept' : f.placeholder} value={values[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} />}
        </Field>
      )
    })}
  </>)
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

/**
 * Checkboxes in named groups, for picking a set (capabilities, scopes). Each group's head ticks or clears the whole
 * group; `presets` (roles, defaults) set the whole value in one click and show which one it matches now.
 */
export interface CheckGroup { key: string; label: string; items: { key: string; label: ReactNode; hint?: string; disabled?: boolean; title?: string }[] }
export function CheckGroups({ label, groups, value, onChange, presets }: {
  label: string; groups: CheckGroup[]; value: string[]; onChange: (v: string[]) => void
  presets?: { key: string; label: string; value: string[] }[]
}) {
  const on = new Set(value)
  const same = (v: string[]) => v.length === on.size && v.every((k) => on.has(k))
  const current = presets?.find((p) => same(p.value))
  const every = groups.flatMap((g) => g.items.filter((i) => !i.disabled).map((i) => i.key))
  return (
    <div className="sa-field-row sa-checkgroups" role="group" aria-label={label}>
      <div className="sa-checkgroups__top">
        <span className="sa-field-row__label">{label}</span>
        <span className="sa-toggle" role="radiogroup" aria-label="Start from">
          {(presets ?? []).map((p) => <button key={p.key} type="button" role="radio" aria-checked={current?.key === p.key} className="sa-toggle__btn" onClick={() => onChange([...p.value])}>{p.label}</button>)}
          {/* everything that may be ticked (what one does not hold stays unticked) */}
          <button type="button" role="radio" aria-checked={!current && every.length > 0 && same(every)} className="sa-toggle__btn" disabled={!every.length} onClick={() => onChange(every)}>All</button>
          <button type="button" role="radio" aria-checked={!current && !!on.size && !same(every)} className="sa-toggle__btn" disabled={!on.size} onClick={() => onChange([])}>{!current && on.size && !same(every) ? 'Custom · clear' : 'Clear'}</button>
        </span>
      </div>
      <div className="sa-checkgroups__grid">
        {groups.map((g) => {
          const open = g.items.filter((i) => !i.disabled)
          const n = g.items.filter((i) => on.has(i.key)).length
          const all = !!open.length && open.every((i) => on.has(i.key))
          return (
            <fieldset key={g.key} className="sa-checkgroup">
              <legend className="sa-checkgroup__head">
                <label>
                  <input type="checkbox" checked={all} disabled={!open.length} ref={(el) => { if (el) el.indeterminate = n > 0 && !all }}
                    onChange={() => onChange(all ? value.filter((k) => !open.some((i) => i.key === k)) : [...new Set([...value, ...open.map((i) => i.key)])])} />
                  <span>{g.label}</span>
                </label>
                <span className="sa-faint">{n} of {g.items.length}</span>
              </legend>
              {g.items.map((i) => (
                <label key={i.key} className="sa-checkgroup__item" title={i.title} data-disabled={!!i.disabled}>
                  <input type="checkbox" disabled={i.disabled} checked={on.has(i.key)} onChange={(e) => onChange(e.target.checked ? [...value, i.key] : value.filter((k) => k !== i.key))} />
                  <span>{i.label}{i.hint && <span className="sa-checkgroup__hint">{i.hint}</span>}</span>
                </label>
              ))}
            </fieldset>
          )
        })}
      </div>
    </div>
  )
}

export function Receipt({ items }: { items: [string, ReactNode][] }) {
  return <dl className="sa-receipt">{items.map(([k, v]) => <div key={k} className="sa-receipt__row"><dt>{k}</dt><dd>{v === '—' || v === '' || v == null ? <span className="sa-faint">—</span> : v}</dd></div>)}</dl>
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
  /** What a record is found by (its words), or true for the words of its own plain fields; a search box is drawn above. */
  search?: ((r: R) => string) | true
  searchLabel?: string
  /** At most this many at a time, with a pager. */
  pageSize?: number
}) {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const loading = busy || given == null
  const rows = given ?? []
  const wordsOf = search === true ? (r: R) => Object.values(r).filter((v) => typeof v === 'string' || typeof v === 'number').join(' ') : search
  const found = wordsOf && q.trim() ? rows.filter((r) => wordsOf(r).toLowerCase().includes(q.trim().toLowerCase())) : rows
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
        <Pager page={at} pageSize={pageSize} total={found.length} onPage={setPage} />
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

export function Empty({ icon = 'lucide:circle-dashed', children, hint, height }: {
  icon?: string; children: ReactNode
  /** What would put something here, when a reader could do it themselves. */
  hint?: ReactNode
  /** In place of a chart: centred in the space the chart would have taken, so the card keeps its size when figures arrive. */
  height?: number
}) {
  if (height === undefined) return <p className="sa-empty-line"><Icon icon={icon} /> <span>{children}</span>{hint && <span className="sa-muted">· {hint}</span>}</p>
  return (
    <div className="sa-empty" style={{ minHeight: height }}>
      <span className="sa-empty__mark" aria-hidden><Icon icon={icon} /></span>
      <span className="sa-empty__text">{children}</span>
      {hint && <span className="sa-empty__hint">{hint}</span>}
    </div>
  )
}

/** Something being read: the same line as Empty, so the words that replace it never move the page. */
export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return <p className="sa-empty-line" role="status" aria-busy="true"><span className="sa-spinner" /> <span>{children}</span></p>
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
export function Dialog({ title, children, actions, onClose, wide }: { title: ReactNode; children: ReactNode; actions?: ReactNode; onClose: () => void; /** For a table of rows: as wide as the window allows. */ wide?: boolean }) {
  return (
    <div className="sa-dialog" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className={wide ? 'sa-dialog__box sa-dialog__box--wide' : 'sa-dialog__box'} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <h2 className="sa-dialog__title">{title}</h2>
        <div className="sa-dialog__body">{children}</div>
        {actions && <div className="sa-dialog__actions">{actions}</div>}
      </div>
    </div>
  )
}

/** What a confirmation asks: the question as its title, what follows from it, and the words of the button that does it. */
export interface Confirmation { title: string; body?: ReactNode; confirm: string; danger?: boolean }

/** Asking before doing something that cannot simply be taken back, in the kit's own dialog (never the browser's):
 *  `const [confirm, dialog] = useConfirm()` — render `dialog` once, then `if (await confirm({...})) …`. */
export function useConfirm(): [(c: Confirmation) => Promise<boolean>, ReactNode] {
  const [asked, setAsked] = useState<(Confirmation & { answer: (yes: boolean) => void }) | null>(null)
  const confirm = useCallback((c: Confirmation) => new Promise<boolean>((resolve) => setAsked({ ...c, answer: (yes) => { setAsked(null); resolve(yes) } })), [])
  const dialog = asked && (
    <Dialog title={asked.title} onClose={() => asked.answer(false)} actions={<>
      <button type="button" className="sa-btn" onClick={() => asked.answer(false)}>Cancel</button>
      <button type="button" className={asked.danger ? 'sa-btn sa-btn--danger' : 'sa-btn sa-btn--primary'} autoFocus onClick={() => asked.answer(true)}>{asked.confirm}</button>
    </>}>{asked.body}</Dialog>
  )
  return [confirm, dialog]
}

/** Copies a text, says it did for two seconds — or, where there is no clipboard, says to select it and copy by hand. */
export function CopyButton({ text, label = 'Copy', className = 'sa-btn' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(t)
  }, [state])
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard in this context')
      await navigator.clipboard.writeText(text)
      setState('done')
    } catch { setState('failed') }
  }
  return (
    <button type="button" className={className} onClick={copy} title={state === 'failed' ? 'Select the text and press ⌘C' : undefined}>
      <Icon icon={state === 'done' ? 'lucide:check' : state === 'failed' ? 'lucide:text-select' : 'lucide:copy'} className="sa-btn__icon" />
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Select it and ⌘C' : label}
    </button>
  )
}
