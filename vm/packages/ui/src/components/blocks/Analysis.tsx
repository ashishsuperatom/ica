// A TABLE OPENED FOR ANALYSIS — full screen. The quiet expand button of a plain table (or of a chart's table view) opens
// it over the whole window, above the app shell; Escape or its close button returns to the step exactly where it was
// (the step is never redrawn: the overlay is drawn beside it), focus moving in and back, the page's scroll held while it
// is open. In it: the title and its line; a search over every column; group-by (each group's count and the total of each
// figure that adds up, opened to its rows); sort by any column (ascending, descending, off); a filter per column — the
// values of a text column with how many rows hold each, a range for a figure; columns shown or hidden; the count of what
// is shown; every row, a hundred a page. A row that opens something closes the overlay first, then opens it.
//
// The analysis is display only (rule 12): sorted, searched, filtered and grouped here, in the browser, never asked again.
// `analyse` is the whole of it as one pure function.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../ui/Icon'
import { Pager } from '../ui/Section'
import Select from '../ui/Select'
import MultiSelect from '../ui/MultiSelect'
import { numeric, asNumber } from '../../lib/format'
import type { Column, Row } from '../../answer/blocks'

/** How many rows (or groups) a page of the analysis holds. */
export const ANALYSIS_PAGE = 100

/** The button that opens a table full screen, for analysis. */
export function ExpandButton({ onExpand, label = 'Open full screen — search, filter, group, sort, every row' }: { onExpand: () => void; label?: string }) {
  return <button type="button" className="sa-icon-btn sa-icon-btn--sm" aria-label="Open full screen" title={label} onClick={onExpand}><Icon icon="lucide:maximize-2" /></button>
}

/**
 * The full-screen overlay: a modal dialog over the whole window. Escape (unless something inside used it — a list
 * closing) or the close button closes it; focus moves in on opening and back to where it was on closing; the page does
 * not scroll behind it. Drawn into the body (beside the app, above it); where there is no document (a server render) it
 * is drawn in place.
 */
export function FullScreen({ title, note, onClose, children }: { title: string; note?: ReactNode; onClose: () => void; children: ReactNode }) {
  const closer = useRef<HTMLButtonElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closer.current?.focus()
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeRef.current() } }
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('keydown', escape); document.body.style.overflow = overflow; before?.focus?.() }
  }, [])
  const dialog = (
    <div className="sa-fullscreen" role="dialog" aria-modal="true" aria-label={title || 'The table'}>
      <header className="sa-fullscreen__head">
        <div className="sa-fullscreen__heading">
          <h2 className="sa-fullscreen__title" title={title}>{title || 'The table'}</h2>
          {note && <p className="sa-fullscreen__note">{note}</p>}
        </div>
        <button ref={closer} type="button" className="sa-icon-btn" aria-label="Close full screen" title="Close (Esc)" onClick={() => closeRef.current()}><Icon icon="lucide:x" /></button>
      </header>
      <div className="sa-fullscreen__body">{children}</div>
    </div>
  )
  return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
}

/** What the reader asked of the table: a search, a filter per column, a sort, a grouping. */
export interface AnalysisAsk {
  q: string
  /** A text column's values kept (none: every value). */
  values: Record<string, string[]>
  /** A figure's range kept (either end open). */
  ranges: Record<string, { min?: number; max?: number }>
  sort: { key: string; dir: 'asc' | 'desc' } | null
  groupBy: string
}
export const NO_ASK: AnalysisAsk = { q: '', values: {}, ranges: {}, sort: null, groupBy: '' }

export interface AnalysisGroup { key: string; rows: Row[]; totals: Record<string, number> }

/** A figure whose rows add up to a group's total (money, counts, hours) — not a share, a date, a day count or words. */
export const adds = (c: Column) => !!c.unit && /^([A-Z]{3}|money|h|count)$/.test(c.unit)
const words = (v: unknown) => (v == null ? '' : String(v))

/** The rows the reader's asks leave, in order, and — grouped — the groups (in the order their first row comes, so the
 *  sort orders them too), each with its count and totals. */
export function analyse(rows: Row[], cols: Column[], a: AnalysisAsk): { rows: Row[]; groups: AnalysisGroup[] | null } {
  const t = a.q.trim().toLowerCase()
  let found = rows.filter((r) => {
    if (t && !cols.some((c) => words(r[c.key]).toLowerCase().includes(t))) return false
    for (const [k, vs] of Object.entries(a.values)) if (vs.length && !vs.includes(words(r[k]))) return false
    for (const [k, { min, max }] of Object.entries(a.ranges)) {
      if (min === undefined && max === undefined) continue
      const n = asNumber(r[k])
      if (n === null || (min !== undefined && n < min) || (max !== undefined && n > max)) return false
    }
    return true
  })
  if (a.sort) {
    const { key, dir } = a.sort
    found = [...found].sort((x, y) => {
      const nx = asNumber(x[key]), ny = asNumber(y[key])
      const c = nx !== null && ny !== null ? nx - ny : words(x[key]).localeCompare(words(y[key]))
      return dir === 'desc' ? -c : c
    })
  }
  if (!a.groupBy) return { rows: found, groups: null }
  const by = new Map<string, Row[]>()
  for (const r of found) { const k = words(r[a.groupBy]) || '—'; (by.get(k) ?? by.set(k, []).get(k)!).push(r) }
  const groups = [...by.entries()].map(([key, rs]) => ({ key, rows: rs, totals: Object.fromEntries(cols.filter(adds).map((c) => [c.key, rs.reduce((s, r) => s + (asNumber(r[c.key]) ?? 0), 0)])) }))
  return { rows: found, groups }
}

