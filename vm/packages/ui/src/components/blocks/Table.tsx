// A table on the design system's table: sort marks in the heads, a pager. A table the source pages (`page`) holds one
// page: its pager and its sortable heads ask the source for another page or order. Any other table is sorted, searched,
// grouped and paged here, in the browser, and says so when it is sorted. Search and group-by appear once a table is long
// enough to need them; grouped, it reads like a tree — one row per group, closed, with its count and the total of each
// figure that adds up, opened to show its rows — and pages count groups, not rows. A row with a move opens a child; a
// row whose period is a window narrows the block to it; `rowState` washes the row by its state.

import { useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Section, Pager } from '../ui/Section'
import Select from '../ui/Select'
import { numeric, asNumber, month } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import type { Block, Column, Row, State } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

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
/** Search and group-by appear on a table with more rows than this. */
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

export default function Table({ block, onRow, onRowWindow, onPage }: { block: Extract<Block, { type: 'table' }> } & BlockCallbacks) {
  const { fmt } = useFormat()
  if (block.page) return <SourceTable block={block} onRow={onRow} onRowWindow={onRowWindow} onPage={onPage} />
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const [q, setQ] = useState('')
  const [groupBy, setGroupBy] = useState('')
  const [opened, setOpened] = useState<Set<string>>(new Set())
  const cols: Column[] = block.columns.length ? block.columns : Object.keys(block.rows[0] ?? {}).filter((k) => typeof block.rows[0]?.[k] !== 'object').slice(0, 8).map((k) => ({ key: k, label: k }))
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
  const cell = (r: Row, c: Column) => {
    const v = r[c.key]
    if (c.key === block.rowState || (!c.unit && rowStateOf(v) && /rag|state|status/i.test(c.key))) { const s = rowStateOf(v); return s ? <span className="sa-pill" data-state={s}>{String(v)}</span> : fmt(v, c.unit) }
    if (c.unit === 'spark') return Array.isArray(v) ? <Spark values={v} /> : null
    if (!c.unit && typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) return month(v)
    if (c.delta) { const n = asNumber(v); if (n === null) return '—'; return <span className="sa-figure sa-delta" data-state={n < 0 ? 'critical' : n > 0 ? 'ok' : undefined}>{n > 0 ? '+' : ''}{fmt(n, c.unit)}</span> }
    return numeric(c.unit) ? <span className="sa-figure">{fmt(v, c.unit)}</span> : fmt(v, c.unit)
  }
  const click = (r: Row) => {
    if (block.rowWindow) { const v = r[block.rowWindow.key]; if (typeof v === 'string') return onRowWindow?.(block.rowWindow.kind, v) }
    if (block.rowMove) onRow?.(block.rowMove, r)
  }
  const clickable = !!block.rowMove || !!block.rowWindow
  const sortedBy = sort && (cols.find((c) => c.key === sort.key)?.label ?? sort.key)
  return (
    <Section icon="lucide:table" accent="series-1" title={block.title} note={q.trim() ? `${rows.length} of ${block.rows.length} rows` : `${block.rows.length} row${block.rows.length === 1 ? '' : 's'}`}
      actions={tools ? (
        <span className="sa-table__tools" data-copy="skip">
          <label className="sa-table__search"><Icon icon="lucide:search" className="sa-table__search-icon" /><input className="sa-input sa-input--sm" type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Search the rows" aria-label={`Search ${block.title || 'the table'}`} /></label>
          {groupable.length > 0 && <Select variant="chip" label="Group by" value={groupBy} onChange={(v: string) => { setGroupBy(v); setOpened(new Set()); setPage(0) }} options={groupable.map((c) => ({ value: c.key, label: c.label }))} emptyLabel="No grouping" placeholder="none" />}
        </span>
      ) : undefined}
      footer={sort ? (
        <>
          <Icon icon="lucide:arrow-up-down" className="sa-btn__icon" />
          <span className="sa-pager__count">Sorted by {sortedBy} here, in the browser — the question was not re-asked.</span>
          <span className="sa-pager__nav"><button className="sa-btn" onClick={() => setSort(null)}>Unsort</button></span>
        </>
      ) : undefined}>
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
                    : <td key={c.key} className={numeric(c.unit) ? undefined : 'l'}>{c.key in g.totals ? <span className="sa-figure">{fmt(g.totals[c.key], c.unit)}</span> : null}</td>)}
                </tr>,
                ...(open ? g.rows.map((r, i) => <tr key={`g:${g.key}:${i}`} data-copy="line" className={`sa-table__child${clickable ? ' clickable' : ''}`} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={() => clickable && click(r)}>
                  {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit) : undefined}>{c.key === groupBy ? null : cell(r, c)}</td>)}
                </tr>) : []),
              ]
            }) : shown.map((r, i) => (
              <tr key={i} data-copy="line" className={clickable ? 'clickable' : undefined} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={() => clickable && click(r)}>
                {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit) : undefined}>{cell(r, c)}</td>)}
              </tr>
            ))}
            {!rows.length && <tr><td className="l" colSpan={cols.length}><span className="sa-note">{block.rows.length ? `Nothing matches "${q.trim()}".` : 'Nothing in scope.'}</span></td></tr>}
          </tbody>
        </table>
      </div>
      {(groups ? groups.length : rows.length) > PAGE && <Pager page={page} pageSize={PAGE} total={groups ? groups.length : rows.length} onPage={setPage} />}
    </Section>
  )
}

