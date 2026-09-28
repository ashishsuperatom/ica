// Who is signed in, at the foot of the sidebar. The avatar is an initial; the menu names the person.

import { useEffect, useRef, useState } from 'react'
import { viewer } from '@/lib/session'
import { useApp } from '@/lib/catalog'

export default function UserProfile({ showName = false }: { showName?: boolean }) {
  const project = useApp().catalog.project.name
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const user = viewer()

  useEffect(() => {
    if (!isOpen) return
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setIsOpen(false)
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [isOpen])

  return (
    <div className="sa-profile" ref={ref}>
      <button onClick={() => setIsOpen(!isOpen)} className={`sa-profile__btn${showName ? ' sa-profile__btn--wide' : ''}`} title={user.name} aria-expanded={isOpen}>
        <span className="sa-avatar">{user.initials}</span>
        {showName && (
          <span className="sa-profile__who">
            <span className="sa-profile__name">{user.name}</span>
            {user.email && user.email !== user.name && <span className="sa-profile__line">{user.email}</span>}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="sa-menu">
          <div className="sa-menu__head">
            <div className="sa-menu__eyebrow">{project}</div>
            <div className="sa-menu__title">{user.name}</div>
            {user.email && <div className="sa-menu__line">{user.email}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
