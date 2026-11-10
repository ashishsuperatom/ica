// A TREE, PLAIN: one line per row — `[+] 01. TITLE ........ 12` — a row clicked is chosen and opens (or closes) what is
// under it. Children are asked for only when a row is opened, so a graph walked as a tree (one that loops) never unfolds
// by itself; a row marked `again` (already above it in its branch) is shown and does not open.
// AS DEEP AS IT GOES: only the last `depth` levels down to the row chosen are drawn; the parents above fold into one line
// at the top (`[^] 01. A › 01.2. B`), each a way back up. The rows keep their place: only their indent moves.

import { useState, type ReactNode } from 'react'

export interface TreeRow {
  key: string
  title: string
  /** Said at the end of its line, after the dots (how often, how many). */
  end?: string
  /** A word in brackets after its title (stale, platform). */
  badge?: string
  /** Whether it has anything under it (asked for when it is opened). */
  open?: boolean
  /** Already above it in this branch: shown, never opened again. */
  again?: boolean
}

export function Tree({ rows, under, selected, onSelect, empty, depth = 3 }: {
  rows: TreeRow[]
  /** What is under a row, given the keys down to it (its path). */
  under: (key: string, path: string[]) => TreeRow[]
  selected?: string | null
  onSelect?: (key: string, path: string[]) => void
  empty?: ReactNode
  /** How many levels are drawn, down to the row chosen. */
  depth?: number
}) {
  const [opened, setOpened] = useState<Set<string>>(new Set())
  // where one is: the keys down to the row chosen last
  const [at, setAt] = useState<string[]>([])
  const toggle = (id: string) => setOpened((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const choose = (path: string[], r: TreeRow, can: boolean) => { setAt([...path, r.key]); onSelect?.(r.key, path); if (can) toggle([...path, r.key].join('>')) }

  // The parents folded away: those above the last `depth` levels down to where one is — each with its number and row.
  const top = Math.max(0, at.length - depth)
  const above: { row: TreeRow; no: string; path: string[] }[] = []
  let list = rows, number = ''
  for (let i = 0; i < top; i++) {
    const idx = list.findIndex((r) => r.key === at[i])
    if (idx < 0) break
    const no = `${number}${String(idx + 1).padStart(number ? 1 : 2, '0')}`
    above.push({ row: list[idx], no, path: at.slice(0, i) })
    number = `${no}.`
    list = under(at[i], at.slice(0, i + 1))
  }
  const base = above.length ? at.slice(0, above.length) : []

  const draw = (items: TreeRow[], path: string[], prefix: string): ReactNode => items.map((r, i) => {
    const id = [...path, r.key].join('>'), can = !!r.open && !r.again, isOpen = can && opened.has(id)
    const no = `${prefix}${String(i + 1).padStart(prefix ? 1 : 2, '0')}`
    return (
      <li key={id} role="treeitem" aria-expanded={can ? isOpen : undefined} aria-selected={selected === r.key}>
        <button type="button" className="sa-tree__row" data-selected={selected === r.key || undefined} style={{ paddingLeft: `calc(${path.length - base.length} * 4ch + var(--sp-2))` }}
          onClick={() => choose(path, r, can)}>
          <span className="sa-tree__mark">{can ? (isOpen ? '[-]' : '[+]') : '[ ]'}</span>
          <span className="sa-tree__title">{no}. {r.title}{r.badge ? ` [${r.badge}]` : ''}{r.again ? ' (above)' : ''}</span>
          <span className="sa-tree__dots" aria-hidden="true" />
          {r.end && <span className="sa-tree__end">{r.end}</span>}
        </button>
        {isOpen && <ul role="group">{draw(under(r.key, [...path, r.key]), [...path, r.key], `${no}.`)}</ul>}
      </li>
    )
  })
  if (!rows.length) return <div className="sa-tree sa-tree--empty">{empty}</div>
  return (
    <div className="sa-tree">
      {above.length > 0 && <nav className="sa-tree__above" aria-label="Above">
        <button type="button" className="sa-tree__up" title="All of it" onClick={() => setAt([])}>[^]</button>
        {above.map((a, i) => <span key={a.no}>{i > 0 && <span aria-hidden="true"> › </span>}
          <button type="button" className="sa-tree__up" onClick={() => { setAt([...a.path, a.row.key]); onSelect?.(a.row.key, a.path) }}>{a.no}. {a.row.title}</button></span>)}
      </nav>}
      <ul role="tree">{draw(list, base, number)}</ul>
    </div>
  )
}
