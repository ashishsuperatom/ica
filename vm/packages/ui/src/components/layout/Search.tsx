// Search, everywhere on ⌘K (Ctrl-K): one field over what the screen offers — its conversations, its places — the
// matches listed as you type, ↑ ↓ to move, Enter to open, Esc to close.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'

export interface SearchItem { key: string; label: string; sub?: string; icon?: string; group?: string; onSelect: () => void }

/** ⌘K / Ctrl-K opens it from anywhere on the page. */
export function useSearchKey(open: () => void) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open() } }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open])
}

export default function Search({ items, placeholder = 'Search…', onClose }: { items: SearchItem[]; placeholder?: string; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((i) => words.every((w) => `${i.label} ${i.sub ?? ''}`.toLowerCase().includes(w))).slice(0, 50)
  }, [items, q])
  useEffect(() => setAt(0), [q])
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-at="${at}"]`)?.scrollIntoView({ block: 'nearest' }) }, [at])
  const pick = (i: SearchItem | undefined) => { if (!i) return; onClose(); i.onSelect() }
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((n) => Math.min(n + 1, shown.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((n) => Math.max(n - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[at]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  let last: string | undefined
  return (
    <div className="sa-search" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sa-search__box" role="dialog" aria-modal="true" aria-label="Search">
        <div className="sa-search__field"><Icon icon="solar:magnifer-linear" />
          <input id="sa-search-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keys} placeholder={placeholder} aria-label="Search" />
          <kbd className="sa-search__kbd">Esc</kbd>
        </div>
        <div className="sa-search__list" ref={list} role="listbox">
          {shown.map((i, n) => {
            const head = i.group && i.group !== last ? i.group : null
            last = i.group
            return (
              <div key={i.key}>
                {head && <div className="sa-label sa-search__group">{head}</div>}
                <button type="button" role="option" aria-selected={n === at} data-at={n} data-on={n === at} className="sa-search__item" onMouseEnter={() => setAt(n)} onClick={() => pick(i)}>
                  <Icon icon={i.icon ?? 'solar:chat-round-line-linear'} /><span className="sa-search__label">{i.label}</span>{i.sub && <span className="sa-search__sub">{i.sub}</span>}
                </button>
              </div>
            )
          })}
          {!shown.length && <p className="sa-search__none">Nothing matches “{q}”.</p>}
        </div>
      </div>
    </div>
  )
}
