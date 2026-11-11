// A TABLE ON A STEP IS SHOWN OPEN, PLAINLY — as an answer's table reads (a Part: its heading, one line, the table — no
// card, no border, nothing folded): heads in words, a hairline between rows, figures to the right, the first PLAIN_ROWS
// rows and "Show more" for more in place. A row with a move opens a child from here too; a row whose period is a window
// narrows the block to it; `rowState` washes the row by its state.
//
// THE FULL TABLE is a click away — the quiet expand button at the end of its heading — and back: sort marks in the heads,
// search and group-by once it is long enough to need them (grouped, it reads like a tree — one row per group, closed,
// with its count and the total of each figure that adds up — and pages count groups, not rows), every row paged. Any
// table is sorted, searched, grouped and paged there, in the browser, and says so when it is sorted. A table the source
// pages (`page`) holds one page: its pager asks the source for another page (a program's: through its own STATE, `set`),
// its search box searches every row there. A table someone opened on purpose (a card opened from an answer) is drawn
// full (TablesFull).

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { Part, Pager } from '../ui/Section'
import Select from '../ui/Select'
import { numeric, asNumber, month } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import { sendIntent } from '../../intent'
import type { Block, Column, Row, State } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

/** How many rows a table shows on a step before "Show more" — and how many more each "Show more" adds. */
export const PLAIN_ROWS = 10
const PAGE = 50
/** A trend in a cell (a column of unit "spark": the row's values in order): a line to scale, its last point marked. */
function Spark({ values }: { values: unknown[] }) {
  const ys = values.map((v) => asNumber(v)).filter((v): v is number => v !== null)
  if (ys.length < 2) return null
  const W = 84, H = 22, lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1
  const pts = ys.map((y, i) => [(i / (ys.length - 1)) * (W - 4) + 2, H - 2 - ((y - lo) / span) * (H - 4)] as const)
  const [lx, ly] = pts[pts.length - 1]
  return <svg className="sa-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden><polyline points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><circle cx={lx} cy={ly} r="2" fill="currentColor" /></svg>
}
/** Search and group-by appear on a full table with more rows than this. */
const TOOLS_FROM = 12
/** A figure whose rows add up to a group's total (money, counts) — not a share, a date, a day count or words. */
const adds = (c: Column) => !!c.unit && /^([A-Z]{3}|money|h)$/.test(c.unit)
export function rowStateOf(v: unknown): State | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.toLowerCase()
  if (s === 'ok' || s === 'green') return 'ok'
  if (s === 'warning' || s === 'amber') return 'warning'
  if (s === 'critical' || s === 'red') return 'critical'
  return undefined
}

/** Tables drawn here start full (a table someone opened on purpose); everywhere else a table starts plain. */
export const TablesFull = createContext(false)

type TableProps = { block: Extract<Block, { type: 'table' }> } & BlockCallbacks

/** The columns a table shows: its own, else the first few of its rows' plain fields. */
const columnsOf = (block: TableProps['block']): Column[] => block.columns.length ? block.columns : Object.keys(block.rows[0] ?? {}).filter((k) => typeof block.rows[0]?.[k] !== 'object').slice(0, 8).map((k) => ({ key: k, label: k }))

/** One cell, written the screen's way: a state as a coloured tag, a trend as a spark, a change with its sign. */
function useCell(block: TableProps['block']) {
  const { fmt } = useFormat()
  return (r: Row, c: Column): ReactNode => {
    const v = r[c.key]
    if (c.tones && v != null && String(v) in c.tones) return <span className="sa-pill" data-state={c.tones[String(v)]}>{String(v)}</span>
    if (c.key === block.rowState || (!c.unit && rowStateOf(v) && /rag|state|status/i.test(c.key))) { const s = rowStateOf(v); return s ? <span className="sa-pill" data-state={s}>{String(v)}</span> : fmt(v, c.unit, c.scale) }
    if (c.unit === 'spark') return Array.isArray(v) ? <Spark values={v} /> : null
    if (!c.unit && typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) return month(v)
    if (c.delta) { const n = asNumber(v); if (n === null) return '—'; return <span className="sa-figure sa-delta" data-state={n < 0 ? 'critical' : n > 0 ? 'ok' : undefined}>{n > 0 ? '+' : ''}{fmt(n, c.unit, c.scale)}</span> }
    return numeric(c.unit) ? <span className="sa-figure">{fmt(v, c.unit, c.scale)}</span> : fmt(v, c.unit, c.scale)
  }
}
/** What a row click does: narrow to its window, or open its move. */
function useClick({ block, onRow, onRowWindow }: TableProps) {
  const clickable = !!block.rowMove || !!block.rowWindow
  const click = (r: Row) => {
    if (block.rowWindow) { const v = r[block.rowWindow.key]; if (typeof v === 'string') return onRowWindow?.(block.rowWindow.kind, v) }
    if (block.rowMove) onRow?.(block.rowMove, r)
  }
  return clickable ? click : undefined
}

