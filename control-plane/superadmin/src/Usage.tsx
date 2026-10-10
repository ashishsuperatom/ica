// ── USAGE BY PERSON ─────────────────────────────────────────────────────────────────────────────────────────
// What each of the organisation's people used, across its projects, for a month: model calls, tokens (fresh input,
// output, prompt cache) and credits. 'unattributed' is work no turn named — the project's own (warm-up, a terminal
// session, a shared agent serving two people at once). An admin sees everyone; a member sees themselves.
import { useEffect, useMemo, useState } from 'react'
import { Empty, Icon, Loading, Notice, RecordList, Section, type Column } from '@superatom/ui'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Totals = { calls: number; tokens_in: number; tokens_out: number; tokens_cache_read: number; tokens_cache_write: number; credits_micro: number; unpriced: number }
type Person = Totals & { person: string; projects: (Totals & { id: string; name: string })[] }

const n = (v: number) => v.toLocaleString()
const credits = (micro: number) => (micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })
const monthStart = (offset: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1)).toISOString() }
const whoOf = (p: Person) => p.person === 'unattributed' ? 'Project work (no person)' : p.person.replace(/^email:/, '')

/** The figure columns, shared by a person's row and their projects' rows. */
function figures<R extends Totals>(): Column<R>[] {
  return [
    { key: 'calls', label: 'Calls', align: 'end', render: r => n(r.calls) },
    { key: 'in', label: 'Input', align: 'end', render: r => n(r.tokens_in) },
    { key: 'out', label: 'Output', align: 'end', render: r => n(r.tokens_out) },
    { key: 'cr', label: 'Cache read', align: 'end', render: r => n(r.tokens_cache_read) },
    { key: 'cw', label: 'Cache write', align: 'end', render: r => n(r.tokens_cache_write) },
    { key: 'credits', label: 'Credits', align: 'end', render: r => (
      <span title={r.unpriced ? `${r.unpriced} calls have no price yet` : undefined}>{credits(r.credits_micro)}{r.unpriced ? ' *' : ''}</span>
    ) },
  ]
}

export function UsagePanel({ api }: { api: Api }) {
  const [offset, setOffset] = useState(0)          // 0 = this month, -1 = last month, …
  const [people, setPeople] = useState<Person[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const since = monthStart(offset), until = monthStart(offset + 1)
  useEffect(() => {
    setPeople(null); setErr('')
    api(`/usage/people?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`)
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status} ${await r.text()}`); return r.json() })
      .then((d: any) => setPeople(Array.isArray(d?.people) ? d.people : []))
      .catch((e) => setErr(String(e?.message ?? e)))
  }, [api, since, until])
  const total = useMemo(() => (people ?? []).reduce((a, p) => a + p.credits_micro, 0), [people])
  const label = new Date(since).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' })
  const opened = people?.find(p => p.person === open)

  const personColumns: Column<Person>[] = [
    { key: 'person', label: 'Person', render: p => (
      <span className="sa-row sa-row--tight">
        <Icon icon={open === p.person ? 'lucide:chevron-down' : 'lucide:chevron-right'} />
        {p.person === 'unattributed' ? <span className="sa-muted">{whoOf(p)}</span> : <b>{whoOf(p)}</b>}
      </span>
    ) },
    ...figures<Person>(),
  ]
  const projectColumns: Column<Person['projects'][number]>[] = [{ key: 'name', label: 'Project' }, ...figures<Person['projects'][number]>()]

  return (
    <div className="sa-stack sa-stack--4">
      <Section icon="lucide:gauge" title={`Usage in ${label}`} subtitle="Model calls, tokens and credits by person, across the organization’s projects"
        note={people ? `${credits(total)} credits · ${people.length} ${people.length === 1 ? 'person' : 'people'}` : undefined}
        actions={<span className="sa-row sa-row--tight">
          <button className="sa-icon-btn sa-icon-btn--sm" onClick={() => setOffset(offset - 1)} aria-label="Previous month" title="Previous month"><Icon icon="lucide:chevron-left" /></button>
          <button className="sa-icon-btn sa-icon-btn--sm" onClick={() => setOffset(offset + 1)} disabled={offset >= 0} aria-label="Next month" title="Next month"><Icon icon="lucide:chevron-right" /></button>
        </span>}
        footer={<span className="sa-note">* Some calls have no price on the platform’s list yet: their tokens are counted, their credits are not.</span>}>
        {err && <div className="sa-section__body"><Notice state="critical">Could not load usage: {err}</Notice></div>}
        {!err && !people && <Loading>Reading the usage…</Loading>}
        {people && <RecordList columns={personColumns} rows={people} keyOf={p => p.person} empty={`No model use in ${label}.`}
          onRow={p => setOpen(open === p.person ? null : p.person)} />}
      </Section>
      {opened && (
        <Section icon="lucide:folder-tree" title={whoOf(opened)} subtitle={`By project, ${label}`}
          actions={<button className="sa-icon-btn sa-icon-btn--sm" aria-label="Close" title="Close" onClick={() => setOpen(null)}><Icon icon="lucide:x" /></button>}>
          <RecordList columns={projectColumns} rows={opened.projects} keyOf={pr => pr.id} empty="No project recorded for this person." />
        </Section>
      )}
    </div>
  )
}
