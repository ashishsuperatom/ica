// A table on the design system's table: sort marks in the heads, a pager. A table the source pages (`page`) holds one
// page: its pager and its sortable heads ask the source for another page or order. Any other table is sorted and paged
// here, in the browser, and says so when it is sorted. A row with a move opens a child; a
// row whose period is a window narrows the block to it; `rowState` washes the row by its state.

import { useMemo, useState } from 'react'
import { Icon } from '../ui/Icon'
import { Section, Pager } from '../ui/Section'
import { fmt, numeric, asNumber, month } from '../../lib/format'
import type { Block, Column, Row, State } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const PAGE = 50
export function rowStateOf(v: unknown): State | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.toLowerCase()
  if (s === 'ok' || s === 'green') return 'ok'
  if (s === 'warning' || s === 'amber') return 'warning'
  if (s === 'critical' || s === 'red') return 'critical'
  return undefined
}

export default function Table({ block, onRow, onRowWindow, onPage }: { block: Extract<Block, { type: 'table' }> } & BlockCallbacks) {
  if (block.page) return <SourceTable block={block} onRow={onRow} onRowWindow={onRowWindow} onPage={onPage} />
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null)
  const cols: Column[] = block.columns.length ? block.columns : Object.keys(block.rows[0] ?? {}).filter((k) => typeof block.rows[0]?.[k] !== 'object').slice(0, 8).map((k) => ({ key: k, label: k }))
  const rows = useMemo(() => {
    if (!sort) return block.rows
    const { key, dir } = sort
    return [...block.rows].sort((a, b) => {
      const x = a[key], y = b[key]
      const nx = asNumber(x), ny = asNumber(y)
      const c = nx !== null && ny !== null ? nx - ny : String(x ?? '').localeCompare(String(y ?? ''))
      return dir === 'desc' ? -c : c
    })
  }, [block.rows, sort])
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE)
  const onHeader = (c: Column) => { setPage(0); setSort(sort?.key === c.key ? (sort.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' }) }
  const cell = (r: Row, c: Column) => {
    const v = r[c.key]
    if (c.key === block.rowState || (!c.unit && rowStateOf(v) && /rag|state|status/i.test(c.key))) { const s = rowStateOf(v); return s ? <span className="sa-pill" data-state={s}>{String(v)}</span> : fmt(v, c.unit) }
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
    <Section icon="lucide:table" accent="series-1" title={block.title} note={`${block.rows.length} row${block.rows.length === 1 ? '' : 's'}`}
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
            {shown.map((r, i) => (
              <tr key={i} data-copy="line" className={clickable ? 'clickable' : undefined} data-state={block.rowState ? rowStateOf(r[block.rowState]) : undefined} onClick={() => clickable && click(r)}>
                {cols.map((c) => <td key={c.key} className={numeric(c.unit) ? undefined : 'l'} title={typeof r[c.key] === 'string' ? String(r[c.key]) : numeric(c.unit) ? fmt(r[c.key], c.unit) : undefined}>{cell(r, c)}</td>)}
              </tr>
            ))}
            {!block.rows.length && <tr><td className="l" colSpan={cols.length}><span className="sa-note">Nothing in scope.</span></td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length > PAGE && <Pager page={page} pageSize={PAGE} total={rows.length} onPage={setPage} />}
    </Section>
  )
}

/** One page of a table the source reads: the heads that have an `order` sort it there, the pager asks for the next page. */
function SourceTable({ block, onRow, onRowWindow, onPage }: { block: Extract<Block, { type: 'table' }> } & BlockCallbacks) {
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
