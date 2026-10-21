// How sacli shows things to a person: a session's thread, an answer card, the options on offer. --json skips all this.
import { partsOf, type Answer } from '../../clients/protocol.ts'

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length))
// A cell may carry its own words beside its value ({ value, display }): the words are what is shown.
const cell = (v: unknown): string => v == null ? '' : typeof v === 'number' ? v.toLocaleString('en-US') : typeof v === 'object' ? ('display' in (v as any) ? String((v as any).display) : 'value' in (v as any) ? cell((v as any).value) : JSON.stringify(v)) : String(v)

export function table(columns: string[], rows: unknown[][], max = 20): string {
  const shown = rows.slice(0, max).map((r) => r.map(cell))
  const w = columns.map((c, i) => Math.min(40, Math.max([...c].length, ...shown.map((r) => [...(r[i] ?? '')].length))))
  const line = (r: string[]) => r.map((c, i) => pad(c.length > w[i] ? c.slice(0, w[i] - 1) + '…' : c, w[i])).join('  ').trimEnd()
  return [line(columns), w.map((n) => '─'.repeat(n)).join('  '), ...shown.map(line), ...(rows.length > max ? [`… ${rows.length - max} more rows`] : [])].join('\n')
}

/** An answer (clients/protocol.ts Answer) as text: its words and its cards in the order written, each card a table of
 *  its rows as the web shows them; the time it covers first. */
export function card(a: Answer | null | undefined): string {
  if (!a) return ''
  const out: string[] = []
  if (a.periods?.length) out.push(`Period: ${a.periods.map((p) => `${p.label}${p.detail ? ` — ${p.detail}` : ''}`).join(' · ')}`)
  for (const p of partsOf(a)) {
    if ('text' in p) out.push(p.text)
    else if (!p.card) out.push(`(a ${p.kind === 'table' ? 'table' : 'part'} that could not be shown)`)
    else out.push([p.card.title ?? '', table(p.card.columns.map((c) => c.label), p.card.text)].filter(Boolean).join('\n'))
  }
  return out.join('\n\n')
}

/** A session view: the thread down to the current block, each block's answer, and what can be done next. */
export function sessionView(m: any): string {
  const v = m.view
  if (!v) return ''
  const path: string[] = []
  for (let b: string | null = v.leaf; b; b = v.blocks.find((x: any) => x.id === b)?.parent ?? null) path.unshift(b)
  const out = [`session ${v.id} · agent ${v.agent} · ${v.blocks.length} block${v.blocks.length === 1 ? '' : 's'}`]
  for (const id of path) {
    const b = v.blocks.find((x: any) => x.id === id)
    const siblings = v.blocks.filter((x: any) => x.parent === b.parent)
    out.push(`\n── ${id}${id === v.leaf ? ' (current)' : ''}${siblings.length > 1 ? ` · branch ${siblings.indexOf(b) + 1} of ${siblings.length}` : ''}`)
    out.push(b.answer && m.cards?.[b.answer] ? card(m.cards[b.answer]) : '(nothing shown yet — run it)')
  }
  // the options at the current step, each with the intent that takes it
  const how = (i: any) => [...(i.ops ?? []).map((op: any) => `--${op.op} ${op.path}${'value' in op ? `=${JSON.stringify(op.value)}` : ''}`), ...(i.call ? [`--call ${i.call.package}.${i.call.fn}`, ...Object.entries(i.call.params ?? {}).map(([k, v]) => `--param ${k}=${JSON.stringify(v)}`)] : []), `--to ${i.to}`].join(' ')
  if (m.options?.length) out.push(`\noptions:\n${m.options.map((o: any) => `  ${o.label}${o.why ? ` — ${o.why}` : ''}\n    sacli session intent ${m.view?.id ?? '<session>'} ${how(o.intent)}`).join('\n')}`)
  if (m.result?.stale) out.push('\n(a newer intent was applied; this one was dropped)')
  return out.join('\n')
}
