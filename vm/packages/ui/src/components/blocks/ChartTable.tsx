// The table one click away from a chart (useOneView): the same figures the chart draws, a row per label and a column per
// series, written the screen's way; a row that the chart would open opens the same from here.

import { useFormat } from '../../lib/formats'

export interface ChartTableRow { label: string; values: Record<string, unknown>; open?: () => void }

export function ChartTable({ axis, columns, rows, empty }: { axis: string; columns: { key: string; label: string; unit?: string }[]; rows: ChartTableRow[]; empty: string }) {
  const { fmt } = useFormat()
  return (
    <div className="sa-section__scroll sa-section__scroll--tall sa-scroll">
      <table className="sa-table">
        <thead><tr><th className="l">{axis || 'Row'}</th>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} data-copy="line" className={r.open ? 'clickable' : undefined} onClick={r.open}>
              <td className="l" title={r.label}>{r.label}</td>
              {columns.map((c) => <td key={c.key}><span className="sa-figure">{fmt(r.values[c.key], c.unit)}</span></td>)}
            </tr>
          ))}
          {!rows.length && <tr><td className="l" colSpan={columns.length + 1}><span className="sa-note">{empty}</span></td></tr>}
        </tbody>
      </table>
    </div>
  )
}
