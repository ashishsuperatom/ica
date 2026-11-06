// A TABLE AS IT READS IN AN ANSWER — plain: its title, heads in words, a hairline between rows, figures to the right, a
// total row in bold; the first rows only, the rest a click away. Working with it — search, group, every row, its sort — is
// the full table, opened from here (CardView).
//
// WIDE DATA STAYS READABLE: a row is one line (long text cut, whole on hover); a head wraps to two lines at most, so the
// figures set the widths; wider than the page, it scrolls sideways with its first column held and a fade where more is.

import { useEffect, useRef, useState } from 'react'
import { numeric } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import type { TableColumn } from '../../answer/cards'

/** How many rows an answer shows before "Show all". */
export const READING_ROWS = 8

/** Text longer than this is cut in a cell (whole on hover). */
const CELL_CHARS = 30
/** A head's least width: half its words' length, so it wraps to two lines at most. */
const headWidth = (label: string) => `${Math.min(20, Math.max(4, Math.ceil(label.length / 2) + 1))}ch`

const isTotal = (r: Record<string, unknown>, first?: TableColumn) => !!first && /^(total|subtotal|grand total|all)\b/i.test(String(r[first.key] ?? '').trim())

export function ReadingTable({ title, columns, rows }: { title?: string; columns: TableColumn[]; rows: Record<string, unknown>[] }) {
  const { fmt } = useFormat()
  const [all, setAll] = useState(false)
  const cols: TableColumn[] = columns.length ? columns : Object.keys(rows[0] ?? {}).map((key) => ({ key, label: key }))
  const totals = rows.filter((r) => isTotal(r, cols[0]))
  const body = rows.filter((r) => !isTotal(r, cols[0]))
  const shown = all ? body : body.slice(0, READING_ROWS)
  const cell = (r: Record<string, unknown>, c: TableColumn) => (numeric(c.unit) ? fmt(r[c.key], c.unit, c.scale) : r[c.key] == null ? '' : String(r[c.key]))
  const td = (r: Record<string, unknown>, c: TableColumn) => {
    const v = cell(r, c), num = numeric(c.unit)
    return <td key={c.key} data-num={num || undefined}>{!num && v.length > CELL_CHARS ? <span className="sa-readtable__cut" title={v}>{v}</span> : v}</td>
  }
  // More to the right than shows: a fade at the edge says so (gone once scrolled to the end).
  const scroller = useRef<HTMLDivElement | null>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = scroller.current; if (!el) return
    const check = () => setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 2)
    check()
    const ro = new ResizeObserver(check); ro.observe(el)
    el.addEventListener('scroll', check, { passive: true })
    return () => { ro.disconnect(); el.removeEventListener('scroll', check) }
  }, [])
  return (
    <div className="sa-readtable">
      {title && <div className="sa-readtable__title">{title}</div>}
      <div className="sa-readtable__frame" data-more={more || undefined}><div className="sa-readtable__scroll" ref={scroller}>
        <table>
          <thead><tr>{cols.map((c) => <th key={c.key} data-num={numeric(c.unit) || undefined} style={{ minWidth: headWidth(String(c.label ?? c.key)) }}><span className="sa-readtable__head" title={String(c.label ?? c.key)}>{c.label}</span></th>)}</tr></thead>
          <tbody>
            {shown.map((r, i) => <tr key={i} data-more={i >= READING_ROWS || undefined}>{cols.map((c) => td(r, c))}</tr>)}
            {totals.map((r, i) => <tr key={`t${i}`} data-total>{cols.map((c) => td(r, c))}</tr>)}
          </tbody>
        </table>
      </div></div>
      {body.length > READING_ROWS && <button type="button" className="sa-btn sa-btn--link sa-readtable__more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${body.length} rows`}</button>}
    </div>
  )
}
