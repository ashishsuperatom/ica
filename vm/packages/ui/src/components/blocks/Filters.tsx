// THE FILTER ROW of a step — one system for every program, drawn by the platform from the filters a program declares
// (docs/program-contract.md "Filters"), never laid out by the program. Each filter sits in a slot of the row's grid —
// small, medium or large, never a width of its own — as a dropdown with a search box; its choices are the ones the
// program's options function computed from the data in scope, each saying how many things it holds and their amount
// ("776 SKUs · 14.78 Cr"), so no choice can give an empty result. "Fewer / More", "Break down by" and "Clear all" end the
// same row. A filter narrows the view it is on: every change is one intent to the current block (rule 9 for the
// several-choice ones: a draft, committed once on close).

import { useRef, useState } from 'react'
import Select from '../ui/Select'
import MultiSelect from '../ui/MultiSelect'
import { useDraft } from '../../lib/draft'
import { useFormat } from '../../lib/formats'
import { sendIntent } from '../../intent'
import type { Op } from '@superatom/platform-types'
import type { Block, FilterRow } from '../../answer/blocks'

/** How many filters the row shows before "More" (a filter with a choice in force always shows). */
export const FILTERS_SHOWN = 4

/** What a choice holds, in words: its count and, when it has one, its amount. */
export function choiceNote(c: FilterRow['choices'][number], f: Pick<FilterRow, 'noun' | 'unit'>, fmt: (v: unknown, unit?: string) => string): string {
  const [one, many] = f.noun ?? ['item', 'items']
  const count = `${fmt(c.count, 'count')} ${c.count === 1 ? one : many}`
  return c.amount !== undefined ? `${count} · ${fmt(c.amount, f.unit)}` : count
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
    <div ref={box} className="sa-filters" role="group" aria-label="Filters" data-copy="skip">
      {shown.map((f) => <FilterSlot key={f.path} f={f} onChange={(v) => send([{ op: 'set', path: f.path, value: f.many ? v : (v[0] ?? null) }])} />)}
      <div className="sa-filters__end">
        {(hidden > 0 || more) && <button type="button" className="sa-btn sa-btn--link" aria-expanded={more} onClick={() => setMore(!more)}>{more ? 'Fewer' : `More (${hidden})`}</button>}
        {b && <Select variant="chip" label={b.label} value={b.value ?? ''} options={b.choices} emptyLabel="Not broken down" placeholder="none"
          onChange={(v: string) => send([{ op: 'set', path: b.path, value: v || null }])} />}
        {cleared.length > 0 && <button type="button" className="sa-btn sa-btn--link" onClick={() => send(cleared)}>Clear all</button>}
      </div>
    </div>
  )
}

/** One filter in its slot: its name above, the dropdown beneath — one choice, or several committed on close. */
function FilterSlot({ f, onChange }: { f: FilterRow; onChange: (v: string[]) => void }) {
  const { fmt } = useFormat()
  const options = f.choices.map((c) => ({ value: c.value, label: c.label, note: choiceNote(c, f, fmt) }))
  return (
    <div className="sa-filter" data-size={f.size}>
      <span className="sa-filter__label" title={f.label}>{f.label}</span>
      {f.many ? <ManyChoice f={f} options={options} onChange={onChange} />
        : <Select variant="field" label={f.label} value={f.value[0] ?? ''} options={options} emptyLabel="All" placeholder="All" onChange={(v: string) => onChange(v ? [v] : [])} />}
    </div>
  )
}

function ManyChoice({ f, options, onChange }: { f: FilterRow; options: { value: string; label: string; note: string }[]; onChange: (v: string[]) => void }) {
  const d = useDraft<string[]>(f.value, onChange)
  return <MultiSelect variant="field" label={f.label} noun={f.noun ?? ['item', 'items']} allLabel="All" value={d.value} options={options} onChange={d.set} onOpen={d.start} onClose={d.close} />
}
