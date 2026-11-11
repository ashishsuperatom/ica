// The table behind a chart's view menu (useOneView): the same figures the chart draws, a row per label and a column per
// series, written the screen's way and drawn plainly, as an answer's table reads; a row that the chart would open opens
// the same from here.

import { useFormat } from '../../lib/formats'

export interface ChartTableRow { label: string; values: Record<string, unknown>; open?: () => void }

export function ChartTable({ axis, columns, rows, empty }: { axis: string; columns: { key: string; label: string; unit?: string }[]; rows: ChartTableRow[]; empty: string }) {
  const { fmt } = useFormat()
  return (
    <div className="sa-readtable"><div className="sa-readtable__scroll">
      <table>
        <thead><tr><th>{axis || 'Row'}</th>{columns.map((c) => <th key={c.key} data-num>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} data-copy="line" data-open={r.open ? true : undefined} onClick={r.open}>
              <td title={r.label}>{r.label}</td>
              {columns.map((c) => <td key={c.key} data-num>{fmt(r.values[c.key], c.unit)}</td>)}
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={columns.length + 1}><span className="sa-note">{empty}</span></td></tr>}
        </tbody>
      </table>
    </div></div>
  )
}
