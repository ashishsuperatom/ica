// WHERE THE DATA COMES FROM — two semantic components for a project's data sources (design/semantic.css).
//
//   SourceHub    the project at the centre and every source branching out to it: what each is, how big, how its index
//                stands. Plain HTML; the branches are one SVG drawn to the same row geometry as the cards (no measuring,
//                nothing moves once drawn). It sits on a canvas that scrolls both ways: a card chosen opens what it is
//                given (children) right beside the card, outward, on the same canvas — the overview never changes.
//                On a phone it stacks.
//   SourceExplorer  one source to look through, read only: its tables in a column, a table chosen opens its fields in the
//                next. What is picked is told (onPick) — the place to work on it is elsewhere.
//   SourceTree   one source opened as a tree, revealed a step at a time: its tables folded (searched by table or field,
//                a hundred at a time), a table opening to its fields; the chosen table or field described on the right —
//                its type, key, what it references, the three descriptions (whose is used), and whether it is offered to
//                the agents (enabled) or no longer in the source (gone). `focus` opens and shows a table or field picked
//                elsewhere (the explorer).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import SuperatomMark from '../layout/SuperatomMark'
import { Status, type State } from './index'

export interface HubSource { key: string; title: string; kind?: string; meta?: string; count?: string; state: State; stateLabel: string }

const ROW = 92   // one card's row, in px (the same number the branches are drawn to)

