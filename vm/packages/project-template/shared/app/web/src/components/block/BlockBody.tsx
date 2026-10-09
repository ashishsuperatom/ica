// A block's content: its controls (which edit it in place), its answer's blocks, the next moves (each a step taken,
// a child below — destinationOf), and the quiet footer with the notes, the settings used and the span. The one block that is not a
// question — where the numbers come from — draws itself.

import { Icon } from '@iconify/react'
import Controls from './Controls'
import About from './About'
import { Answer, Blocks, BlockView, Skeleton, BeatRows, markdownToHtml, destinationOf } from '@superatom/ui'
import AboutBlock from '@/components/blocks/AboutBlock'
import { dimLabel, useApp } from '@/lib/catalog'
import { useThread, type Node, type Beat } from '@/runtime/thread'
import type { Op, RowMove, Row, WindowKind, SaidBlock as NamedBlock } from '@/lib/wire'

/** A reading on its way: the beats as they arrive, with the seconds each took; before the first, one spinner line. */
function Working({ beats, partial, blocks }: { beats?: Beat[]; partial?: string; blocks?: NamedBlock[] }) {
  // The answer as it comes: each piece the agent says after its answer marker, under the beats, as the reading will read.
  const pieces = partial ? <div className="sa-prose" aria-live="polite" dangerouslySetInnerHTML={{ __html: markdownToHtml(partial.split('\n').filter((l) => !/^:::\S+\s+\S+/.test(l.trim())).join('\n')) }} /> : null
  // A block the answer named shows the moment its line is said: the script wrote the file before the agent named it.
  const early = blocks?.filter((b) => b.block).map((b, i) => <BlockView key={`${i}:${b.marker}`} block={b.block!} />)
  if (beats?.length) return <><div className="sa-card" aria-busy="true" aria-live="polite" aria-label="Working"><BeatRows beats={beats} live />{pieces}</div>{early}</>
  return <>{pieces ?? <div className="sa-row sa-muted" aria-busy="true" style={{ fontSize: 'var(--t-sm)' }}><span className="sa-spinner" /> working…</div>}{early}</>
}

export default function BlockBody({ block }: { block: Node }) {
  const { catalog } = useApp()
  const { open, edit } = useThread()
  const a = block.answer

  if (block.kind === 'said') return block.said ? <Answer markdown={block.said.markdown} blocks={block.said.blocks} calls={block.said.calls} ms={block.said.ms} agent={block.said.agent} beats={block.beats ?? []} /> : block.busy ? <Working beats={block.beats} partial={block.partial} blocks={block.partialBlocks} /> : <div className="sa-alert"><Icon icon="lucide:alert-triangle" /><span className="sa-alert__text">{block.error ?? 'No reading.'}</span></div>
  if (block.about) return <AboutBlock about={block.about} />
  if (!a && block.busy) return (
    <div className="sa-skeleton-block" aria-busy="true" aria-label="Asking">
      <div className="sa-kpi-grid sa-kpi-grid--4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="sa-card sa-skeleton-block__tile"><Skeleton w="60%" h={10} /><Skeleton w="45%" h={20} /><Skeleton w="70%" h={9} /></div>)}
      </div>
      <div className="sa-card sa-skeleton-block__card">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={12} w={`${90 - i * 9}%`} />)}</div>
    </div>
  )
  if (!a) return (
    <div className="sa-alert">
      <Icon icon="lucide:alert-triangle" />
      <span className="sa-alert__text">{block.error ?? 'No reading.'}</span>
      <button className="sa-btn" onClick={() => edit(block.id, [])}>Try again</button>
    </div>
  )

  const onRow = (move: RowMove, row: Row) => {
    const value = row[move.key]
    if (value === null || value === undefined || value === '') return
    const label = typeof row[move.label] === 'string' ? String(row[move.label]) : String(value)
    const more = (move.also ?? []).flatMap((a) => { const v = row[a.key]; return v === null || v === undefined || v === '' ? [] : [{ op: 'push' as const, dim: a.dim, value: String(v), label: typeof row[a.label] === 'string' ? String(row[a.label]) : String(v) }] })
    const ops: Op[] = [...(move.focus ? [{ op: 'focus' as const, on: move.focus }] : []), { op: 'push', dim: move.dim, value: String(value), label }, ...more]
    // A row clicked is a step taken: it opens below, titled with what it narrowed to.
    open(block.id, ops, `${dimLabel(catalog, move.dim)} ${label}`)
  }
  const onRowWindow = (kind: WindowKind, value: string) => {
    if (kind === 'months' && /^\d{4}-\d{2}$/.test(value)) edit(block.id, [{ op: 'window', window: { kind, months: [value] } }])
    if (kind === 'fiscal' && value) edit(block.id, [{ op: 'window', window: { kind, year: value } }])
  }

  return (
    <>
      <Controls block={block} answer={a} onEdit={(ops) => edit(block.id, ops)} />
      <div className={`sa-stack${block.busy ? ' sa-busy' : ''}`}>
        <Blocks blocks={a.blocks} onRow={onRow} onRowWindow={onRowWindow} onPage={(table, page, order) => edit(block.id, [{ op: 'page', block: table, page, ...(order ? { order } : {}) }])} />
        {a.next.length > 0 && (
          <div className="sa-next" aria-label="Next moves" data-copy="skip">
            {a.next.map((n, i) => (
              <button key={i} className="sa-btn sa-btn--pill" title={n.label} onClick={() => (destinationOf(n.ops) === 'new' ? open(block.id, n.ops, n.label) : edit(block.id, n.ops))}><span className="sa-btn__text">{n.label}</span><Icon icon="mdi:arrow-right" className="sa-btn__icon" /></button>
            ))}
          </div>
        )}
        {block.error && <div className="sa-alert"><Icon icon="lucide:alert-triangle" /><span className="sa-alert__text">{block.error}</span></div>}
        <About answer={a} />
      </div>
    </>
  )
}
