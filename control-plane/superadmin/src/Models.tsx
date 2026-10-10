// ── THE AGENTS SCREEN ───────────────────────────────────────────────────────────────────────────────────────
//
// Two jobs, two tables, and they are genuinely different work:
//
//   PROJECTS   which brain each project runs, and whether the assignment has been picked up. The job is to
//              spot the row that disagrees with itself and get to the project that owns it.
//   CATALOGUE  what those projects may choose from: the platform's model list (control-plane/shared/models.json),
//              shown as it is and who uses each model. It is changed with `pnpm models add|remove` and a deploy —
//              never here — because it is part of the platform every engine receives.
//
// Both are tables because both are scanned, not read.
//
// TWO FACTS, NEVER BLENDED. `assigned` is what superadmin saved; `running` is what that project's own engine
// reported, with the time it said so. They differ whenever a box is asleep, unreachable, or mid-question.
//
// The catalogue is platform-wide and never leaves the control plane: a box is given its decision — one
// harness, one provider, one model per agent — not the options behind it.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Code, Empty, Icon, Loading, Notice, Receipt, RecordList, Section, Status, Toolbar, type Column } from '@superatom/ui'

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
  const [providers, setProviders] = useState<Provider[]>([])

  const [failed, setFailed] = useState('')
  const load = useCallback(async () => {
    try {
      const [pr, cat] = await Promise.all([api('/profiles'), api('/catalogue')])
      if (!pr.ok || !cat.ok) throw new Error(`HTTP ${pr.ok ? cat.status : pr.status}`)
      setRows(((await pr.json()) as any).projects ?? [])
      const d = await cat.json() as any
      setProviders(d.providers ?? [])
      setModels(d.models ?? {})
      setFailed('')
    } catch (e: any) { setFailed(String(e?.message ?? e)) }
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

  if (failed && (!rows || !models)) return <Notice state="critical">Could not read the agents ({failed}). <button className="sa-btn sa-btn--link" onClick={load}>Try again</button></Notice>
  if (!rows || !models) return <Loading>Reading the agents…</Loading>
  return (
    <div className="sa-stack sa-stack--4">
      <Projects rows={rows} onRefresh={load} />
      <Catalogue providers={providers} models={models} usedBy={usedBy} />
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
      <Link className="sa-btn sa-btn--link" to={`/o/${r.orgId}/p/${r.projectId}/agents`} onClick={e => e.stopPropagation()}>
        Configure <Icon icon="lucide:arrow-right" className="sa-btn__icon" />
      </Link>
    ) },
  ]
  return (
    <>
      <Section icon="lucide:boxes" title="Projects" subtitle="Assigned on each project’s Agents and models page; reported by its own engine"
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

function Catalogue({ providers, models, usedBy }: { providers: Provider[]; models: Record<string, string[]>; usedBy: Map<string, string[]> }) {
  const [q, setQ] = useState('')
  // Matched on the ACCOUNT as well as the model, so "opencode" narrows to one account and "glm" to a family.
  const needle = q.trim().toLowerCase()
  const hit = (p: Provider, m: string) => !needle || m.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle)
  const flat: Entry[] = providers.flatMap(p => (models[p.name] ?? []).filter(m => hit(p, m)).map(m => ({ p, m })))
  const total = providers.reduce((n, p) => n + (models[p.name] ?? []).length, 0)
  // An account with nothing listed still gets a row: knowing it EXISTS and cannot be chosen is the thing you came to
  // find out. Hidden while searching — it is not a match.
  const bare: Entry[] = needle ? [] : providers.filter(p => (models[p.name] ?? []).length === 0).map(p => ({ p, m: null }))

  const columns: Column<Entry>[] = [
    { key: 'account', label: 'Account', render: ({ p }) => <Code>{p.name}</Code> },
    { key: 'route', label: 'Route', render: ({ p }) => (
      <span className="sa-row sa-row--tight"><span className="sa-muted">{p.route}</span>{p.disabled && <Status state="neutral">off</Status>}</span>
    ) },
    { key: 'model', label: 'Model', wrap: true, render: ({ p, m }) => m
      ? <Code>{m}</Code>
      : <span className="sa-faint">No models listed — no project can choose this account{p.disabled ? ` · ${p.disabled}` : ''}</span> },
    { key: 'used', label: 'Used by', wrap: true, render: ({ p, m }) => {
      if (!m) return null
      const users = usedBy.get(`${p.name}/${m}`) ?? []
      return users.length ? users.join(', ') : <span className="sa-faint">—</span>
    } },
  ]

  return (
    <Section icon="lucide:library" title="Catalogue" subtitle="The platform’s model list — what a project’s profile may choose from. Changed with pnpm models add | remove, then a deploy">
      <div className="sa-section__body">
        <Toolbar end={<span className="sa-muted">{needle ? `${flat.length} of ${total}` : `${total} model${total === 1 ? '' : 's'}`}</span>}>
          <input className="sa-input sa-input--sm" value={q} onChange={e => setQ(e.target.value)} placeholder="Search models or accounts…" aria-label="Search models or accounts" />
          {needle && <button className="sa-btn sa-btn--link" onClick={() => setQ('')}>Clear</button>}
        </Toolbar>
      </div>
      <RecordList columns={columns} rows={[...flat, ...bare]} keyOf={e => `${e.p.name}/${e.m ?? ''}`}
        empty={needle ? `Nothing matches “${q}”.` : 'No accounts yet.'} />
    </Section>
  )
}
