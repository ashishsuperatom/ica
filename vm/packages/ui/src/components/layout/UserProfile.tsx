// Who is signed in, at the foot of the sidebar: an initial, and in the menu the name and email — never an id.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'

const initialsOf = (name: string) => name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

export default function UserProfile({ name, email, context, showName = false, menu }: {
  name: string; email?: string
  /** A line under the name in the menu's head (the organisation, the role). */
  context?: string
  showName?: boolean
  /** MenuItem and MenuRule; a choice closes the menu. */
  menu?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  return (
    <div className="sa-profile" ref={ref}>
      <button onClick={() => setOpen(!open)} className={`sa-profile__btn${showName ? ' sa-profile__btn--wide' : ''}`} title={name} aria-expanded={open}>
        <span className="sa-avatar">{initialsOf(name)}</span>
        {showName && (
          <span className="sa-profile__who">
            <span className="sa-profile__name">{name}</span>
            {email && email !== name && <span className="sa-profile__line">{email}</span>}
          </span>
        )}
      </button>
      {open && (
        <div className="sa-menu sa-menu--person" role="menu" onClick={(e) => { if ((e.target as HTMLElement).closest('[data-menu-close]')) setOpen(false) }}>
          <div className="sa-menu__person">
            <span className="sa-avatar">{initialsOf(name)}</span>
            <span className="sa-menu__who">
              <span className="sa-menu__title" title={name}>{name}</span>
              {(context ?? email) && (context ?? email) !== name && <span className="sa-menu__line" title={context ?? email}>{context ?? email}</span>}
            </span>
          </div>
          {menu}
        </div>
      )}
    </div>
  )
}

/** One choice in a menu: an icon and words. With `sub`, it opens a menu of its own beside it instead. */
export function MenuItem({ icon, label, onClick, sub, tone }: { icon: string; label: ReactNode; onClick?: () => void; sub?: ReactNode; tone?: 'danger' }) {
  const [open, setOpen] = useState(false)
  if (sub) return (
    <div className="sa-menu__subwrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" role="menuitem" className="sa-menu__choice" aria-haspopup="menu" aria-expanded={open} data-open={open} onClick={() => setOpen((o) => !o)}>
        <Icon icon={icon} /><span className="sa-menu__words">{label}</span><Icon icon="solar:alt-arrow-right-linear" className="sa-menu__chev" />
      </button>
      {open && <div className="sa-menu sa-menu--side" role="menu">{sub}</div>}
    </div>
  )
  return <button type="button" role="menuitem" className="sa-menu__choice" data-tone={tone} data-menu-close onClick={onClick}><Icon icon={icon} /><span className="sa-menu__words">{label}</span></button>
}

/** A line between kinds of choices in a menu. */
export function MenuRule() { return <div className="sa-menu__rule" role="separator" /> }
