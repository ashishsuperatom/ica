// Add a filter, in two steps of the Select: first the dimension the capability honours (as a chip), then its
// member — entity dimensions search the graph as you type (app:members, debounced through Select's onQuery),
// flags offer Yes/No, attributes offer the values seen in the answer or what is typed. The is / is not choice sits in
// the member list's head — a modifier lives inside the control it modifies, never between controls.

import { useEffect, useState } from 'react'
import { Icon } from '@iconify/react'
import Select, { type Option } from '@/components/ui/Select'
import { dimensionOf, useApp } from '@/lib/catalog'
import type { Answer, Capability, Member, MemberValue, Op } from '@/lib/wire'
import { MembersCache } from '@/lib/cache'

/** Members seen this page session, per (dimension, typed): shown at once, always asked again (lib/cache). */
const members = new MembersCache<Member>()

/** A filter option is a LABEL: one option per member, whose value carries every key the label is recorded under. The
 * option's id is the keys joined, so two members never collide; the note says when a label is recorded more than once. */
export const optionId = (m: Member) => m.keys.join('\u0000')
export const memberOptions = (matches: Member[]): Array<Option & { member: Member }> => {
  const seen = new Map<string, Member>()
  for (const m of matches) { const id = optionId(m); if (!seen.has(id)) seen.set(id, m) }
  return [...seen.values()].map((m) => ({ value: optionId(m), label: m.label, member: m, ...(m.recorded && m.recorded > 1 ? { note: `recorded ${m.recorded} times` } : {}) }))
}
/** The push for a chosen option: the label once, every key it carries. */
export const pushFor = (dim: string, m: Member, not: boolean): Op => ({ op: 'push', dim, value: m.key, label: m.label, ...(not ? { not: true } : {}) })

/** The values an attribute dimension takes in this answer's tables (a column whose key is the dimension). */
function seen(answer: Answer, dim: string): string[] {
  const out = new Set<string>()
  for (const b of answer.blocks) if (b.type === 'table') for (const r of b.rows) { const v = r[dim]; if (typeof v === 'string' && v.trim()) out.add(v) }
  return [...out].sort()
}

/** is · is not — the modifier of a filter, as a two-way toggle group. */
export function OpToggle({ not, onChange }: { not: boolean; onChange: (not: boolean) => void }) {
  return (
    <span className="sa-toggle" role="radiogroup" aria-label="Include or exclude">
      <button type="button" role="radio" aria-checked={!not} data-on={!not} className="sa-toggle__btn sa-toggle__btn--text" onClick={() => onChange(false)}>is</button>
      <button type="button" role="radio" aria-checked={not} data-on={not} className="sa-toggle__btn sa-toggle__btn--text" onClick={() => onChange(true)}>is not</button>
    </span>
  )
}

export default function FilterAdd({ capability, answer, onPush, disabled }: { capability: Capability; answer: Answer; onPush: (op: Op) => void; disabled: boolean }) {
  const { catalog, client } = useApp()
  const [dim, setDim] = useState('')
  const [not, setNot] = useState(false)
  const [matches, setMatches] = useState<Array<Option & { member: Member }>>([])
  const [loading, setLoading] = useState(false)
  const d = dim ? dimensionOf(catalog, dim) : undefined

  // A dimension whose members the application can give (an entity, or one it marks searchable) is asked as soon as it
  // is chosen — nothing typed shows the first ones — and again as the person types.
  const asks = !!d && (d.kind === 'entity' || !!d.searchable)
  const query = (typed: string) => {
    if (!d || !asks) return
    const seen = members.get(d.key, typed)
    if (seen) setMatches(memberOptions(seen))
    setLoading(!seen)
    client.request({ t: 'app:members', dim: d.key, typed }).then((r) => {
      if (r.t === 'app:members') { members.set(d.key, typed, r.matches); setMatches((cur) => (seen && JSON.stringify(seen) === JSON.stringify(r.matches) ? cur : memberOptions(r.matches))) } else if (!seen) setMatches([])
      setLoading(false)
    }, () => setLoading(false))
  }
  useEffect(() => { setMatches([]); if (asks) query('') }, [dim]) // eslint-disable-line react-hooks/exhaustive-deps

  const push = (value: MemberValue, label: string) => { onPush({ op: 'push', dim, value, label, ...(not ? { not: true } : {}) }); setDim('') }
  const options: Option[] = !d ? [] : d.kind === 'flag' ? [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] : asks ? [...matches, ...seen(answer, d.key).filter((v) => !matches.some((m) => m.value === v || m.label === v)).map((v) => ({ value: v, label: v }))] : seen(answer, d.key).map((v) => ({ value: v, label: v }))
  const choose = (v: string) => {
    if (!v) return
    const m = matches.find((o) => o.value === v)?.member
    if (m) { onPush(pushFor(dim, m, not)); setDim(''); return }
    push(v, options.find((o) => o.value === v)?.label ?? v)
  }

  return (
    <span className="sa-row sa-row--tight">
      <Select variant="chip" label="Filter" value={dim} disabled={disabled || !capability.honours.length} onChange={setDim}
        options={capability.honours.filter((k) => !dimensionOf(catalog, k)?.byOnly).map((k) => { const x = dimensionOf(catalog, k); return { value: k, label: x?.label ?? k, note: x?.means } })}
        placeholder="add" lead={<Icon icon="lucide:filter" />} />
      {d && (
        <Select key={d.key} autoOpen variant="chip" label={not ? `${d.label} is not` : d.label} value="" onChange={choose} options={options}
          head={<OpToggle not={not} onChange={setNot} />}
          placeholder={d.kind === 'flag' ? 'Yes or No' : `a ${d.label.toLowerCase()}`} allowCustom={d.kind === 'attribute'} onQuery={asks ? query : undefined} loading={loading} />
      )}
    </span>
  )
}
