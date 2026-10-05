// ── THE AGENTS SCREEN ───────────────────────────────────────────────────────────────────────────────────────
//
// Two jobs, two tables, and they are genuinely different work:
//
//   PROJECTS   which brain each project runs, and whether the assignment has been picked up. The job is to
//              spot the row that disagrees with itself and get to the project that owns it.
//   CATALOGUE  what those projects may choose from. The job is bulk entry the first time, one addition when an
//              account gains a model, and a removal that can tell you whether anything is using it.
//
// Both are tables because both are scanned, not read. An earlier version made the catalogue a chip per model:
// tidy, and hostile to the only bulk operation it has — so entry is a paste box, as it was when this was a
// textarea, and the table is what you scan afterwards.
//
// TWO FACTS, NEVER BLENDED. `assigned` is what superadmin saved; `running` is what that project's own engine
// reported, with the time it said so. They differ whenever a box is asleep, unreachable, or mid-question.
//
// The catalogue is platform-wide and never leaves the control plane: a box is given its decision — one
// harness, one provider, one model per agent — not the options behind it.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ActionBar, Code, Empty, Field, Form, Icon, Notice, Receipt, RecordList, Section, Status, Toolbar, type Column } from '@superatom/ui'

type Api = (path: string, init?: RequestInit) => Promise<Response>
type Provider = { name: string; route: string; disabled: string | null }
type AgentRow = { harness: string; provider: string; model: string }
type Row = {
  org: string; orgId: string; projectId: string; project: string
  savedVersion: number | null
  running: { version: number; at?: number; agents?: Record<string, AgentRow> } | null
  error?: string
}

const AGENTS = ['analyst', 'connector', 'grounding', 'modeller', 'composer', 'narrator']
const ago = (t?: number) => {
  if (!t) return ''
  const m = Math.round((Date.now() - t) / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}
const brain = (a: AgentRow) => `${a.harness} · ${a.provider} · ${a.model}`

export function AgentsScreen({ api }: { api: Api }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [models, setModels] = useState<Record<string, string[]> | null>(null)
  const [saved, setSaved] = useState<Record<string, string[]> | null>(null)   // to know what is unsaved
  const [providers, setProviders] = useState<Provider[]>([])
  const [source, setSource] = useState<'stored' | 'default' | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [pr, cat] = await Promise.all([api('/profiles'), api('/catalogue')])
    if (pr.ok) setRows(((await pr.json()) as any).projects ?? [])
    if (cat.ok) {
      const d = await cat.json() as any
      setProviders(d.providers ?? [])
      setModels(d.models ?? {}); setSaved(d.models ?? {})
      setSource(d.source ?? null)
    }
  }, [api])
  useEffect(() => { load() }, [load])

  // WHO IS USING WHAT, from what the engines report — so removing a model can say that it would strand a
  // project, rather than that turning up later as an agent which will not start.
  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const r of rows ?? [])
      for (const a of Object.values(r.running?.agents ?? {})) {
        const k = `${a.provider}/${a.model}`
        m.set(k, [...(m.get(k) ?? []), r.project])
      }
    return m
  }, [rows])

  const dirty = models && saved && JSON.stringify(models) !== JSON.stringify(saved)
  const save = async () => {
    setBusy(true); setMsg('Saving…')
    const r = await api('/catalogue', { method: 'PUT', body: JSON.stringify({ models }) })
    setBusy(false)
    if (!r.ok) { setMsg(`Could not save: ${r.status} ${await r.text()}`); return }
    await load()          // re-read: the project dropdowns offer whatever is STORED
    setMsg('Saved')
  }

  if (!rows || !models) return <Empty>Loading agents…</Empty>
  return (
    <div className="sa-stack sa-stack--4">
      <Projects rows={rows} onRefresh={load} />
      <Catalogue providers={providers} models={models} usedBy={usedBy} source={source} dirty={!!dirty} busy={busy} msg={msg}
                 onChange={setModels} onSave={save} onDiscard={() => { setMsg(''); load() }} />
    </div>
  )
}

