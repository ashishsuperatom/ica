// A bars block, drawn plainly as an answer's chart reads (a Part: its heading, one line, the bars — no card), ONE VIEW AT
// A TIME (useOneView): it opens on its bars (StackedBars: rounded ends, the meaning colours); its table, and a ring when
// the server says the rows are parts of one whole (`whole: true`), wait behind the quiet view button — never beside the
// bars. Display only, never sent to the server.

import { useMemo } from 'react'
import { Part } from '../ui/Section'
import { useOneView, type ViewOption } from '../ui/ViewToggle'
import Donut from '../ui/Donut'
import StackedBars from '../ui/StackedBars'
import { useChartTable } from './ChartTable'
import { ACCENT, ACTION_PALETTE, paint, ragAccent, STATE_ACCENT, type Accent } from '../../design/index'
import { asNumber, month } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import type { Block, Series } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const SERIES_ACCENT: Accent[] = ['series-1', 'series-2', 'series-3']
const tokenOf = (s: Series, i: number): string => ACCENT[s.state ? STATE_ACCENT[s.state] : SERIES_ACCENT[i % SERIES_ACCENT.length]]
/** A RAG row's own colour — red, amber, green — else the palette, by position. */
const ragPaint = (label: string, i: number) => { const a = ragAccent(label); return a ? paint(a) : ACTION_PALETTE[i % ACTION_PALETTE.length] }
const BARS: ViewOption<'bars' | 'ring'> = { value: 'bars', icon: 'lucide:chart-bar-big', label: 'Bars' }
const RING: ViewOption<'bars' | 'ring'> = { value: 'ring', icon: 'lucide:chart-pie', label: 'Ring' }
const SHOW = 30

/** Whether a bars block may be drawn as a ring: only when the server says its rows are parts of one whole, with one
 * plain series and at most twelve slices (see DESIGN-SYSTEM.md, "Which block for which data"). */
export const RING_MAX = 12
export function ringAllowed(b: Extract<Block, { type: 'bars' }>): boolean {
  return b.whole === true && b.series.filter((s) => !s.line).length === 1 && b.rows.length <= RING_MAX
}

export default function Bars({ block, onRow, onRowWindow }: { block: Extract<Block, { type: 'bars' }> } & BlockCallbacks) {
  const { fmt, short } = useFormat()
  const ring = ringAllowed(block)
  const [view, toggle] = useOneView(`bars.${block.title}`, ring ? [BARS, RING] : [BARS])
  const plain = block.series.filter((s) => !s.line)
  const label = (l: string) => month(l)
  const money = (v: number) => fmt(v, block.unit)
  const move = block.rowMove
  const rowOf = (r: (typeof block.rows)[number]) => ({ ...(r.fields ?? {}), key: r.key, label: r.label, group: r.group })
  // A bar opens what its row names: a filter (rowMove), or a window — a year, a month (rowWindow).
  const win = block.rowWindow
  const open = (r: (typeof block.rows)[number]) => { if (win) { const v = win.key === 'key' ? r.key : r.fields?.[win.key]; if (v) onRowWindow?.(win.kind, v) } else if (move) onRow?.(move, rowOf(r)) }
  const select = move || win ? (name: string) => { const r = block.rows.find((x) => label(x.label) === name); if (r) open(r) } : undefined
  const channel = `bars.${block.title}`
  const rows = useMemo<Array<Record<string, unknown> & { label: string }>>(() => block.rows.slice(0, SHOW).map((r) => ({ ...Object.fromEntries(block.series.map((s) => [s.key, asNumber(r.values[s.key]) ?? 0])), label: label(r.label) })), [block])
  const byRag = block.axis === 'rag'
  // Parts of one whole keep one colour per row in both pictures, so the ring and the bars read alike.
  const colourOfRow = (r: Record<string, unknown>) => { const i = rows.findIndex((x) => x.label === r.label); return byRag ? ragPaint(String(r.label), i) : ACTION_PALETTE[i % ACTION_PALETTE.length] }
  const series = block.series.map((s, i) => ({ key: s.key, label: s.label, color: tokenOf(s, i), marker: !!s.line }))
  const empty = 'Nothing to chart in this window'

  const table = useChartTable(block.title, { axis: label(block.axis), empty: empty, columns: block.series.map((s) => ({ key: s.key, label: s.label, unit: block.unit })), rows: block.rows.map((r) => ({ label: label(r.label), values: r.values, ...(move || win ? { open: () => open(r) } : {}) })) })
  return (
    <Part title={block.title} note={view !== 'table' && block.rows.length > SHOW ? `${block.says ? `${block.says} · ` : ''}first ${SHOW} of ${block.rows.length}` : undefined} tools={<>{view === 'table' && table.tool}{toggle}</>}>
      {view === 'table' ? (
        table.body
      ) : view === 'ring' && ring && plain[0] ? (
        <div data-copy="skip" className="sa-part__chart">
          <Donut height={Math.max(240, Math.min(320, rows.length * 34 + 120))} remembers={channel} channel={channel} empty={empty} format={money}
            slices={rows.map((r, i) => ({ name: r.label, value: Math.max(0, Number(r[plain[0].key]) || 0), color: byRag ? ragPaint(r.label, i) : ACTION_PALETTE[i % ACTION_PALETTE.length] }))} onSelect={select} />
        </div>
      ) : (
        <div data-copy="skip" className="sa-part__chart">
          <StackedBars rows={rows} labelKey="label" channel={channel} empty={empty} series={ring ? series.filter((s) => !s.marker) : series} format={(v) => short(v, block.unit)} onSelect={select} {...(ring || block.colours === 'rows' ? { colorOf: colourOfRow } : {})} />
        </div>
      )}
    </Part>
  )
}
