// A grid: rows by period, every cell coloured by its state — under (red), over (amber), ok (neutral), none (empty).
// Drawn plainly (a Part, no card); the quiet view button reads the same cells as a plain table — display only.

import { useState } from 'react'
import { Part, Pager } from '../ui/Section'
import { ViewMenu, useView, type ViewOption } from '../ui/ViewToggle'
import { shortDate, month } from '../../lib/format'
import { useFormat } from '../../lib/formats'
import type { Block } from '../../answer/blocks'
import type { BlockCallbacks } from './index'

const PAGE = 40
const VIEWS: ViewOption<'grid' | 'table'>[] = [{ value: 'table', icon: 'lucide:table', label: 'Table' }, { value: 'grid', icon: 'lucide:grid-3x3', label: 'Grid' }]
const period = (p: string) => (/^\d{4}-\d{2}$/.test(p) ? month(p) : /^\d{4}-\d{2}-\d{2}$/.test(p) ? shortDate(p) : p)

export default function Grid({ block, onRow, onPage }: { block: Extract<Block, { type: 'grid' }> } & BlockCallbacks) {
  const { fmt, short } = useFormat()
  const [page, setPage] = useState(0)
  const [view, setView] = useView(`grid.${block.title}`, ['grid', 'table'] as const, 'grid')
  // A grid the source pages holds one page: all its rows show, and the pager asks for the next one.
  const p = block.page
  const rows = p ? block.rows : block.rows.slice(page * PAGE, page * PAGE + PAGE)
  const hasGroup = block.rows.some((r) => r.group)
  const plain = view === 'table'
  return (
    <Part title={block.title} note={block.threshold !== undefined && block.threshold !== null ? `${block.says ? `${block.says} · ` : ''}threshold ${fmt(block.threshold, block.unit)}` : undefined}
      tools={<ViewMenu label="Show as" value={view} onChange={setView} options={VIEWS} />}>
      <div className="sa-section__scroll sa-scroll">
        <table className={`sa-table${plain ? '' : ' sa-table--grid'}`}>
          <thead>
            <tr>
              <th className="l sticky"></th>
              {hasGroup && <th className="l">Group</th>}
              {block.periods.map((p) => <th key={p} className="c">{period(p)}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const byPeriod = new Map(r.cells.map((c) => [c.period, c]))
              return (
                <tr key={r.key} data-copy="line" className={block.rowMove ? 'clickable' : undefined} onClick={() => block.rowMove && onRow?.(block.rowMove, { key: r.key, label: r.label, group: r.group })}>
                  <td className="l sticky name" title={r.label}>{r.label}</td>
                  {hasGroup && <td className="l sa-muted" title={r.group}>{r.group ?? '—'}</td>}
                  {block.periods.map((p) => {
                    const c = byPeriod.get(p)
                    const state = c?.state ?? 'none'
                    return <td key={p} className={plain ? undefined : 'cell'} data-state={plain ? undefined : state} title={c ? `${period(p)}: ${fmt(c.value, block.unit)} (${state})` : period(p)}>{c && state !== 'none' ? (plain ? fmt(c.value, block.unit) : short(c.value, block.unit)) : '·'}</td>
                  })}
                </tr>
              )
            })}
            {!block.rows.length && <tr><td className="l" colSpan={block.periods.length + 1}><span className="sa-note">Nothing in scope.</span></td></tr>}
          </tbody>
        </table>
      </div>
      {p ? (p.total > p.size && <Pager page={p.page - 1} pageSize={p.size} total={p.total} onPage={(n) => onPage?.(p.id, n + 1, p.order)} />)
        : block.rows.length > PAGE && <Pager page={page} pageSize={PAGE} total={block.rows.length} onPage={setPage} />}
    </Part>
  )
}