export default function Table(props: TableProps) {
  const [full, setFull] = useState(useContext(TablesFull))
  if (!full) return <PlainTable {...props} onExpand={() => setFull(true)} />
  const back = <button type="button" className="sa-icon-btn sa-icon-btn--sm" aria-label="Back to the plain table" title="Back to the plain table" onClick={() => setFull(false)}><Icon icon="lucide:minimize-2" /></button>
  return props.block.page ? <SourceTable {...props} back={back} /> : <FullTable {...props} back={back} />
}

/** The button that opens a table full: search, group-by, sort, every row. */
function ExpandButton({ onExpand }: { onExpand: () => void }) {
  return <button type="button" className="sa-icon-btn sa-icon-btn--sm" aria-label="Open the full table" title="Open the full table — search, group, sort, every row" onClick={onExpand}><Icon icon="lucide:maximize-2" /></button>
}

/** The table as it reads on a step: the first rows, plainly; "Show more" for more in place; expand for the full one. */
export function PlainTable(props: TableProps & { onExpand: () => void }) {
  const { block, onExpand } = props
  const [shown, setShown] = useState(PLAIN_ROWS)
  const cols = columnsOf(block)
  const cell = useCell(block)
  const click = useClick(props)
  const { fmt } = useFormat()
  // a table the source pages holds one page here; the rest is the full table's
  const total = block.page ? block.page.total : block.rows.length
  const rows = block.rows.slice(0, shown)
  const more = block.rows.length > shown
  const elsewhere = !more && total > block.rows.length
  return (
    <Part title={block.title} tools={<ExpandButton onExpand={onExpand} />}>
      <div className="sa-readtable"><div className="sa-readtable__scroll">
        <table>
          <thead><tr>{cols.map((c) => <th key={c.key} data-num={numeric(c.unit) || undefined}><span className="sa-readtable__head" title={c.label}>{c.label}</span></th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-copy="line" data-open={click ? true : undefined} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={click ? () => click(r) : undefined}>
                {cols.map((c) => <td key={c.key} data-num={numeric(c.unit) || undefined} title={typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit, c.scale) : undefined}>{cell(r, c)}</td>)}
              </tr>
            ))}
            {!block.rows.length && <tr><td colSpan={cols.length}><span className="sa-note">Nothing in scope.</span></td></tr>}
          </tbody>
        </table>
      </div></div>
      {(more || elsewhere) && (
        <div className="sa-part__more" data-copy="skip">
          {more
            ? <button type="button" className="sa-btn sa-btn--link" onClick={() => setShown(shown + PLAIN_ROWS)}>Show more</button>
            : <button type="button" className="sa-btn sa-btn--link" onClick={onExpand}>Show all {total.toLocaleString()} in the full table</button>}
          <span className="sa-part__count">{rows.length.toLocaleString()} of {total.toLocaleString()} rows</span>
        </div>
      )}
    </Part>
  )
}