/** One page of a table the source reads: the heads that have an `order` sort it there, the pager asks for the next page. */
function SourceTable({ block, onRow, onRowWindow, onPage }: { block: Extract<Block, { type: 'table' }> } & BlockCallbacks) {
  const { fmt } = useFormat()
  const p = block.page!
  const cols: Column[] = block.columns
  const desc = p.order?.startsWith('-')
  const by = p.order?.replace(/^-/, '')
  const onHeader = (c: Column) => { if (!c.order) return; onPage?.(p.id, 1, by === c.order ? (desc ? c.order : `-${c.order}`) : `-${c.order}`) }
  const cell = (r: Row, c: Column) => {
    const v = r[c.key]
    if (c.key === block.rowState || (!c.unit && rowStateOf(v) && /rag|state|status/i.test(c.key))) { const s = rowStateOf(v); return s ? <span className="sa-pill" data-state={s}>{String(v)}</span> : fmt(v, c.unit) }
    if (!c.unit && typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)) return month(v)
    return numeric(c.unit) ? <span className="sa-figure">{fmt(v, c.unit)}</span> : fmt(v, c.unit)
  }
  const click = (r: Row) => {
    if (block.rowWindow) { const v = r[block.rowWindow.key]; if (typeof v === 'string') return onRowWindow?.(block.rowWindow.kind, v) }
    if (block.rowMove) onRow?.(block.rowMove, r)
  }
  const clickable = !!block.rowMove || !!block.rowWindow
  return (
    <Section icon="lucide:table" accent="series-1" title={block.title} note={`${p.total} row${p.total === 1 ? '' : 's'}`}>
      <div className="sa-section__scroll sa-section__scroll--tall sa-scroll">
        <table className="sa-table">
          <thead>
            <tr>{cols.map((c) => {
              const on = !!c.order && by === c.order
              return (
                <th key={c.key} className={`${numeric(c.unit) ? '' : 'l'}${c.order ? ' is-sortable' : ''}`} aria-sort={on ? (desc ? 'descending' : 'ascending') : 'none'} onClick={() => onHeader(c)} title={c.order ? `Sort by ${c.label.toLowerCase()}` : undefined}>
                  <span className={`sa-table__head${numeric(c.unit) ? ' sa-table__head--figure' : ''}`}>
                    {c.label}
                    {c.order && <Icon icon={on ? (desc ? 'lucide:arrow-down' : 'lucide:arrow-up') : 'lucide:chevrons-up-down'} className="sa-table__sort" />}
                  </span>
                </th>
              )
            })}</tr>
          </thead>
          <tbody>
            {block.rows.map((r, i) => (
              <tr key={i} data-copy="line" className={clickable ? 'clickable' : undefined} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={() => clickable && click(r)}>
                {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit) : undefined}>{cell(r, c)}</td>)}
              </tr>
            ))}
            {!block.rows.length && <tr><td className="l" colSpan={cols.length}><span className="sa-note">Nothing in scope.</span></td></tr>}
          </tbody>
        </table>
      </div>
      {p.total > p.size && <Pager page={p.page - 1} pageSize={p.size} total={p.total} onPage={(n) => onPage?.(p.id, n + 1, p.order)} />}
    </Section>
  )
}
