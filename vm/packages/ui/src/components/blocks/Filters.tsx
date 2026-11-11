// THE FILTER ROW of a step — one system for every program, drawn by the platform from the filters a program declares
// (docs/program-contract.md "Filters"), never laid out by the program. Each filter is a PILL with its name inside —
// "Category  All ⌄", a chosen one tinted — opening a dropdown with a search box ("Find a category"); its choices are the
// ones the program's options function computed from the data in scope, each with how many things it holds and their
// amount, right-aligned ("776 SKUs   ₹14.78 Cr"), so no choice can give an empty result. A few pills sit side by side at
// their own width; more than that wrap into rows of equal slots on one grid (small one slot, medium two, large three).
// "Fewer / More", "Break down by" and "Clear all" end the same row. A filter narrows the view it is on: every change is one intent to the current block (rule 9 for the
// several-choice ones: a draft, committed once on close).

import { useRef, useState } from 'react'
import Select from '../ui/Select'
import MultiSelect from '../ui/MultiSelect'
import { useDraft } from '../../lib/draft'
import { useFormat } from '../../lib/formats'
import { sendIntent } from '../../intent'
import type { Op } from '@superatom/platform-types'
import type { Block, FilterRow } from '../../answer/blocks'

/** How many filters the row shows before "More" (a filter with a choice in force always shows). Up to this many, the
 *  pills sit side by side at their own width; more (after "More") wrap into the grid's equal slots. */
export const FILTERS_SHOWN = 5

/** What a choice holds, in words: its count and, when it has one, its amount. */
export function choiceNote(c: FilterRow['choices'][number], f: Pick<FilterRow, 'noun' | 'unit'>, fmt: (v: unknown, unit?: string) => string): string {
  const [one, many] = f.noun ?? ['item', 'items']
  const count = `${fmt(c.count, 'count')} ${c.count === 1 ? one : many}`
  return c.amount !== undefined ? `${count} · ${fmt(c.amount, f.unit)}` : count
}

/** What a choice holds, as the dropdown's two right-aligned columns: its count, and its amount when it has one. */
export function choiceCells(c: FilterRow['choices'][number], f: Pick<FilterRow, 'noun' | 'unit'>, fmt: (v: unknown, unit?: string) => string): string[] {
  const [one, many] = f.noun ?? ['item', 'items']
  return [`${fmt(c.count, 'count')} ${c.count === 1 ? one : many}`, ...(c.amount !== undefined ? [fmt(c.amount, f.unit)] : [])]
}

/** The filters the row shows: the first few, and any with a choice in force; all of them once "More" is chosen. */
export function shownFilters(filters: FilterRow[], more: boolean): FilterRow[] {
  return more ? filters : filters.filter((f, i) => i < FILTERS_SHOWN || f.value.length > 0)
}

/** The ops that clear every filter in force: one choice back to none (all), several back to an empty list. */
export function clearOps(filters: FilterRow[]): Op[] {
  return filters.filter((f) => f.value.length).map((f) => ({ op: 'set' as const, path: f.path, value: f.many ? [] : null }))
}

export default function Filters({ block }: { block: Extract<Block, { type: 'filters' }> }) {
  const box = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  const send = (ops: Op[]) => { if (box.current && ops.length) sendIntent(box.current, { ops, to: 'current' }) }
  const shown = shownFilters(block.filters, more)
  const hidden = block.filters.length - shown.length
  const cleared = clearOps(block.filters)
  const b = block.breakdown
  if (!block.filters.length && !b) return null
  return (
    <div ref={box} className="sa-filters" data-layout={shown.length > FILTERS_SHOWN ? 'grid' : 'row'} role="group" aria-label="Filters" data-copy="skip">
      {shown.map((f) => <FilterSlot key={f.path} f={f} onChange={(v) => send([{ op: 'set', path: f.path, value: f.many ? v : (v[0] ?? null) }])} />)}
      {(hidden > 0 || more) && <button type="button" className="sa-btn sa-btn--link sa-filters__more" aria-expanded={more} onClick={() => setMore(!more)}>{more ? '— Fewer' : `+ More (${hidden})`}</button>}
      {b && <div className="sa-filter" data-size="small"><Select variant="pill" label={b.label} value={b.value ?? ''} options={b.choices} emptyLabel="Not broken down" placeholder="—" find="Find a breakdown"
        onChange={(v: string) => send([{ op: 'set', path: b.path, value: v || null }])} /></div>}
      {cleared.length > 0 && <button type="button" className="sa-btn sa-btn--link sa-filters__clear" onClick={() => send(cleared)}>Clear all</button>}
    </div>
  )
}

/** One filter: a pill with its name inside, in its slot — one choice, or several committed on close. */
function FilterSlot({ f, onChange }: { f: FilterRow; onChange: (v: string[]) => void }) {
  const { fmt } = useFormat()
  const [, many] = f.noun ?? ['item', 'items']
  const options = f.choices.map((c) => ({ value: c.value, label: c.label, cells: choiceCells(c, f, fmt), search: choiceNote(c, f, fmt) }))
  const find = `Find a ${f.label.toLowerCase()}`
  return (
    <div className="sa-filter" data-size={f.size}>
      {f.many ? <ManyChoice f={f} options={options} find={find} onChange={onChange} />
        : <Select variant="pill" label={f.label} value={f.value[0] ?? ''} options={options} emptyLabel={`All ${many}`} placeholder="All" find={find} onChange={(v: string) => onChange(v ? [v] : [])} />}
    </div>
  )
}

function ManyChoice({ f, options, find, onChange }: { f: FilterRow; options: { value: string; label: string; cells: string[]; search: string }[]; find: string; onChange: (v: string[]) => void }) {
  const d = useDraft<string[]>(f.value, onChange)
  const noun = f.noun ?? ['item', 'items']
  return <MultiSelect variant="pill" label={f.label} noun={noun} allLabel={`All ${noun[1]}`} find={find} value={d.value} options={options} onChange={d.set} onOpen={d.start} onClose={d.close} />
}
