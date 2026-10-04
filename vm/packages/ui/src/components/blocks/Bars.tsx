// A bars block: StackedBars (rounded ends, the meaning colours) and — when the server says the rows are parts of one
// whole (`whole: true`) — a Donut beside them in one row, the two pointing at the same slice through lib/highlight. The card's
// hover-only ViewToggle switches between the charts and a table; display only, never sent to the server.

import { useMemo } from 'react'
import { Section } from '../ui/Section'
import ViewToggle, { useView, type ViewOption } from '../ui/ViewToggle'
import Donut, { legendLayout } from '../ui/Donut'
import StackedBars from '../ui/StackedBars'
import { ACCENT, ACTION_PALETTE, paint, ragAccent, STATE_ACCENT, type Accent } from '../../design/index'
import { fmt, short, asNumber, month } from '../../lib/format'
import type { Block, Series } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const SERIES_ACCENT: Accent[] = ['series-1', 'series-2', 'series-3']
const tokenOf = (s: Series, i: number): string => ACCENT[s.state ? STATE_ACCENT[s.state] : SERIES_ACCENT[i % SERIES_ACCENT.length]]
/** A RAG row's own colour — red, amber, green — else the palette, by position. */
const ragPaint = (label: string, i: number) => { const a = ragAccent(label); return a ? paint(a) : ACTION_PALETTE[i % ACTION_PALETTE.length] }
const VIEWS: ViewOption<'charts' | 'table'>[] = [{ value: 'table', icon: 'lucide:table', label: 'Table' }, { value: 'charts', icon: 'lucide:chart-pie', label: 'Charts' }]
const BARS_ONLY: ViewOption<'charts' | 'table'>[] = [{ value: 'table', icon: 'lucide:table', label: 'Table' }, { value: 'charts', icon: 'lucide:chart-bar-big', label: 'Bars' }]
const SHOW = 30

/** Whether a bars block may be drawn as a ring: only when the server says its rows are parts of one whole, with one
 * plain series and at most twelve slices (see DESIGN-SYSTEM.md, "Which block for which data"). */
export const RING_MAX = 12
export function ringAllowed(b: Extract<Block, { type: 'bars' }>): boolean {
  return b.whole === true && b.series.filter((s) => !s.line).length === 1 && b.rows.length <= RING_MAX
}

export default function Bars({ block, onRow, onRowWindow }: { block: Extract<Block, { type: 'bars' }> } & BlockCallbacks) {
  const ring = ringAllowed(block)
  const [view, setView] = useView(`bars.${block.title}`, ['charts', 'table'] as const, 'charts')
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
  const colourOfRow = (r: Record<string, unknown>) => { const i = rows.findIndex((x) => x.label === r.label); return byRag ? ragPaint(String(r.label), i) : ACTION_PALETTE[i % ACTION_PALETTE.length] }
  const series = block.series.map((s, i) => ({ key: s.key, label: s.label, color: tokenOf(s, i), marker: !!s.line }))
  const empty = 'Nothing to chart in this window'

  return (
    <Section icon={ring ? 'lucide:chart-pie' : 'lucide:chart-bar-big'} accent="series-1" title={block.title} note={block.rows.length > SHOW ? `first ${SHOW} of ${block.rows.length}` : undefined}
      hoverActions={<ViewToggle name={`bars.${block.title}`} label="Show as" value={view} onChange={setView} options={ring ? VIEWS : BARS_ONLY} />}>
      {view === 'table' ? (
        <table className="sa-table">
          <thead><tr><th className="l">{label(block.axis) || 'Row'}</th>{block.series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
          <tbody>
            {block.rows.map((r, i) => (
              <tr key={i} data-copy="line" className={move || win ? 'clickable' : undefined} onClick={() => (move || win) && open(r)}>
                <td className="l" title={label(r.label)}>{label(r.label)}</td>
                {block.series.map((s) => <td key={s.key}><span className="sa-figure">{fmt(r.values[s.key], block.unit)}</span></td>)}
              </tr>
            ))}
            {!block.rows.length && <tr><td className="l" colSpan={block.series.length + 1}><span className="sa-note">{empty}</span></td></tr>}
          </tbody>
        </table>
      ) : ring && plain[0] ? (
        <div data-copy="skip" className="sa-chart-pair" data-ring={legendLayout(rows.filter((r) => Number(r[plain[0].key]) > 0).length)}>
          <Donut height={Math.max(240, Math.min(320, rows.length * 34 + 120))} remembers={channel} channel={channel} empty={empty} format={money}
            slices={rows.map((r, i) => ({ name: r.label, value: Math.max(0, Number(r[plain[0].key]) || 0), color: byRag ? ragPaint(r.label, i) : ACTION_PALETTE[i % ACTION_PALETTE.length] }))} onSelect={select} />
          <StackedBars rows={rows} labelKey="label" channel={channel} colorOf={colourOfRow} empty={empty} series={series.filter((s) => !s.marker)} format={(v) => short(v, block.unit)} onSelect={select} />
        </div>
      ) : (
        <div data-copy="skip" className="sa-section__chart">
          <StackedBars rows={rows} labelKey="label" channel={channel} empty={empty} series={series} format={(v) => short(v, block.unit)} onSelect={select} />
        </div>
      )}
    </Section>
  )
}
