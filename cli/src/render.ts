// How sacli shows things to a person: a session's thread, an answer card, the actions on offer. --json skips all this.

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length))
// A cell may carry its own words beside its value ({ value, display }): the words are what is shown.
const cell = (v: unknown): string => v == null ? '' : typeof v === 'number' ? v.toLocaleString('en-US') : typeof v === 'object' ? ('display' in (v as any) ? String((v as any).display) : 'value' in (v as any) ? cell((v as any).value) : JSON.stringify(v)) : String(v)

export function table(columns: string[], rows: unknown[][], max = 20): string {
  const shown = rows.slice(0, max).map((r) => r.map(cell))
  const w = columns.map((c, i) => Math.min(40, Math.max([...c].length, ...shown.map((r) => [...(r[i] ?? '')].length))))
  const line = (r: string[]) => r.map((c, i) => pad(c.length > w[i] ? c.slice(0, w[i] - 1) + '…' : c, w[i])).join('  ').trimEnd()
  return [line(columns), w.map((n) => '─'.repeat(n)).join('  '), ...shown.map(line), ...(rows.length > max ? [`… ${rows.length - max} more rows`] : [])].join('\n')
}

/** An answer card (clients/protocol.ts Answer) as text: its prose, then each section. */
export function card(c: any): string {
  if (!c) return ''
  const out: string[] = []
  if (c.answer) out.push(String(c.answer))
  for (const s of c.sections ?? []) {
    if (s.kind === 'table') out.push([s.title ? `\n${s.title}` : '', table((s.columns ?? []).map((x: any) => typeof x === 'string' ? x : x.label), s.rows ?? [])].filter(Boolean).join('\n'))
    else if (s.body) out.push(String(s.body))
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
  if (m.actions?.length) out.push(`\nactions: ${m.actions.map((a: any) => `${a.label} (${a.intent.call ? `--call ${a.intent.call.package}.${a.intent.call.fn}` : `--act ${a.intent.action.package}.${a.intent.action.id}`})`).join(' · ')}`)
  if (m.result?.stale) out.push('\n(a newer intent was applied; this one was dropped)')
  return out.join('\n')
}