/** A text column's values, most held first, each with how many rows hold it. */
export function columnValues(rows: Row[], key: string): { value: string; count: number }[] {
  const n = new Map<string, number>()
  for (const r of rows) { const v = words(r[key]); n.set(v, (n.get(v) ?? 0) + 1) }
  return [...n.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
}

/** A column that can group the rows: words that repeat — more than one value, and fewer values than rows. */
const groupable = (rows: Row[], c: Column) => {
  if (numeric(c.unit) || c.unit === 'spark') return false
  const vals = new Set(rows.map((r) => r[c.key]).filter((v) => typeof v === 'string' && v))
  return vals.size > 1 && vals.size < rows.length
}

/**
 * The analysis of one table: its tools, then the table with a sort mark and a filter under every head, a page at a time.
 * `cell` draws a value, `text` gives it in words (a cell's title); `onRow` opens a row (the caller closes the overlay).
 */
export function AnalysisTable({ columns, rows, cell, text, onRow, rowState }: {
  columns: Column[]
  rows: Row[]
  cell: (r: Row, c: Column) => ReactNode
  text: (r: Row, c: Column) => string | undefined
  onRow?: (r: Row) => void
  rowState?: (r: Row) => string | undefined
}) {
  const [ask, setAsk] = useState<AnalysisAsk>(NO_ASK)
  const [page, setPage] = useState(0)
  const [shownCols, setShownCols] = useState<string[]>([])
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const change = (patch: Partial<AnalysisAsk>) => { setAsk((a) => ({ ...a, ...patch })); setPage(0) }
  const cols = shownCols.length ? columns.filter((c) => shownCols.includes(c.key)) : columns
  const result = useMemo(() => analyse(rows, columns, ask), [rows, columns, ask])
  const groupCols = useMemo(() => columns.filter((c) => groupable(rows, c)), [rows, columns])
  const values = useMemo(() => Object.fromEntries(columns.filter((c) => !numeric(c.unit) && c.unit !== 'spark').map((c) => [c.key, columnValues(rows, c.key)])), [rows, columns])
  const units = result.groups ?? result.rows
  const shown = units.slice(page * ANALYSIS_PAGE, page * ANALYSIS_PAGE + ANALYSIS_PAGE)
  const filtered = ask.q.trim() !== '' || Object.values(ask.values).some((v) => v.length) || Object.values(ask.ranges).some((r) => r.min !== undefined || r.max !== undefined)
  const onHeader = (c: Column) => change({ sort: ask.sort?.key === c.key ? (ask.sort.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' } })
  const toggle = (k: string) => setOpened((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const sortedBy = ask.sort && (columns.find((c) => c.key === ask.sort!.key)?.label ?? ask.sort.key)
  const row = (r: Row, i: number | string, child = false) => (
    <tr key={i} data-copy="line" className={`${child ? 'sa-table__child' : ''}${onRow ? ' clickable' : ''}`} data-state={rowState?.(r)} onClick={() => onRow?.(r)}>
      {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={text(r, c)}>{child && c.key === ask.groupBy ? null : cell(r, c)}</td>)}
    </tr>
  )
  return (
    <div className="sa-analysis">
      <div className="sa-analysis__tools" data-copy="skip">
        <label className="sa-table__search"><Icon icon="lucide:search" className="sa-table__search-icon" /><input className="sa-input sa-input--sm" type="search" value={ask.q} onChange={(e) => change({ q: e.target.value })} placeholder="Search every column" aria-label="Search the rows" /></label>
        {groupCols.length > 0 && <Select variant="chip" label="Group by" value={ask.groupBy} onChange={(v: string) => { change({ groupBy: v }); setOpened(new Set()) }} options={groupCols.map((c) => ({ value: c.key, label: c.label }))} emptyLabel="No grouping" placeholder="none" />}
        <MultiSelect variant="chip" label="Columns" noun={['column', 'columns']} allLabel="Every column" value={shownCols} onChange={setShownCols} options={columns.map((c) => ({ value: c.key, label: c.label }))} />
        <span className="sa-analysis__count" role="status">
          {result.groups ? `${result.groups.length.toLocaleString()} group${result.groups.length === 1 ? '' : 's'} · ` : ''}{result.rows.length.toLocaleString()} of {rows.length.toLocaleString()} rows
        </span>
        {(filtered || ask.sort) && <button type="button" className="sa-btn sa-btn--link" onClick={() => change({ q: '', values: {}, ranges: {}, sort: null })}>Clear filters and sort</button>}
      </div>
      <div className="sa-analysis__scroll sa-scroll">
        <table className="sa-table sa-analysis__table">
          <thead>
            <tr>{cols.map((c) => {
              const on = ask.sort?.key === c.key
              return (
                <th key={c.key} className={`${numeric(c.unit) ? '' : 'l'} is-sortable`} aria-sort={on ? (ask.sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => onHeader(c)} title={`Sort by ${c.label.toLowerCase()}`}>
                  <span className={`sa-table__head${numeric(c.unit) ? ' sa-table__head--figure' : ''}`}>
                    {c.label}
                    <Icon icon={on ? (ask.sort!.dir === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down') : 'lucide:chevrons-up-down'} className="sa-table__sort" />
                  </span>
                </th>
              )
            })}</tr>
            <tr className="sa-analysis__filters" data-copy="skip">{cols.map((c) => (
              <th key={c.key} className={numeric(c.unit) ? undefined : 'l'}>
                {numeric(c.unit)
                  ? <RangeFilter label={c.label} value={ask.ranges[c.key] ?? {}} onChange={(r) => change({ ranges: { ...ask.ranges, [c.key]: r } })} />
                  : values[c.key] && values[c.key].length > 1
                    ? <MultiSelect label={c.label} noun={['value', 'values']} allLabel="All" value={ask.values[c.key] ?? []} onChange={(v) => change({ values: { ...ask.values, [c.key]: v } })}
                        options={values[c.key].map((v) => ({ value: v.value, label: v.value || '—', cells: [v.count.toLocaleString()] }))} />
                    : null}
              </th>
            ))}</tr>
          </thead>
          <tbody>
            {result.groups ? (shown as AnalysisGroup[]).flatMap((g) => {
              const open = opened.has(g.key)
              return [
                <tr key={`g:${g.key}`} className="sa-table__group clickable" aria-expanded={open} onClick={() => toggle(g.key)}>
                  {cols.map((c, j) => c.key === ask.groupBy || (j === 0 && !cols.some((x) => x.key === ask.groupBy))
                    ? <td key={c.key} className="l"><span className="sa-table__group-name"><Icon icon={open ? 'lucide:chevron-down' : 'lucide:chevron-right'} className="sa-table__chev" />{g.key}<span className="sa-table__count">{g.rows.length}</span></span></td>
                    : <td key={c.key} className={numeric(c.unit) ? undefined : 'l'}>{c.key in g.totals ? cell({ [c.key]: g.totals[c.key] }, c) : null}</td>)}
                </tr>,
                ...(open ? g.rows.map((r, i) => row(r, `g:${g.key}:${i}`, true)) : []),
              ]
            }) : (shown as Row[]).map((r, i) => row(r, i))}
            {!result.rows.length && <tr><td className="l" colSpan={cols.length}><span className="sa-note">{rows.length ? 'Nothing matches what is asked.' : 'Nothing in scope.'}</span></td></tr>}
          </tbody>
        </table>
      </div>
      <div className="sa-analysis__foot" data-copy="skip">
        {ask.sort && <span className="sa-pager__count">Sorted by {sortedBy} here, in the browser — the question was not re-asked.</span>}
        {units.length > ANALYSIS_PAGE && <Pager page={page} pageSize={ANALYSIS_PAGE} total={units.length} onPage={setPage} />}
      </div>
    </div>
  )
}

/** A figure's range: from, to (either open); a number typed, kept as it is typed, applied when it reads as one. */
function RangeFilter({ label, value, onChange }: { label: string; value: { min?: number; max?: number }; onChange: (r: { min?: number; max?: number }) => void }) {
  const [lo, setLo] = useState(value.min === undefined ? '' : String(value.min))
  const [hi, setHi] = useState(value.max === undefined ? '' : String(value.max))
  const read = (s: string) => { const n = Number(s.replace(/,/g, '')); return s.trim() === '' || !Number.isFinite(n) ? undefined : n }
  return (
    <span className="sa-analysis__range">
      <input className="sa-input sa-input--sm sa-input--num" inputMode="decimal" value={lo} placeholder="from" aria-label={`${label} from`} onChange={(e) => { setLo(e.target.value); onChange({ min: read(e.target.value), max: read(hi) }) }} />
      <input className="sa-input sa-input--sm sa-input--num" inputMode="decimal" value={hi} placeholder="to" aria-label={`${label} to`} onChange={(e) => { setHi(e.target.value); onChange({ min: read(lo), max: read(e.target.value) }) }} />
    </span>
  )
}
