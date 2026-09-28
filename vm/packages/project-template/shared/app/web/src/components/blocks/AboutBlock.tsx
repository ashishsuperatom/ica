// Where the numbers come from: the connected source and its dialect, the domains' programs every view reads (and what
// one row of each is), the organisation's settings in force, and the application's views.

import { Icon } from '@iconify/react'
import type { ReactNode } from 'react'
import { Section } from '@/components/ui/Section'
import { useBlockHeader } from '@/components/thread/header'
import { date } from '@/lib/format'
import { useApp } from '@/lib/catalog'
import type { About } from '@/lib/wire'

const Rows = ({ items }: { items: Array<[string, ReactNode]> }) => (
  <dl className="sa-dl">
    {items.map(([k, v]) => <div key={k} data-copy="line" className="sa-dl__row"><dt className="sa-dl__key">{k}</dt><dd className="sa-dl__value">{v}</dd></div>)}
  </dl>
)

export default function AboutBlock({ about: a }: { about: About }) {
  const { client, catalog } = useApp()
  useBlockHeader({ title: 'Where the numbers come from' }, [])
  const status = client.status()
  const loaded = a.application.loadedAt ? new Date(a.application.loadedAt) : null
  return (
    <div className="sa-two-col">
      <Section icon="mdi:database-outline" accent="series-1" title="Source" subtitle="What the programs read">
        {a.sources.length === 0 && <p className="sa-note sa-section__empty">No source is connected.</p>}
        {a.sources.map((s) => (
          <div key={s.id}>
            <Rows items={[
              ['Source', <span className="sa-dl__value--strong">{s.id}</span>],
              ['Kind · dialect', `${s.kind.toUpperCase()} · ${s.dialect}`],
              ['Reached through', <span className="sa-row"><span className="sa-dot" style={{ background: status === 'open' ? 'var(--win)' : status === 'mock' ? 'var(--series-2)' : 'var(--warn)' }} />{status === 'mock' ? 'Recorded answers (mock)' : status === 'open' ? 'Connected' : 'Reconnecting'} · the data manager, one WebSocket channel</span>],
            ]} />
            <p className="sa-section__footnote" style={{ lineHeight: 'var(--lh-relaxed)', color: 'var(--muted)' }}>{s.description}</p>
          </div>
        ))}
      </Section>

      <Section icon="mdi:information-outline" accent="series-1" title="Application" subtitle="This dashboard, on the domains' programs">
        <Rows items={[
          ['Views', `${a.application.capabilities} loaded${catalog.capabilities.length !== a.application.capabilities ? ` (${catalog.capabilities.length} in this catalog)` : ''}`],
          ['Loaded', loaded && !Number.isNaN(loaded.getTime()) ? loaded.toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'],
          ['Today', date(a.today)],
          ['Problems', a.application.problems.length ? <ul className="sa-headline__because">{a.application.problems.map((p) => <li key={p}>{p}</li>)}</ul> : <span className="sa-row sa-row--tight"><Icon icon="lucide:check" className="sa-btn__icon" style={{ color: 'var(--win)' }} />None</span>],
        ]} />
        <div className="sa-section__footnote" data-copy="skip"><Icon icon="mdi:atom" /> Built by Superatom AI · superatom.ai</div>
      </Section>

      <Section icon="lucide:workflow" accent="series-2" title="Programs" subtitle="What every figure is computed by: a domain's program, the same one its chat agent runs" note={`${a.programs.length} programs`} className="sa-two-col__span">
        <table className="sa-table">
          <thead><tr><th className="l">Fact</th><th className="l">Program</th><th className="l">Agent</th><th className="l">One row is</th></tr></thead>
          <tbody>
            {a.programs.map((p) => <tr key={p.fact} data-copy="line"><td className="l name">{p.fact}</td><td className="l"><code className="sa-hash">{p.program}</code></td><td className="l">{p.domain}</td><td className="l wrap">{p.grain}</td></tr>)}
            {!a.programs.length && <tr><td className="l" colSpan={4}><span className="sa-note">No programs are listed.</span></td></tr>}
          </tbody>
        </table>
        <div className="sa-section__footnote" data-copy="skip">Counts and sums are computed by the source; a table holds one page of at most 100 rows.</div>
      </Section>

      <Section icon="lucide:sliders-horizontal" accent="series-2" title="Settings" subtitle="The organisation's settings the programs read, as the composition graph holds them" note={`${a.settings.length} settings`} className="sa-two-col__span">
        <Rows items={a.settings.map((x) => [x.name, <code className="sa-hash">{x.value}</code>])} />
      </Section>
    </div>
  )
}
