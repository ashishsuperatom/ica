// WHAT A FIGURE MEANS, from the right: opened by an ⓘ (a block's head, a card), it says in a line or two what the
// thing is, then how it is worked out as steps, this data's own numbers, and the tables and fields they come from.
// One drawer for every surface; Esc, the scrim or ✕ closes it.

import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { useFormat } from '../../lib/formats'
import type { About } from '../../answer/blocks'

export default function AboutDrawer({ title, about, onClose }: { title: string; about: About; onClose: () => void }) {
  const { fmt } = useFormat()
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  return createPortal(
    <div className="sa-drawer" role="dialog" aria-modal="true" aria-label={title} onClick={onClose} data-copy="skip">
      <aside className="sa-drawer__panel" onClick={(e) => e.stopPropagation()}>
        <header className="sa-drawer__head">
          <h2 className="sa-drawer__title">{title}</h2>
          <button type="button" className="sa-icon-btn" title="Close (Esc)" onClick={onClose}><Icon icon="lucide:x" /></button>
        </header>
        <div className="sa-drawer__body">
          <p className="sa-drawer__means">{about.means}</p>
          {about.figures?.length ? (
            <section className="sa-drawer__section">
              <h3 className="sa-label">The numbers</h3>
              <dl className="sa-drawer__figures">
                {about.figures.map((f, i) => <div key={i} className="sa-drawer__figure"><dt>{f.label}</dt><dd className="sa-figure">{fmt(f.value, f.unit ?? 'text')}</dd></div>)}
              </dl>
            </section>
          ) : null}
          {about.calc?.length ? (
            <section className="sa-drawer__section">
              <h3 className="sa-label">How it is worked out</h3>
              <ol className="sa-drawer__steps">{about.calc.map((c, i) => <li key={i}>{c}</li>)}</ol>
            </section>
          ) : null}
          {about.sources?.length ? (
            <section className="sa-drawer__section">
              <h3 className="sa-label">From</h3>
              <ul className="sa-drawer__sources">{about.sources.map((x, i) => <li key={i}><code>{x}</code></li>)}</ul>
            </section>
          ) : null}
        </div>
      </aside>
    </div>,
    document.body,
  )
}
