// A TABLE AS IT READS IN AN ANSWER — plain: its title, heads in words, a hairline between rows, figures to the right, a
// total row in bold; the first rows only, the rest a click away. Working with it — search, group, every row, its sort — is
// the full table, opened from here (CardView).

import { useState } from 'react'
import { numeric } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import type { TableColumn } from '../../answer/cards'

/** How many rows an answer shows before "Show all". */
export const READING_ROWS = 8

const isTotal = (r: Record<string, unknown>, first?: TableColumn) => !!first && /^(total|subtotal|grand total|all)\b/i.test(String(r[first.key] ?? '').trim())

export function ReadingTable({ title, columns, rows }: { title?: string; columns: TableColumn[]; rows: Record<string, unknown>[] }) {
  const { fmt } = useFormat()
  const [all, setAll] = useState(false)
  const cols: TableColumn[] = columns.length ? columns : Object.keys(rows[0] ?? {}).map((key) => ({ key, label: key }))
  const totals = rows.filter((r) => isTotal(r, cols[0]))
  const body = rows.filter((r) => !isTotal(r, cols[0]))
  const shown = all ? body : body.slice(0, READING_ROWS)
  const cell = (r: Record<string, unknown>, c: TableColumn) => (numeric(c.unit) ? fmt(r[c.key], c.unit, c.scale) : r[c.key] == null ? '' : String(r[c.key]))
  return (
    <div className="sa-readtable">
      {title && <div className="sa-readtable__title">{title}</div>}
      <div className="sa-readtable__scroll">
        <table>
          <thead><tr>{cols.map((c) => <th key={c.key} data-num={numeric(c.unit) || undefined}>{c.label}</th>)}</tr></thead>
          <tbody>
            {shown.map((r, i) => <tr key={i} data-more={i >= READING_ROWS || undefined}>{cols.map((c) => <td key={c.key} data-num={numeric(c.unit) || undefined}>{cell(r, c)}</td>)}</tr>)}
            {totals.map((r, i) => <tr key={`t${i}`} data-total>{cols.map((c) => <td key={c.key} data-num={numeric(c.unit) || undefined}>{cell(r, c)}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
      {body.length > READING_ROWS && <button type="button" className="sa-btn sa-btn--link sa-readtable__more" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${body.length} rows`}</button>}
    </div>
  )
}
