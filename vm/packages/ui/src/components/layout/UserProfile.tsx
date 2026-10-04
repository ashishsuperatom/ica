// Who is signed in, at the foot of the sidebar: an initial, and in the menu the name and email — never an id.

import { useEffect, useRef, useState, type ReactNode } from 'react'

const initialsOf = (name: string) => name.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?'

export default function UserProfile({ name, email, context, showName = false, menu }: { name: string; email?: string; context?: string; showName?: boolean; menu?: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
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
        <div className="sa-menu">
          <div className="sa-menu__head">
            {context && <div className="sa-menu__eyebrow">{context}</div>}
            <div className="sa-menu__title">{name}</div>
            {email && <div className="sa-menu__line">{email}</div>}
          </div>
          {menu}
        </div>
      )}
    </div>
  )
}