export function SourceHub({ centre, sources, selected, onSelect, empty, children }: {
  centre: { title: string; subtitle?: string }
  sources: HubSource[]
  selected?: string | null
  onSelect: (key: string) => void
  empty?: ReactNode
  /** What the chosen card opens, placed beside it on the canvas. */
  children?: ReactNode
}) {
  const canvas = useRef<HTMLDivElement>(null), beside = useRef<HTMLDivElement>(null)
  const left = sources.filter((_, i) => i % 2 === 0), right = sources.filter((_, i) => i % 2 === 1)
  const rows = Math.max(left.length, right.length, 2)
  const h = rows * ROW
  const yOf = (n: number, i: number) => (h - n * ROW) / 2 + i * ROW + ROW / 2
  // x in a 1000-wide box stretched to the page: the card columns end at 30% and start at 70%; the centre spans 42–58%.
  const curve = (side: 'l' | 'r', y: number) => {
    const x0 = side === 'l' ? 300 : 700, x1 = side === 'l' ? 420 : 580, mid = (x0 + x1) / 2
    return `M ${x0} ${y} C ${mid} ${y}, ${mid} ${h / 2}, ${x1} ${h / 2}`
  }
  const card = (s: HubSource) => (
    <button key={s.key} type="button" className="sa-hub__source" data-state={s.state} aria-pressed={selected === s.key} onClick={() => onSelect(s.key)} style={{ height: ROW - 16 }}>
      <span className="sa-hub__name">{s.title}</span>
      {s.meta && <span className="sa-hub__meta">{s.meta}</span>}
      <Status state={s.state}>{s.stateLabel}</Status>
    </button>
  )
  const li = left.findIndex((s) => s.key === selected), ri = right.findIndex((s) => s.key === selected)
  const side = !selected || !children ? null : li >= 0 ? 'l' : ri >= 0 ? 'r' : null
  const y = side === 'l' ? yOf(left.length, li) : side === 'r' ? yOf(right.length, ri) : 0
  // Opened to the left, the canvas grows on that side: keep the overview where it was, then pan to what opened.
  useLayoutEffect(() => {
    const c = canvas.current, b = beside.current
    if (!c || !b) return
    if (side === 'l' && getComputedStyle(c).flexDirection !== 'column') c.scrollLeft += b.offsetWidth + 32
    b.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [side, selected])
  const opened = side && <div ref={beside} className="sa-hub__beside" data-side={side} style={{ marginTop: Math.max(0, y - 24) }}>{children}</div>
  return (
    <div ref={canvas} className="sa-canvas" data-open={!!side}>
      {side === 'l' && opened}
    <div className="sa-hub" style={{ ['--hub-h' as string]: `${h}px` }}>
      <svg className="sa-hub__branches" viewBox={`0 0 1000 ${h}`} preserveAspectRatio="none" aria-hidden="true">
        {left.map((s, i) => <path key={s.key} d={curve('l', yOf(left.length, i))} data-on={selected === s.key} data-state={s.state} />)}
        {right.map((s, i) => <path key={s.key} d={curve('r', yOf(right.length, i))} data-on={selected === s.key} data-state={s.state} />)}
      </svg>
      {[...left.map((s, i) => [s, 'l', yOf(left.length, i)] as const), ...right.map((s, i) => [s, 'r', yOf(right.length, i)] as const)].map(([s, side, y]) => s.count &&
        <span key={`c-${s.key}`} className="sa-hub__count" data-on={selected === s.key} style={{ left: side === 'l' ? '36%' : '64%', top: (y + h / 2) / 2 }}>{s.count}</span>)}
      <div className="sa-hub__col sa-hub__col--l" style={{ paddingTop: (h - left.length * ROW) / 2 + 8 }}>{left.map(card)}</div>
      <div className="sa-hub__centre">
        <span className="sa-hub__mark"><SuperatomMark size={34} /></span>
        <span className="sa-hub__title">{centre.title}</span>
        {centre.subtitle && <span className="sa-hub__subtitle">{centre.subtitle}</span>}
      </div>
      <div className="sa-hub__col sa-hub__col--r" style={{ paddingTop: (h - right.length * ROW) / 2 + 8 }}>{right.map(card)}</div>
      {!sources.length && <div className="sa-hub__empty">{empty ?? 'No data source yet.'}</div>}
    </div>
      {side === 'r' && opened}
    </div>
  )
}

/** One source to look through, read only, flat on the canvas: its tables, and a chosen table's fields beside them —
 *  every row shown (a hundred tables at a time), nothing scrolls inside. */
export function SourceExplorer({ tables, loading, picked, onPick }: {
  tables: TreeTable[]
  loading?: boolean
  picked?: { table: string; field: string | null } | null
  onPick: (p: { table: string; field: string | null }) => void
}) {
  const [shown, setShown] = useState(PAGE)
  const table = picked ? tables.find((t) => t.name === picked.table) ?? null : null
  const live = (x: { enabled: boolean; gone: boolean }) => (x.gone ? 'gone' : x.enabled ? 'on' : 'off')
  return (
    <div className="sa-explore">
      <ul className="sa-explore__col">
        {tables.slice(0, shown).map((t) => (
          <li key={t.name} data-live={live(t)}>
            <button type="button" className="sa-explore__row" aria-pressed={picked?.table === t.name} onClick={() => onPick({ table: t.name, field: null })}>
              <span className="sa-explore__name">{t.name}</span>
              <span className="sa-explore__aside">{t.gone ? 'gone' : !t.enabled ? 'disabled' : t.rows != null ? t.rows.toLocaleString() : ''}</span>
            </button>
          </li>
        ))}
        {!tables.length && <li className="sa-explore__none">{loading ? 'Loading the index…' : 'No tables in the index yet.'}</li>}
        {tables.length > shown && <li><button type="button" className="sa-btn sa-btn--link sa-explore__more" onClick={() => setShown((n) => n + PAGE)}>{Math.min(PAGE, tables.length - shown)} more of {tables.length - shown}</button></li>}
      </ul>
      {table && (
        <ul className="sa-explore__col">
          {table.fields.map((f) => (
            <li key={f.name} data-live={live(f)}>
              <button type="button" className="sa-explore__row" aria-pressed={picked?.field === f.name} onClick={() => onPick({ table: table.name, field: f.name })}>
                <span className="sa-explore__name">{f.name}</span>
                <span className="sa-explore__aside">{f.gone ? 'gone' : !f.enabled ? 'disabled' : [f.key ? 'key' : '', f.type ?? ''].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
          {!table.fields.length && <li className="sa-explore__none">No fields read for this table.</li>}
        </ul>
      )}
    </div>
  )
}

export interface TreeField { name: string; type?: string | null; key?: boolean | null; optional?: boolean | null; references?: string | null
  description?: string; descSource?: string | null; descHuman?: string | null; descAi?: string | null; enabled: boolean; gone: boolean }
export interface TreeTable { name: string; rows?: number | null; description?: string; descSource?: string | null; descHuman?: string | null; descAi?: string | null
  enabled: boolean; gone: boolean; fields: TreeField[] }

const PAGE = 100

export function SourceTree({ title, subtitle, tables, focus, onEnable, onDescribe, onReread, busy }: {
  title: string; subtitle?: string
  /** A table or field picked elsewhere: opened, shown, and scrolled to. */
  focus?: { table: string; field: string | null } | null
  tables: TreeTable[]
  /** Offer a table or a field to the agents, or not (field null: the table). */
  onEnable?: (table: string, field: string | null, enabled: boolean) => void
  /** A person's description of a table or a field (empty: none). */
  onDescribe?: (table: string, field: string | null, text: string) => void
  /** Read one table again from the source (a targeted build). */
  onReread?: (table: string) => void
  busy?: boolean
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [shown, setShown] = useState(PAGE)
  const [pick, setPick] = useState<{ table: string; field: string | null } | null>(null)
  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return tables.map((t) => ({ t, fields: t.fields }))
    return tables.map((t) => ({ t, fields: t.fields.filter((f) => f.name.toLowerCase().includes(needle)) }))
      .filter(({ t, fields }) => t.name.toLowerCase().includes(needle) || fields.length)
  }, [tables, needle])
  const toggle = (name: string) => setOpen((o) => { const n = new Set(o); if (n.has(name)) n.delete(name); else n.add(name); return n })
  const table = pick ? tables.find((t) => t.name === pick.table) ?? null : null
  const field = table && pick?.field ? table.fields.find((f) => f.name === pick.field) ?? null : null
  const live = (x: { enabled: boolean; gone: boolean }) => (x.gone ? 'gone' : x.enabled ? 'on' : 'off')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focus) return
    setPick(focus); setQ('')
    setOpen((o) => (focus.field && !o.has(focus.table) ? new Set(o).add(focus.table) : o))
    const at = tables.findIndex((t) => t.name === focus.table)
    if (at >= 0) setShown((n) => Math.max(n, Math.ceil((at + 1) / PAGE) * PAGE))
  }, [focus?.table, focus?.field])
  useEffect(() => {   // after it is drawn: the picked row in view, and the tree on the page
    if (!focus) return
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    box.current?.querySelector('.sa-stree__list [aria-selected="true"]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [pick, open, shown])
  return (
    <div className="sa-stree" ref={box}>
      <div className="sa-stree__tree">
        <div className="sa-stree__head">
          <span className="sa-stree__root"><Icon icon="lucide:database" />{title}</span>
          {subtitle && <span className="sa-stree__sub">{subtitle}</span>}
          <input className="sa-input sa-stree__search" placeholder="Find a table or a field" aria-label="Find a table or a field" value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE) }} />
        </div>
        <ul className="sa-stree__list" role="tree">
          {matches.slice(0, shown).map(({ t, fields }) => {
            const isOpen = open.has(t.name) || (!!needle && fields.length > 0 && !t.name.toLowerCase().includes(needle))
            return (
              <li key={t.name} role="treeitem" aria-expanded={isOpen} className="sa-stree__table" data-live={live(t)}>
                <div className="sa-stree__row" aria-selected={pick?.table === t.name && !pick.field}>
                  <button type="button" className="sa-stree__twist" aria-label={isOpen ? 'Fold' : 'Open'} onClick={() => toggle(t.name)}><Icon icon={isOpen ? 'lucide:chevron-down' : 'lucide:chevron-right'} /></button>
                  <button type="button" className="sa-stree__name" onClick={() => setPick({ table: t.name, field: null })}>{t.name}</button>
                  <span className="sa-stree__aside">{t.gone ? 'gone' : !t.enabled ? 'disabled' : `${t.fields.filter((f) => !f.gone).length} fields${t.rows != null ? ` · ${t.rows.toLocaleString()} rows` : ''}`}</span>
                </div>
                {isOpen && (
                  <ul className="sa-stree__fields" role="group">
                    {(needle && !t.name.toLowerCase().includes(needle) ? fields : t.fields).map((f) => (
                      <li key={f.name} role="treeitem" className="sa-stree__field" data-live={live(f)}>
                        <button type="button" className="sa-stree__row" aria-selected={pick?.table === t.name && pick.field === f.name} onClick={() => setPick({ table: t.name, field: f.name })}>
                          <span className="sa-stree__name">{f.name}</span>
                          <span className="sa-stree__aside">{f.gone ? 'gone' : !f.enabled ? 'disabled' : [f.key ? 'key' : '', f.type ?? ''].filter(Boolean).join(' · ')}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
          {!matches.length && <li className="sa-stree__none">{needle ? `Nothing named like “${q.trim()}”.` : 'This source has no tables in its index yet.'}</li>}
        </ul>
        {matches.length > shown && <button type="button" className="sa-btn sa-stree__more" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, matches.length - shown)} more of {matches.length - shown}</button>}
      </div>
      <div className="sa-stree__detail">
        {!table ? <p className="sa-stree__hint">Choose a table or a field to see what the index holds about it.</p>
          : <Detail key={`${table.name}/${field?.name ?? ''}`} table={table} field={field} busy={busy}
              onEnable={onEnable ? (on) => onEnable(table.name, field?.name ?? null, on) : undefined}
              onDescribe={onDescribe ? (text) => onDescribe(table.name, field?.name ?? null, text) : undefined}
              onReread={onReread && !field ? () => onReread(table.name) : undefined} />}
      </div>
    </div>
  )
}

function Detail({ table, field, busy, onEnable, onDescribe, onReread }: { table: TreeTable; field: TreeField | null; busy?: boolean; onEnable?: (on: boolean) => void; onDescribe?: (text: string) => void; onReread?: () => void }) {
  const it = field ?? table
  const [text, setText] = useState(it.descHuman ?? '')
  const used = it.descHuman?.trim() ? 'person' : it.descSource?.trim() ? 'source' : it.descAi?.trim() ? 'ai' : null
  const desc = (who: 'person' | 'source' | 'ai', label: string, value?: string | null) => (
    <div className="sa-stree__desc" data-used={used === who}><span className="sa-stree__desc-who">{label}{used === who ? ' · used' : ''}</span><span>{value?.trim() || <span className="sa-faint">—</span>}</span></div>
  )
  return (
    <div className="sa-stree__card">
      <div className="sa-stree__card-head">
        <span className="sa-stree__card-title">{field ? <><span className="sa-faint">{table.name}.</span>{field.name}</> : table.name}</span>
        {it.gone ? <Status state="neutral">gone from the source</Status> : it.enabled ? <Status state="ok">offered to the agents</Status> : <Status state="attention">disabled</Status>}
      </div>
      <dl className="sa-stree__facts">
        {field ? <>
          <dt>Type</dt><dd>{field.type ?? '—'}</dd>
          <dt>Key</dt><dd>{field.key ? 'part of the key' : '—'}</dd>
          <dt>Optional</dt><dd>{field.optional == null ? '—' : field.optional ? 'may be empty' : 'always set'}</dd>
          <dt>References</dt><dd>{field.references ?? '—'}</dd>
        </> : <>
          <dt>Fields</dt><dd>{table.fields.filter((f) => !f.gone).length}{table.fields.some((f) => f.gone) ? ` (and ${table.fields.filter((f) => f.gone).length} gone)` : ''}</dd>
          <dt>Rows</dt><dd>{table.rows == null ? 'not counted' : table.rows.toLocaleString()}</dd>
        </>}
      </dl>
      <div className="sa-stree__descs">
        {desc('person', 'A person', it.descHuman)}
        {desc('source', 'The source', it.descSource)}
        {desc('ai', 'An AI', it.descAi)}
      </div>
      {onDescribe && !it.gone && (
        <form className="sa-stree__write" onSubmit={(e) => { e.preventDefault(); onDescribe(text.trim()) }}>
          <textarea className="sa-input" rows={3} placeholder="What it holds, in a sentence a colleague would understand" aria-label="A person's description" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="sa-btn sa-btn--primary" disabled={busy || text.trim() === (it.descHuman ?? '').trim()}>Save description</button>
        </form>
      )}
      {onEnable && !it.gone && (
        <div className="sa-stree__actions">
          <button type="button" className="sa-btn" disabled={busy} onClick={() => onEnable(!it.enabled)}>{it.enabled ? `Disable this ${field ? 'field' : 'table'}` : `Offer it to the agents again`}</button>
          <span className="sa-faint">{field ? 'A disabled field is left out of find-schema and get-schema.' : 'A disabled table hides all its fields from find-schema and get-schema.'} Queries are not blocked.</span>
        </div>
      )}
      {onReread && (
        <div className="sa-stree__actions">
          <button type="button" className="sa-btn" disabled={busy} onClick={onReread}><Icon icon="lucide:refresh-cw" className="sa-btn__icon" />Read this table again</button>
          <span className="sa-faint">Its fields as the source has them now; a field it no longer has is marked gone.</span>
        </div>
      )}
    </div>
  )
}
