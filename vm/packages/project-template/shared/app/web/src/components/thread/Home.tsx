// The front door: every scenario as a tinted Section — its root as the action card, and beneath it every
// capability it holds, each saying when to use it — so from here a person can go anywhere.

import { Icon } from '@iconify/react'
import { Section, ACCENT, type Accent } from '@superatom/ui'
import { scenarios, useApp } from '@/lib/catalog'
import { useThread } from '@/runtime/thread'
import type { Catalog } from '@/lib/wire'

/** A scenario's look, as the project's catalog gives it; a scenario it does not describe reads plainly. */
export const scenarioMeta = (c: Catalog, s: string): { label: string; accent: Accent; icon: string; says: string } => {
  const m = c.scenarios.find((x) => x.key === s)
  return { label: m?.label ?? s, accent: (m && m.accent in ACCENT ? m.accent : 'neutral') as Accent, icon: m?.icon ?? 'lucide:layout-grid', says: m?.says ?? '' }
}

export default function Home() {
  const { catalog } = useApp()
  const thread = useThread()
  return (
    <div className="sa-home home">
      <div className="sa-home__hero">
        <h1 className="sa-home__title">Where do you want to look?</h1>
        <p className="sa-home__lead">Each starting point stands on its own facts. Open one, then narrow, break down and follow the next moves; every block keeps the filters of the one it came from.</p>
      </div>
      {scenarios(catalog).map(({ scenario, root, others }) => {
        const m = scenarioMeta(catalog, scenario)
        return (
          <Section key={scenario} tinted icon={m.icon} accent={m.accent} title={m.label} subtitle={m.says}>
            <div className="sa-home__group">
              {root && (
                <button type="button" data-copy="skip" onClick={() => thread.start(root.focus)} className="sa-card sa-card--lift sa-action-card root-card" style={{ '--accent': ACCENT[m.accent] } as React.CSSProperties} title={root.whenToUse}>
                  <span className="sa-action-card__tile"><Icon icon={m.icon} /></span>
                  <div className="sa-action-card__body">
                    <p className="sa-action-card__title" title={root.label}>{root.label}</p>
                    <p className="sa-action-card__text">{root.whenToUse}</p>
                  </div>
                  <span className="sa-action-card__cta">Open <Icon icon="mdi:arrow-right" /></span>
                </button>
              )}
              {others.length > 0 && (
                <div className="sa-sub-grid">
                  {others.map((c) => (
                    <button key={c.focus} type="button" className="sa-sub-card sub-card" title={c.whenToUse} onClick={() => thread.start(c.focus)}>
                      <span className="sa-sub-card__title" title={c.label}>{c.label}</span>
                      <span className="sa-sub-card__text">{c.whenToUse}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Section>
        )
      })}
      {catalog.problems.length > 0 && <p className="sa-home__problems">The application loaded with problems: {catalog.problems.join(' · ')}</p>}
    </div>
  )
}
