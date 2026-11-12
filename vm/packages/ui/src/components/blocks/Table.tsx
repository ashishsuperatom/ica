// A TABLE ON A STEP IS SHOWN OPEN, PLAINLY — as an answer's table reads (a Part: its heading, one line, the table — no
// card, no border, nothing folded): heads in words, a hairline between rows, figures to the right, the first PLAIN_ROWS
// rows and "Show more" for more in place. A row with a move opens a child from here too; a row whose period is a window
// narrows the block to it; `rowState` washes the row by its state.
//
// THE FULL TABLE is a click away — the quiet expand button at the end of its heading opens it FULL SCREEN, for
// analysis (Analysis.tsx): search, a filter per column, group-by, sort, columns shown or hidden, every row; Escape or its
// close button returns to the step where it was. A table the source pages (`page`) holds one page: full screen, its pager
// asks the source for another page (a program's: through its own STATE, `set`) and its search box searches every row
// there. A table someone opened on purpose (a card opened from an answer) is drawn full, in place (TablesFull).

import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { Part, Pager } from '../ui/Section'
import { AnalysisTable, ExpandButton, FullScreen } from './Analysis'
import { numeric, asNumber, month } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import { sendIntent } from '../../intent'
import type { Block, Column, Row, State } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

/** How many rows a table shows on a step before "Show more" — and how many more each "Show more" adds. */
export const PLAIN_ROWS = 10
/** A trend in a cell (a column of unit "spark": the row's values in order): a line to scale, its last point marked. */
function Spark({ values }: { values: unknown[] }) {
  const ys = values.map((v) => asNumber(v)).filter((v): v is number => v !== null)
  if (ys.length < 2) return null
  const W = 84, H = 22, lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1
  const pts = ys.map((y, i) => [(i / (ys.length - 1)) * (W - 4) + 2, H - 2 - ((y - lo) / span) * (H - 4)] as const)
  const [lx, ly] = pts[pts.length - 1]
  return <svg className="sa-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden><polyline points={pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /><circle cx={lx} cy={ly} r="2" fill="currentColor" /></svg>
}
export function rowStateOf(v: unknown): State | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.toLowerCase()
  if (s === 'ok' || s === 'green') return 'ok'
  if (s === 'warning' || s === 'amber') return 'warning'
  if (s === 'critical' || s === 'red') return 'critical'
  return undefined
}

/** Tables drawn here are full, in place (a table someone opened on purpose); everywhere else a table starts plain, its
 *  full table a click away, full screen. */
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
  const inPlace = useContext(TablesFull)
  const [full, setFull] = useState(false)
  // where the step's intents start from: inside the step, while the overlay is drawn in the body
  const home = useRef<HTMLDivElement>(null)
  const { block } = props
  const close = () => setFull(false)
  if (inPlace) return (
    <Part title={block.title} note={block.page ? pageNote(block.page) : `${block.rows.length.toLocaleString()} row${block.rows.length === 1 ? '' : 's'}`}>
      <div ref={home} className="sa-contents">{block.page ? <SourceBody {...props} home={home} /> : <Analysed {...props} />}</div>
    </Part>
  )
  return (
    <div ref={home} className="sa-contents">
      <PlainTable {...props} onExpand={() => setFull(true)} />
      {full && (
        <FullScreen title={block.title} note={block.page ? pageNote(block.page) : block.says} onClose={close}>
          {block.page ? <SourceBody {...props} home={home} onOpened={close} /> : <Analysed {...props} onOpened={close} />}
        </FullScreen>
      )}
    </div>
  )
}

const pageNote = (p: NonNullable<TableProps['block']['page']>) => `${p.total.toLocaleString()} row${p.total === 1 ? '' : 's'}${p.search ? ` matching "${p.search}"` : ''}`

/** The table's rows analysed (Analysis.tsx): a row that opens something closes the overlay first. */
function Analysed(props: TableProps & { onOpened?: () => void }) {
  const { block, onOpened } = props
  const { fmt } = useFormat()
  const cell = useCell(block)
  const click = useClick(props)
  return <AnalysisTable columns={columnsOf(block)} rows={block.rows} cell={cell}
    text={(r, c) => typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit, c.scale) : undefined}
    rowState={block.rowState ? (r) => rowStateOf(r[block.rowState!]) : undefined}
    onRow={click ? (r) => { onOpened?.(); click(r) } : undefined} />
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
            : <button type="button" className="sa-btn sa-btn--link" onClick={onExpand}>See all {total.toLocaleString()}, full screen</button>}
          <span className="sa-part__count">{rows.length.toLocaleString()} of {total.toLocaleString()} rows</span>
        </div>
      )}
    </Part>
  )
}

/** One page of a table the source reads: its pager asks for the next page — a program's through its own STATE (`set`),
 *  with a search over every row there; otherwise through `onPage`, whose heads with an `order` sort it there. Its intents
 *  start from `home` (inside the step), whether it is drawn there or full screen. */
function SourceBody(props: TableProps & { home: { current: HTMLDivElement | null }; onOpened?: () => void }) {
  const { block, onPage, home, onOpened } = props
  const { fmt } = useFormat()
  const cell = useCell(block)
  const click = useClick(props)
  const p = block.page!
  const [q, setQ] = useState(p.search ?? '')
  const cols: Column[] = block.columns
  const desc = p.order?.startsWith('-')
  const by = p.order?.replace(/^-/, '')
  const set = (ops: { path: string; value: unknown }[]) => { if (home.current) sendIntent(home.current, { ops: ops.map((o) => ({ op: 'set' as const, ...o })), to: 'current' }) }
  const turn = (n: number) => (p.set ? set([{ path: p.set.page, value: n }]) : onPage?.(p.id, n, p.order))
  const search = () => { if (p.set?.search) set([{ path: p.set.search, value: q.trim() || null }, { path: p.set.page, value: 1 }]) }
  const onHeader = (c: Column) => { if (!c.order || p.set) return; onPage?.(p.id, 1, by === c.order ? (desc ? c.order : `-${c.order}`) : `-${c.order}`) }
  return (
    <div className="sa-analysis">
      {p.set?.search && (
        <form className="sa-analysis__tools" data-copy="skip" onSubmit={(e) => { e.preventDefault(); search() }}>
          <label className="sa-table__search"><Icon icon="lucide:search" className="sa-table__search-icon" /><input className="sa-input sa-input--sm" type="search" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => q.trim() !== (p.search ?? '') && search()} placeholder="Search every row" aria-label={`Search ${block.title || 'the table'}`} /></label>
          <span className="sa-analysis__count" role="status">{block.rows.length.toLocaleString()} of {p.total.toLocaleString()} rows on this page</span>
        </form>
      )}
      <div className="sa-analysis__scroll sa-scroll">
        <table className="sa-table sa-analysis__table">
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
              <tr key={i} data-copy="line" className={click ? 'clickable' : undefined} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={() => { if (click) { onOpened?.(); click(r) } }}>
                {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit, c.scale) : undefined}>{cell(r, c)}</td>)}
              </tr>
            ))}
            {!block.rows.length && <tr><td className="l" colSpan={cols.length}><span className="sa-note">{p.search ? `Nothing matches "${p.search}".` : 'Nothing in scope.'}</span></td></tr>}
          </tbody>
        </table>
      </div>
      {p.total > p.size && <div className="sa-analysis__foot" data-copy="skip"><Pager page={p.page - 1} pageSize={p.size} total={p.total} onPage={(n) => turn(n + 1)} /></div>}
    </div>
  )
}