// ── PROJECTS ────────────────────────────────────────────────────────────────────────────────────────────────
function Projects({ rows, onRefresh }: { rows: Row[]; onRefresh: () => void }) {
  const [open, setOpen] = useState<string | null>(null)
  const drift = rows.filter(r => r.running && r.savedVersion != null && r.running.version !== r.savedVersion).length
  const dark = rows.filter(r => !r.running).length
  const failed = rows.filter(r => r.error)
  const opened = rows.find(r => r.projectId === open)
  const columns: Column<Row>[] = [
    { key: 'project', label: 'Project', render: r => <span className="sa-row sa-row--tight"><Icon icon={open === r.projectId ? 'lucide:chevron-down' : 'lucide:chevron-right'} /><b>{r.project}</b></span> },
    { key: 'org', label: 'Organization', render: r => <span className="sa-muted">{r.org}</span> },
    { key: 'assigned', label: 'Assigned', render: r => <Code>v{r.savedVersion ?? '—'}</Code> },
    { key: 'running', label: 'Running', render: r => {
      const live = r.running
      if (!live) return <Status state="neutral">engine offline</Status>
      const agreed = live.version === r.savedVersion
      return (
        <span className="sa-row sa-row--tight">
          <Status state={agreed ? 'ok' : 'critical'}>v{live.version}{agreed ? '' : ' · not picked up'}</Status>
          <span className="sa-faint">{ago(live.at)}</span>
        </span>
      )
    } },
    { key: 'composer', label: 'Composer', render: r => { const c = r.running?.agents?.composer; return c ? <Code>{brain(c)}</Code> : <span className="sa-faint">—</span> } },
    { key: 'go', label: '', align: 'end', render: r => (
      <Link className="sa-btn sa-btn--link" to={`/org/${r.orgId}/projects/${r.projectId}/settings`} onClick={e => e.stopPropagation()}>
        Configure <Icon icon="lucide:arrow-right" className="sa-btn__icon" />
      </Link>
    ) },
  ]
  return (
    <>
      <Section icon="lucide:boxes" title="Projects" subtitle="Assigned on each project’s settings page; reported by its own engine"
        note={`${rows.length - dark} running${drift ? ` · ${drift} not picked up` : ''}${dark ? ` · ${dark} offline` : ''}`}
        actions={<button className="sa-btn" onClick={onRefresh}><Icon icon="lucide:refresh-cw" className="sa-btn__icon" />Refresh</button>}>
        {failed.length > 0 && (
          <div className="sa-section__body sa-stack sa-stack--3">
            {failed.map(r => <Notice key={r.projectId} state="critical"><b>{r.project}</b>: could not read — {r.error}</Notice>)}
          </div>
        )}
        <RecordList columns={columns} rows={rows} keyOf={r => r.projectId} empty="No projects yet."
          onRow={r => setOpen(open === r.projectId ? null : r.projectId)} />
      </Section>
      {/* Opened: every agent, and ONLY what the engine reports — an assignment nothing has picked up is
          deliberately not drawn as a list of agents. */}
      {opened && (
        <Section icon="lucide:bot" title={opened.project} subtitle="Each agent’s brain, as its engine reports it"
          actions={<button className="sa-icon-btn sa-icon-btn--sm" aria-label="Close" title="Close" onClick={() => setOpen(null)}><Icon icon="lucide:x" /></button>}>
          {opened.running?.agents
            ? <Receipt items={AGENTS.filter(a => opened.running!.agents![a]).map(a => [a, <Code key={a}>{brain(opened.running!.agents![a])}</Code>])} />
            : <Empty>Its engine has not reported which agents it runs.</Empty>}
        </Section>
      )}
    </>
  )
}

// ── CATALOGUE ───────────────────────────────────────────────────────────────────────────────────────────────
type Entry = { p: Provider; m: string | null }

