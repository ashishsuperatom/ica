// Where you are, at the top of the page: each step of the way (an organisation, a project, a place) a link back to it,
// and — where there are others like it — a switcher to go straight to another. One line; the last step is where you are.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'

export interface CrumbChoice { key: string; label: string; icon?: string; hint?: string; active?: boolean; onClick: () => void }
export interface Crumb { key: string; label: string; icon?: string; onClick?: () => void; /** Others like it, to switch to. */ choices?: CrumbChoice[] }

function Switcher({ crumb }: { crumb: Crumb }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc) }
  }, [open])
  const list = (crumb.choices ?? []).filter((c) => !q || c.label.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="sa-crumbs__switch" ref={box}>
      <button className="sa-crumbs__more" aria-label={`Switch ${crumb.label}`} aria-expanded={open} onClick={() => { setOpen(!open); setQ('') }}><Icon icon="solar:sort-vertical-linear" /></button>
      {open && (
        <div className="sa-crumbs__menu" role="menu">
          {(crumb.choices?.length ?? 0) > 8 && <input id={`crumb-${crumb.key}`} className="sa-input sa-crumbs__find" placeholder="Find…" value={q} autoFocus onChange={(e) => setQ(e.target.value)} />}
          {list.map((c) => (
            <button key={c.key} role="menuitem" className="sa-crumbs__choice" data-active={!!c.active} onClick={() => { setOpen(false); c.onClick() }}>
              {c.icon && <Icon icon={c.icon} />}<span className="sa-crumbs__choice-label">{c.label}</span>{c.hint && <span className="sa-crumbs__hint">{c.hint}</span>}
            </button>
          ))}
          {!list.length && <span className="sa-crumbs__hint">Nothing matches</span>}
        </div>
      )}
    </div>
  )
}

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="sa-crumbs" aria-label="Where you are">
      {items.map((c, i) => {
        const last = i === items.length - 1
        return (
          <span key={c.key} className="sa-crumbs__step" data-current={last}>
            {i > 0 && <Icon icon="solar:alt-arrow-right-linear" className="sa-crumbs__sep" />}
            {c.onClick && !last
              ? <button className="sa-crumbs__link" onClick={c.onClick}>{c.icon && <Icon icon={c.icon} />}<span className="truncate">{c.label}</span></button>
              : <span className="sa-crumbs__here" aria-current={last ? 'page' : undefined}>{c.icon && <Icon icon={c.icon} />}<span className="truncate">{c.label}</span></span>}
            {!!c.choices?.length && <Switcher crumb={c} />}
          </span>
        )
      })}
    </nav>
  )
}
