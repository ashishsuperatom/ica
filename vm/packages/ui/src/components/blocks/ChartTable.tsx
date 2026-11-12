// The table behind a chart's view menu (useOneView): the same figures the chart draws, a row per label and a column per
// series, written the screen's way and drawn plainly, as an answer's table reads; a row that the chart would open opens
// the same from here. Like any table on a step it opens full screen for analysis (useChartTable: its expand button for
// the part's heading, the overlay beside it).

import { useState, type ReactNode } from 'react'
import { useFormat } from '../../lib/formats'
import { AnalysisTable, ExpandButton, FullScreen } from './Analysis'
import type { Column, Row } from '../../answer/blocks'

export interface ChartTableRow { label: string; values: Record<string, unknown>; open?: () => void }
type ChartTableProps = { axis: string; columns: { key: string; label: string; unit?: string }[]; rows: ChartTableRow[]; empty: string }

export function ChartTable({ axis, columns, rows, empty }: ChartTableProps) {
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

/** A chart's table view with its way to full screen: `body` is drawn in the part, `tool` at the end of its heading. */
export function useChartTable(title: string, props: ChartTableProps): { body: ReactNode; tool: ReactNode } {
  const { fmt } = useFormat()
  const [full, setFull] = useState(false)
  const close = () => setFull(false)
  const cols: Column[] = [{ key: '__label', label: props.axis || 'Row', unit: 'text' }, ...props.columns.map((c) => ({ key: c.key, label: c.label, unit: c.unit ?? 'count' }))]
  const body = (<>
    <ChartTable {...props} />
    {full && (
      <FullScreen title={title} onClose={close}>
        <AnalysisTable columns={cols} rows={props.rows.map((r, i): Row => ({ ...r.values, __label: r.label, __i: i }))}
          cell={(r, c) => (c.key === '__label' ? String(r.__label ?? '') : fmt(r[c.key], c.unit))} text={(r, c) => (c.key === '__label' ? String(r.__label ?? '') : fmt(r[c.key], c.unit))}
          onRow={props.rows.some((r) => r.open) ? (r) => { const open = props.rows[Number(r.__i)]?.open; if (open) { close(); open() } } : undefined} />
      </FullScreen>
    )}
  </>)
  return { body, tool: <ExpandButton onExpand={() => setFull(true)} /> }
}