function FullTable(props: TableProps & { back: ReactNode }) {
  const { block, back } = props
  const { fmt } = useFormat()
  const cell = useCell(block)
  const click = useClick(props)
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [q, setQ] = useState('')
  const [groupBy, setGroupBy] = useState('')
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const cols = columnsOf(block)
  const tools = block.rows.length > TOOLS_FROM
  // A column can group the rows when it holds words that repeat: more than one value, and fewer values than rows.
  const groupable = useMemo(() => cols.filter((c) => !numeric(c.unit)).filter((c) => {
    const vals = new Set(block.rows.map((r) => r[c.key]).filter((v) => typeof v === 'string' && v))
    return vals.size > 1 && vals.size <= Math.min(50, block.rows.length / 1.5)
  }), [block.rows, cols])
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    const found = t ? block.rows.filter((r) => cols.some((c) => String(r[c.key] ?? '').toLowerCase().includes(t))) : block.rows
    if (!sort) return found
    const { key, dir } = sort
    return [...found].sort((a, b) => {
      const x = a[key], y = b[key]
      const nx = asNumber(x), ny = asNumber(y)
      const c = nx !== null && ny !== null ? nx - ny : String(x ?? '').localeCompare(String(y ?? ''))
      return dir === 'desc' ? -c : c
    })
  }, [block.rows, sort, q, cols])
  // Grouped: the groups in the order their first row comes (so the sort orders them), each with its count and totals.
  const groups = useMemo(() => {
    if (!groupBy) return null
    const by = new Map<string, Row[]>()
    for (const r of rows) { const k = String(r[groupBy] ?? '—'); (by.get(k) ?? by.set(k, []).get(k)!).push(r) }
    return [...by.entries()].map(([key, rs]) => ({ key, rows: rs, totals: Object.fromEntries(cols.filter(adds).map((c) => [c.key, rs.reduce((a, r) => a + (asNumber(r[c.key]) ?? 0), 0)])) }))
  }, [rows, groupBy, cols])
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE)
  const shownGroups = groups?.slice(page * PAGE, page * PAGE + PAGE) ?? null
  const toggle = (k: string) => setOpened((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const onHeader = (c: Column) => { setPage(0); setSort(sort?.key === c.key ? (sort.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' }) }
  const sortedBy = sort && (cols.find((c) => c.key === sort.key)?.label ?? sort.key)
  const title = (r: Row, c: Column) => typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit, c.scale) : undefined
  return (
    <Part title={block.title} note={q.trim() ? `${rows.length} of ${block.rows.length} rows` : `${block.rows.length} row${block.rows.length === 1 ? '' : 's'}`} tools={back}
      footer={sort ? (
        <>
          <Icon icon="lucide:arrow-up-down" className="sa-btn__icon" />
          <span className="sa-pager__count">Sorted by {sortedBy} here, in the browser — the question was not re-asked.</span>
          <span className="sa-pager__nav"><button className="sa-btn" onClick={() => setSort(null)}>Unsort</button></span>
        </>
      ) : undefined}>
      {tools && (
        <div className="sa-table__tools" data-copy="skip">
          <label className="sa-table__search"><Icon icon="lucide:search" className="sa-table__search-icon" /><input className="sa-input sa-input--sm" type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Search the rows" aria-label={`Search ${block.title || 'the table'}`} /></label>
          {groupable.length > 0 && <Select variant="chip" label="Group by" value={groupBy} onChange={(v: string) => { setGroupBy(v); setOpened(new Set()); setPage(0) }} options={groupable.map((c) => ({ value: c.key, label: c.label }))} emptyLabel="No grouping" placeholder="none" />}
        </div>
      )}
      <div className="sa-section__scroll sa-section__scroll--tall sa-scroll">
        <table className="sa-table">
          <thead>
            <tr>{cols.map((c) => {
              const on = sort?.key === c.key
              return (
                <th key={c.key} className={`${numeric(c.unit) ? '' : 'l'} is-sortable`} aria-sort={on ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => onHeader(c)} title={`Sort by ${c.label.toLowerCase()} — here, in the browser`}>
                  <span className={`sa-table__head${numeric(c.unit) ? ' sa-table__head--figure' : ''}`}>
                    {c.label}
                    <Icon icon={on ? (sort!.dir === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down') : 'lucide:chevrons-up-down'} className="sa-table__sort" />
                  </span>
                </th>
              )
            })}</tr>
          </thead>
          <tbody>
            {shownGroups ? shownGroups.map((g) => {
              const open = opened.has(g.key)
              return [
                <tr key={`g:${g.key}`} className="sa-table__group clickable" aria-expanded={open} onClick={() => toggle(g.key)}>
                  {cols.map((c, j) => c.key === groupBy || (j === 0 && !cols.some((x) => x.key === groupBy))
                    ? <td key={c.key} className="l"><span className="sa-table__group-name"><Icon icon={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} className="sa-table__chev" />{g.key}<span className="sa-table__count">{g.rows.length}</span></span></td>
                    : <td key={c.key} className={numeric(c.unit) ? undefined : 'l'}>{c.key in g.totals ? <span className="sa-figure">{fmt(g.totals[c.key], c.unit, c.scale)}</span> : null}</td>)}
                </tr>,
                ...(open ? g.rows.map((r, i) => <tr key={`g:${g.key}:${i}`} data-copy="line" className={`sa-table__child${click ? ' clickable' : ''}`} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={() => click?.(r)}>
                  {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={title(r, c)}>{c.key === groupBy ? null : cell(r, c)}</td>)}
                </tr>) : []),
              ]
            }) : shown.map((r, i) => (
              <tr key={i} data-copy="line" className={click ? 'clickable' : undefined} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={() => click?.(r)}>
                {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={title(r, c)}>{cell(r, c)}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td className="l" colSpan={cols.length}><span className="sa-note">{block.rows.length ? `Nothing matches "${q.trim()}".` : 'Nothing in scope.'}</span></td></tr>}
          </tbody>
        </table>
      </div>
      {(groups ? groups.length : rows.length) > PAGE && <Pager page={page} pageSize={PAGE} total={groups ? groups.length : rows.length} onPage={setPage} />}
    </Part>
  )
}

/** One page of a table the source reads: its pager asks for the next page — a program's through its own STATE (`set`),
 *  with a search over every row there; otherwise through `onPage`, whose heads with an `order` sort it there. */
function SourceTable(props: TableProps & { back: ReactNode }) {
  const { block, onPage, back } = props
  const { fmt } = useFormat()
  const cell = useCell(block)
  const click = useClick(props)
  const box = useRef<HTMLDivElement>(null)
  const p = block.page!
  const [q, setQ] = useState(p.search ?? '')
  const cols: Column[] = block.columns
  const desc = p.order?.startsWith('-')
  const by = p.order?.replace(/^-/, '')
  const set = (ops: { path: string; value: unknown }[]) => { if (box.current) sendIntent(box.current, { ops: ops.map((o) => ({ op: 'set' as const, ...o })), to: 'current' }) }
  const turn = (n: number) => (p.set ? set([{ path: p.set.page, value: n }]) : onPage?.(p.id, n, p.order))
  const search = () => { if (p.set?.search) set([{ path: p.set.search, value: q.trim() || null }, { path: p.set.page, value: 1 }]) }
  const onHeader = (c: Column) => { if (!c.order || p.set) return; onPage?.(p.id, 1, by === c.order ? (desc ? c.order : `-${c.order}`) : `-${c.order}`) }
  return (
    <Part title={block.title} note={`${p.total.toLocaleString()} row${p.total === 1 ? '' : 's'}${p.search ? ` matching "${p.search}"` : ''}`} tools={back}>
      <div ref={box} className="sa-stack">
        {p.set?.search && (
          <form className="sa-table__tools" data-copy="skip" onSubmit={(e) => { e.preventDefault(); search() }}>
            <label className="sa-table__search"><Icon icon="lucide:search" className="sa-table__search-icon" /><input className="sa-input sa-input--sm" type="search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => q.trim() !== (p.search ?? '') && search()} placeholder="Search every row" aria-label={`Search ${block.title || 'the table'}`} /></label>
          </form>
        )}
        <div className="sa-section__scroll sa-section__scroll--tall sa-scroll">
          <table className="sa-table">
            <thead>
              <tr>{cols.map((c) => {
                const sortable = !!c.order && !p.set
                const on = sortable && by === c.order
                return (
                  <th key={c.key} className={`${numeric(c.unit) ? '' : 'l'}${sortable ? ' is-sortable' : ''}`} aria-sort={on ? (desc ? 'descending' : 'ascending') : 'none'} onClick={() => onHeader(c)} title={sortable ? `Sort by ${c.label.toLowerCase()}` : undefined}>
                    <span className={`sa-table__head${numeric(c.unit) ? ' sa-table__head--figure' : ''}`}>
                      {c.label}
                      {sortable && <Icon icon={on ? (desc ? 'lucide:arrow-down' : 'lucide:arrow-up') : 'lucide:chevrons-up-down'} className="sa-table__sort" />}
                    </span>
                  </th>
                )
              })}</tr>
            </thead>
            <tbody>
              {block.rows.map((r, i) => (
                <tr key={i} data-copy="line" className={click ? 'clickable' : undefined} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={() => click?.(r)}>
                  {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit, c.scale) : undefined}>{cell(r, c)}</td>)}
                </tr>
              ))}
              {!block.rows.length && <tr><td className="l" colSpan={cols.length}><span className="sa-note">{p.search ? `Nothing matches "${p.search}".` : 'Nothing in scope.'}</span></td></tr>}
            </tbody>
          </table>
        </div>
        {p.total > p.size && <Pager page={p.page - 1} pageSize={p.size} total={p.total} onPage={(n) => turn(n + 1)} />}
      </div>
    </Part>
  )
}