function Catalogue({ providers, models, usedBy, source, dirty, busy, msg, onChange, onSave, onDiscard }: {
  providers: Provider[]; models: Record<string, string[]>; usedBy: Map<string, string[]>
  source: string | null; dirty: boolean; busy: boolean; msg: string
  onChange: (m: Record<string, string[]>) => void; onSave: () => void; onDiscard: () => void
}) {
  const [addTo, setAddTo] = useState<string>('')
  const [paste, setPaste] = useState('')
  const [q, setQ] = useState('')
  // TWO STEPS TO REMOVE, inline rather than a modal: the list is long, the rows are one click apart, and the
  // damage is silent — a model that vanishes from the catalogue leaves a project's saved choice pointing at
  // something the editor no longer offers. Asking costs one click; not asking costs a puzzled hour later.
  const [confirming, setConfirming] = useState<string | null>(null)

  // BULK, because that is the operation this screen actually has: the first time an account is set up, its
  // whole list arrives at once. One-at-a-time entry made the common case 24 separate actions.
  const addMany = () => {
    const names = paste.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
    if (!addTo || names.length === 0) return
    onChange({ ...models, [addTo]: [...new Set([...(models[addTo] ?? []), ...names])].sort() })
    setPaste('')
  }
  const remove = (provider: string, model: string) =>
    onChange({ ...models, [provider]: (models[provider] ?? []).filter(m => m !== model) })

  // Matched on the ACCOUNT as well as the model, so "opencode" narrows to one account and "glm" to a family.
  const needle = q.trim().toLowerCase()
  const hit = (p: Provider, m: string) => !needle || m.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)
  const flat: Entry[] = providers.flatMap(p => (models[p.name] ?? []).filter(m => hit(p, m)).map(m => ({ p, m })))
  const total = providers.reduce((n, p) => n + (models[p.name] ?? []).length, 0)
  // An account with nothing catalogued still gets a row: knowing it EXISTS and cannot be chosen yet is the thing
  // you came to find out. Hidden while searching — it is not a match.
  const bare: Entry[] = needle ? [] : providers.filter(p => (models[p.name] ?? []).length === 0).map(p => ({ p, m: null }))

  const columns: Column<Entry>[] = [
    { key: 'account', label: 'Account', render: ({ p }) => <Code>{p.name}</Code> },
    { key: 'route', label: 'Route', render: ({ p }) => (
      <span className="sa-row sa-row--tight"><span className="sa-muted">{p.route}</span>{p.disabled && <Status state="neutral">off</Status>}</span>
    ) },
    { key: 'model', label: 'Model', wrap: true, render: ({ p, m }) => m
      ? <Code>{m}</Code>
      : <span className="sa-faint">Nothing catalogued — no project can choose this account{p.disabled ? ` · ${p.disabled}` : ''}</span> },
    { key: 'used', label: 'Used by', wrap: true, render: ({ p, m }) => {
      if (!m) return null
      const users = usedBy.get(`${p.name}/${m}`) ?? []
      return users.length ? users.join(', ') : <span className="sa-faint">—</span>
    } },
    { key: 'remove', label: '', align: 'end', render: ({ p, m }) => {
      if (!m) return null
      const k = `${p.name}/${m}`
      const users = usedBy.get(k) ?? []
      return confirming === k
        ? <span className="sa-row sa-row--tight">
            <span className={users.length ? '' : 'sa-muted'}>{users.length ? <Status state="critical">used by {users.join(', ')}</Status> : 'Remove?'}</span>
            <button className="sa-btn sa-btn--link" onClick={() => { remove(p.name, m); setConfirming(null) }}>Remove{users.length ? ' anyway' : ''}</button>
            <button className="sa-btn sa-btn--link" onClick={() => setConfirming(null)}>Cancel</button>
          </span>
        : <button className="sa-icon-btn sa-icon-btn--sm" aria-label={`Remove ${m}`} title={`Remove ${m}`} onClick={() => setConfirming(k)}><Icon icon="lucide:x" /></button>
    } },
  ]

  return (
    <>
      <Section icon="lucide:library" title="Catalogue" subtitle="What a project’s profile may choose from, per account — selectable everywhere at once, no engine rebuild"
        note={source === 'default' ? 'Shipped default — nothing saved yet' : undefined}>
        <div className="sa-section__body">
          <Toolbar end={<span className="sa-muted">{needle ? `${flat.length} of ${total}` : `${total} model${total === 1 ? '' : 's'}`}</span>}>
            <input className="sa-input sa-input--sm" value={q} onChange={e => setQ(e.target.value)} placeholder="Search models or accounts…" aria-label="Search models or accounts" />
            {needle && <button className="sa-btn sa-btn--link" onClick={() => setQ('')}>Clear</button>}
          </Toolbar>
        </div>
        <RecordList columns={columns} rows={[...flat, ...bare]} keyOf={e => `${e.p.name}/${e.m ?? ''}`}
          empty={needle ? `Nothing matches “${q}”.` : 'No accounts yet.'} />
        <ActionBar>
          <button className="sa-btn sa-btn--primary" onClick={onSave} disabled={busy || !dirty}>Save catalogue</button>
          <button className="sa-btn" onClick={onDiscard} disabled={busy || !dirty}>Discard changes</button>
          <span className="sa-note">{dirty ? 'Unsaved changes' : msg}</span>
        </ActionBar>
      </Section>

      <Section icon="lucide:list-plus" title="Add models" subtitle="Added to the catalogue above; save it to make them selectable">
        <Form onSubmit={addMany} actions={<button className="sa-btn" disabled={!addTo || !paste.trim()}>Add</button>}>
          <Field label="Account">
            <select className="sa-input" value={addTo} onChange={e => setAddTo(e.target.value)}>
              <option value="">Choose an account…</option>
              {providers.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Models" help="One per line, or comma separated. Duplicates are ignored.">
            {/* height: .sa-input fixes one control height; a textarea needs its rows (a gap in the design system). */}
            <textarea className="sa-input sa-input--mono" value={paste} onChange={e => setPaste(e.target.value)} rows={4} placeholder={'deepseek-v4-flash\nglm-5.3'} />
          </Field>
        </Form>
      </Section>
    </>
  )
}
