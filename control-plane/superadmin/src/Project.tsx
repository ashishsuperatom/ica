// A project's page: every place of a project that is not a page of its own — the engine (live), the event log, the
// agents and models, settings, and the panels each place opens.
import { useState, useEffect, useCallback } from 'react'
import { DashboardsPanel } from './Dashboards'
import { AgentKeysPanel, AuditPanel } from './AgentKeys'
import { EngineReleasePanel } from './EngineRelease'
import { RunningPanel } from './Running'
import { ProjectConnectionsPanel, ProjectConnectorsPanel, ConsoleConnect } from './Connectors'
import { AccessPoliciesPanel, CompanySignInPanel } from './AccessPolicies'
import { LineagePanel } from './LineagePage'
import { GroupsPanel } from './Groups'
import { ProjectAccessPanel } from './People'
import { useProjectHub } from './hub'
import { Inspector, type Section } from './Inspector'
import { ConnectorConsole } from './ConnectorConsole'
import { GroundingConsole } from './GroundingConsole'
import { AnalystConsole } from './AnalystConsole'
import { Link, useParams, useNavigate } from 'react-router-dom'
import { modelOn } from '../../../vm/packages/agent-contract/contract.mjs'
import { Section as SectionCard, Kpi, PageHeader, Notice, Code, Figures, RecordList, Receipt, Form, Field, Status, ago, dateTime, ActionBar, Icon, type StatusState, CopyButton, notify } from '@superatom/ui'
import { DevEnvironments } from './DevEnvironments'
import { Configuration } from './Configuration'
import { ConversationSettings } from './ConversationSettings'
import { Pill, useRole, useAuth, useApi, Shell, EnvBlock, ConfirmDelete, Moved } from './console'
import { ChannelsPanel } from './Channels'
import { DataSourcesPanel } from './DataSources'
import { purposesOf } from './places'

/** An event's detail as a reader takes it in: who and what kind of connection, else its fields as words — never raw JSON. */
export function eventWords(detail: string | null | undefined): string {
  if (!detail) return ''
  let d: any
  try { d = JSON.parse(detail) } catch { return detail }
  if (!d || typeof d !== 'object') return String(d)
  const who = d.email ?? (typeof d.userId === 'string' ? d.userId.replace(/^user_/, '').slice(0, 8) + '…' : null)
  if (d.type && who) return `${d.type} · ${who}`
  return Object.entries(d).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').slice(0, 4).map(([k, v]) => `${k} ${String(v).slice(0, 40)}`).join(' · ')
}

// ── Project detail — live monitoring dashboard ───────────────────────────────
export const evtState = (e: string): StatusState =>
  /fail|error|evict/.test(e) ? 'critical' :
  /suspend|stop|leave|disconnect/.test(e) ? 'attention' :
  /connect|woke|start|join|deliver/.test(e) ? 'ok' : 'running'

// ── Access (per project) ────────────────────────────────────────────────────
// Who may use THIS project, and as what. People are created once in the organisation; here they are assigned.
// The assignment call goes to the ORG (it is the one that knows who belongs to it) and the org writes into this
// project — so a project can never invent a user of its own. Roles are the project's own.
export function AccessPanel({ projectId, orgId, api, token }: { projectId: string; orgId: string | null; api: ReturnType<typeof useApi>; token: string | null }) {
  const orgApi = useApi(token, orgId)
  return <div className="sa-stack sa-stack--4"><ProjectAccessPanel projectId={projectId} api={api} orgApi={orgId ? orgApi : null} /><CompanySignInPanel api={api} projectId={projectId} /></div>
}

/** What /projects/<id>/status says: the project, its compute (decided by the platform per provider) and who is on its hub. */
type ProjectStatus = {
  name?: string; orgId?: string; provider?: string
  machine?: { id?: string; state?: string; lastHeartbeat?: number; region?: string; idlePhase?: string } | null
  connections?: { wsId: string; type: string }[]
}
/** One line of the project's event log. */
type EventRow = { id: number; event: string; detail: string | null; created_at: number }

export const ENGINE_VIEWS = new Set(['engine', 'inspector/summary', 'inspector/files', 'inspector/db', 'inspector/logs', 'inspector/grounding'])

export function ProjectDetailPage() {
  const token = useAuth(); const params = useParams<{ orgId: string; projectId: string; '*': string }>()
  const role = useRole(token)   // superadmin-only sections are not rendered without it (the API refuses regardless)
  const { orgId, projectId } = params
  const navigate = useNavigate()
  const api = useApi(token, orgId)
  const [status, setStatus] = useState<ProjectStatus | null>(null)
  const [logs, setLogs] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)

  // The view id is flat: a top-level item ('engine'), or 'inspector/<section>' for an Inspector sub-section.
  // It lives in the URL PATH (the route splat), so a reload / shared link lands on the same view — e.g.
  // /admin/org/<org>/projects/<id>/semantic or /inspector/db-kinds. setView navigates instead of setState.
  const view = params['*'] || 'engine'
  // Two ways in: /org/<org>/projects/<id>/… (from the org) and /pro/<id>/… (straight to the project). Keep the
  // reader on whichever they used, so a shared link and the back button behave.
  const base = `/o/${orgId}/p/${projectId}`
  // The org + project NAMES (the sidebar/crumbs/header show real names, not just truncated ids).
  const [meta, setMeta] = useState<{ project?: string; org?: string }>({})
  // Settings view: the project's API key + the Danger zone (delete). Kept OFF the project list — a delete is
  // never one click from a card.
  const [delProj, setDelProj] = useState(false)
  // ROTATING THIS PROJECT'S KEY, on the project's own Settings — which is where someone looks for it. It was
  // put only on the org's project ROW first, next to "Open →", and the row opens the project when clicked, so
  // in practice everyone navigated straight past it and reported the button missing. A control nobody can
  // find is a control that does not exist.
  const [rot, setRot] = useState<{ apiKey: string; done?: boolean } | null>(null)
  // ── THE AGENT PROFILE ──────────────────────────────────────────────────────────────────────────────────
  // Two facts, never conflated: what is SAVED for this project, and what the engine reports it is RUNNING.
  // They differ whenever a box is asleep, unreachable, or still finishing a question — so the UI shows both
  // and says which is which, rather than turning a successful write into a claim about a machine.
  const [prof, setProf] = useState<{ profile: any; version: number; running: any } | null>(null)
  // TYPED, and never null while rendering. This was `any` and initialised to null: the card dereferenced
  // draft.agents on the first paint, before the fetch resolved, and `any` meant the typecheck could not see it.
  type Draft = { agents: Record<string, { harness?: string; provider?: string; model?: string; thinking?: string }>; harnessNotes?: any }
  const [draft, setDraft] = useState<Draft | null>(null)
  const [profMsg, setProfMsg] = useState<string>('')
  // The OPTIONS come from the platform catalogue, never from a list this file carries — so the editor can only
  // offer what superadmin has approved, and adding a model there makes it selectable here immediately.
  const [cat, setCat] = useState<{ models: Record<string, string[]>; providers: { name: string; disabled: string | null }[]
                                   harnesses: Record<string, { providers: string[] }> } | null>(null)
  useEffect(() => {
    if (view !== 'agents' || role !== 'superadmin') return
    api('/catalogue').then(async r => {
      if (!r.ok) return
      const d = await r.json() as any
      setCat({ models: d.models ?? {}, providers: d.providers ?? [], harnesses: d.harnesses ?? {} })
    }).catch(() => {})
  }, [view, role, api])
  const loadProfile = useCallback(async () => {
    const r = await api(`/projects/${projectId}/profile`)
    if (!r.ok) return
    const d = await r.json() as any
    setProf(d)
    // SEEDED FROM WHAT IS RUNNING when nothing is saved yet, so the editor starts from what the box is
    // genuinely using. With neither — an unconfigured project whose engine has never reported — it starts
    // EMPTY rather than absent: the six agents are known, so every row can still be chosen deliberately, and
    // a screen that renders nothing at all is the failure this card exists to prevent.
    setDraft(cur => cur ?? d.profile ?? d.running?.profile ?? { agents: {} })
  }, [api, projectId])
  useEffect(() => { if (view === 'agents') loadProfile() }, [view, loadProfile])
  const saveProfile = async () => {
    // ONLY COMPLETE ROWS TRAVEL. An agent needs all three parts; a half-filled row would be refused by the
    // engine as malformed, and an agent left untouched should simply keep the engine's default rather than be
    // sent a fragment. So partly-filled rows are dropped, and the message says how many, rather than silently
    // shipping something that will bounce.
    const rows = Object.entries((draft?.agents ?? {}) as Record<string, any>)
    const complete = rows.filter(([, a]) => a?.harness && a?.provider && a?.model)
    const dropped = rows.length - complete.length
    const profile = { ...draft, agents: Object.fromEntries(complete) }
    setProfMsg('saving…')
    const r = await api(`/projects/${projectId}/profile`, { method: 'PUT', body: JSON.stringify({ profile }) })
    if (!r.ok) { setProfMsg(`could not save: ${r.status} ${await r.text()}`); return }
    const { version, delivered } = await r.json() as any
    // The write succeeded. Whether a MACHINE took it is a different question, and we wait for the engine's own
    // report rather than claiming it — an offline box must read as offline, not as applied.
    const note = dropped ? ` (${dropped} incomplete row${dropped === 1 ? '' : 's'} left on the engine's default)` : ''
    setProfMsg(delivered ? `saved v${version}${note} — waiting for the engine to confirm…`
                         : `saved v${version}${note} — the engine is not connected; it will pick this up when it starts`)
    for (let i = 0; i < 12 && delivered; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const g = await api(`/projects/${projectId}/profile`)
      if (!g.ok) continue
      const d = await g.json() as any
      setProf(d)
      if (d.running?.version === version) { setProfMsg(`running v${version} — confirmed by the engine`); return }
    }
    if (delivered) setProfMsg(`saved v${version} — the engine has not confirmed it yet`)
  }
  const rotateKey = async () => {
    const r = await api(`/project-key/${projectId}/rotate`, { method: 'POST' })
    if (!r.ok) { notify(`Could not rotate: ${r.status} ${await r.text()}`, 'refused'); return }
    setRot({ apiKey: (await r.json() as any).apiKey })
  }
  const finishRotation = async () => {
    if (!rot) return
    const r = await api(`/project-key/${projectId}/prune`, { method: 'POST', body: JSON.stringify({ keep: rot.apiKey }) })
    if (!r.ok) { notify(`Could not finish: ${r.status} ${await r.text()}`, 'refused'); return }
    setRot({ ...rot, done: true })
  }
  useEffect(() => {
    if (!token) return
    api('/projects').then(r => (r.ok ? r.json() : [])).then((ps: any[]) => setMeta(m => ({ ...m, project: Array.isArray(ps) ? ps.find(p => p.id === projectId)?.name : undefined }))).catch(() => {})
    api('/organizations').then(r => (r.ok ? r.json() : [])).then((os: any[]) => setMeta(m => ({ ...m, org: Array.isArray(os) ? os.find(o => o.id === orgId)?.name : undefined }))).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, projectId, orgId])
  // One persistent hub connection for the whole project — survives switching sidebar views.
  const hub = useProjectHub(projectId, token)

  // Subdomain mapper (<sub>.superatom.site → this project)
  const [sub, setSub] = useState(''); const [subState, setSubState] = useState<{ ok?: boolean; msg?: string } | null>(null)
  const [domains, setDomains] = useState<string[]>([])
  const loadDomains = useCallback(() => {
    api(`/domains/by-project?projectId=${projectId}`).then(r => r.json()).then(d => setDomains(d.subdomains ?? [])).catch(() => {})
  }, [api, projectId])
  useEffect(() => { if (token) loadDomains() }, [token, loadDomains])

  async function checkSub(v: string) {
    setSub(v); setSubState(null)
    if (!v) return
    try { const d = await api(`/domains/check?subdomain=${encodeURIComponent(v)}`).then(r => r.json())
      setSubState({ ok: d.available, msg: d.available ? 'available' : d.reason }) } catch {}
  }
  async function claimSub() {
    try {
      const r = await api('/domains/claim', { method: 'POST', body: JSON.stringify({ subdomain: sub, projectId }) })
      const d = await r.json()
      if (!r.ok) { setSubState({ ok: false, msg: d.error }); return }
      setSub(''); setSubState(null); loadDomains()
    } catch (e: any) { setSubState({ ok: false, msg: e.message }) }
  }
  async function releaseSub(s: string) {
    // Only the project holding an address releases it: the platform needs to know which project asks.
    const r = await api('/domains', { method: 'DELETE', body: JSON.stringify({ subdomain: s, projectId }) }).catch(() => null)
    if (!r?.ok) setSubState({ ok: false, msg: `Could not release ${s}.superatom.site${r ? ` — ${(await r.text().catch(() => '')).slice(0, 120) || r.status}` : ''}` })
    loadDomains()
  }

  // Poll continuously — this is the live observability view (DO log + connections + machine).
  useEffect(() => {
    if (!token) return
    let stop = false
    async function tick() {
      try {
        // One generalized status endpoint — the backend fills the machine view per
        // provider; the frontend just renders status.machine (no provider branching).
        const [s, l] = await Promise.all([
          api(`/projects/${projectId}/status`).then(r => r.json()),
          api(`/projects/${projectId}/logs`).then(r => r.json()),
        ])
        if (stop) return
        setStatus(s); setLogs(Array.isArray(l) ? l : []); setLoading(false)
      } catch {}
      if (!stop) setTimeout(tick, 4000)   // keep refreshing so the dashboard is always live
    }
    tick()
    return () => { stop = true }
  }, [token, api, projectId])

  const m = status?.machine
  const conns = status?.connections ?? []
  const liveState = m?.state   // unified, backend-decided (Fly state or online/offline)
  const provider = status?.provider

  // The place's name and what it is for, from the project's places (the sidebar's words).
  const here = purposesOf().flatMap(p => p.places).find(pl => pl.slug === view)
  const title = here?.label ?? 'Engine'

  // One line on what the view is for, from the places by purpose (the same words as the workspace's sidebar).
  const says = here?.says
  const profileEnv = (key: string) => `ICA_PROJECT=${projectId}\nICA_KEY=${key}`

  return (
    <Shell>
      {/* The data source index needs no heading: the project at its centre says what it is, the bar above whether it is connected. */}
      {/* The engine's state only where the page shows the engine; everything else is the platform's, which is always there. */}
      {view !== 'sources' && <PageHeader title={title} subtitle={says}
        actions={!ENGINE_VIEWS.has(view) ? undefined : loading ? <span className="sa-row sa-row--tight sa-muted"><span className="sa-spinner" /> connecting…</span> : <Pill s={liveState} />} />}

      {view === 'engine' && <>
        <Figures>
          <Kpi label="Runs on" value={provider === 'fly' ? 'Fly' : 'A machine'} loading={loading} />
          <Kpi label="State" value={<Pill s={liveState} />} loading={loading} />
          <Kpi label="Heartbeat" value={m?.lastHeartbeat ? ago(m.lastHeartbeat) : '—'} loading={loading} />
          <Kpi label="Connections" value={conns.length} loading={loading} />
          {provider === 'fly' && m?.idlePhase && <Kpi label="Idle phase" value={<Pill s={m.idlePhase} />} />}
          {m?.region && <Kpi label="Region" value={m.region} />}
        </Figures>
        <SectionCard icon="lucide:plug" title="Live connections" subtitle="Who is connected to the project’s hub now" note={`${conns.length}`}>
          <RecordList rows={conns} keyOf={(c) => String(c.wsId)} empty="Nobody is connected to the hub right now." columns={[
            { key: 'type', label: 'Who', render: (c) => <span className="sa-row sa-row--tight"><Status state="ok">live</Status>{c.type}</span> },
            { key: 'wsId', label: 'Connection', align: 'end', render: (c) => <Code>{c.wsId}</Code> },
          ]} />
        </SectionCard>
        {projectId && <DevEnvironments api={api} projectId={projectId} canDelete />}
        <SectionCard icon="lucide:app-window" title="User app" subtitle="Open this project as an end user">
          <ActionBar>
            <a className="sa-btn sa-btn--primary" href={`https://${projectId}.superatom.site/`} target="_blank" rel="noreferrer"><Icon icon="lucide:external-link" className="sa-btn__icon" />Open on superatom.site</a>
            {domains[0] && <a className="sa-btn" href={`https://${domains[0]}.superatom.site`} target="_blank" rel="noreferrer"><Icon icon="lucide:external-link" className="sa-btn__icon" />Open on {domains[0]}.superatom.site</a>}
          </ActionBar>
        </SectionCard>
      </>}

      {view === 'inspector/composition' && <Moved to={() => `${base}/graph`} />}
      {view.startsWith('inspector/') && view !== 'inspector/composition' && <Inspector hub={hub} section={view.slice('inspector/'.length) as Section} />}

      {view === 'events' && (
        <SectionCard icon="lucide:activity" title="Events" subtitle="From the project’s Durable Object, newest first" actions={<Status state="ok">live</Status>}>
          <RecordList search pageSize={20} rows={logs} keyOf={(l) => String(l.id)} empty="No events recorded yet." columns={[
            { key: 'event', label: 'Event', render: (l) => <Status state={evtState(l.event)}>{l.event}</Status> },
            { key: 'detail', label: 'Detail', render: (l) => <span title={l.detail || undefined}>{eventWords(l.detail)}</span> },
            { key: 'at', label: 'Time', align: 'end', render: (l) => <span title={dateTime(l.created_at * 1000)}>{ago(l.created_at * 1000)}</span> },
          ]} />
        </SectionCard>
      )}

      {view === 'dashboards' && <DashboardsPanel api={api} token={token} projectId={projectId!} />}
      {view === 'agent-keys' && <AgentKeysPanel api={api} projectId={projectId!} />}
      {view === 'audit' && <AuditPanel api={api} projectId={projectId!} />}
      {view === 'engine-version' && <EngineReleasePanel api={api} projectId={projectId!} hub={hub} />}
      {view === 'running' && <RunningPanel api={api} projectId={projectId!} hub={hub} />}
      {view === 'connections' && <ProjectConnectionsPanel api={api} orgApi={api} projectId={projectId!} hub={hub} />}
      {view === 'connectors' && <ProjectConnectorsPanel api={api} projectId={projectId!} />}
      {view === 'connect' && <ConsoleConnect api={api} projectId={projectId!} hub={hub} />}
      {view === 'lineage' && <LineagePanel hub={hub} projectId={projectId!} />}
      {view === 'data-access' && <AccessPoliciesPanel api={api} hub={hub} projectId={projectId!} />}
      {view === 'groups' && <GroupsPanel api={api} projectId={projectId!} />}
      {view === 'subdomains' && (
        <SectionCard icon="lucide:globe" title="Subdomains" subtitle="Map a name to this project; people open <name>.superatom.site (the project id also works)" note={`${domains.length}`}>
          <Form onSubmit={() => { if (subState?.ok) void claimSub() }} actions={<button className="sa-btn sa-btn--primary" disabled={!subState?.ok}>Claim</button>}>
            <Field label="Name" help={<span className="sa-row sa-row--tight sa-row--wrap">Opens at <Code>{`${sub || 'name'}.superatom.site`}</Code>{subState && <Status state={subState.ok ? 'ok' : 'critical'}>{subState.msg}</Status>}</span>}>
              <input className="sa-input" value={sub} onChange={e => checkSub(e.target.value.toLowerCase())} placeholder="acme" />
            </Field>
          </Form>
          <RecordList rows={domains.map(d => ({ d }))} keyOf={(r) => r.d} empty="No names mapped yet." columns={[
            { key: 'd', label: 'Address', render: (r) => <a href={`https://${r.d}.superatom.site`} target="_blank" rel="noreferrer" className="sa-row sa-row--tight"><Code>{`${r.d}.superatom.site`}</Code><Icon icon="lucide:external-link" /></a> },
            { key: 'act', label: '', align: 'end', render: (r) => <button className="sa-btn sa-btn--link" title="release" onClick={() => releaseSub(r.d)}>Release</button> },
          ]} />
        </SectionCard>
      )}

      {/* Agents and models: which harness, provider and model each agent runs on (the platform decides it). */}
      {view === 'agents' && (role === 'superadmin' ? <>
        {(() => {
          // The document being edited, never null: an unconfigured project is an empty one, not an absent one.
          const doc: Draft = draft ?? { agents: {} }
          const AGENTS = ['analyst', 'connector', 'grounding', 'composer', 'narrator']
          const HARNESSES = ['claude-code-pty', 'opencode', 'pi', 'codex']
          const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
          const running = prof?.running
          // A harness reaches only certain accounts, and an account carries only certain models — so changing
          // one clears what it invalidates instead of leaving a pair that cannot exist. With exactly one
          // possible account (claude-code-pty, codex) it is chosen outright: presenting a single option as a
          // decision is busywork.
          const setAgent = (a: string, k: string, v: string) =>
            setDraft(d => {
              const cur = d ?? { agents: {} }
              const row: any = { ...(cur.agents?.[a] ?? {}), [k]: v || undefined }
              // THE MODEL STAYS when the account changes: it is translated into the new account's spelling
              // (claude-haiku-4-5 ↔ anthropic/claude-haiku-4.5). Cleared, and said so, only when the new
              // account does not serve it at all.
              const carry = (provider: string | undefined) => {
                if (!row.model || !provider) return
                const same = modelOn(row.model, cat?.models?.[provider] ?? [])
                if (!same) setProfMsg(`${a}: ${provider} does not serve ${row.model} — choose a model`)
                row.model = same ?? undefined
              }
              if (k === 'harness') {
                const can = cat?.harnesses?.[v]?.providers ?? []
                if (!row.provider || !can.includes(row.provider)) {
                  row.provider = can.length === 1 ? can[0] : undefined
                  if (row.provider) carry(row.provider); else row.model = undefined
                }
              }
              if (k === 'provider') carry(v)
              return { ...cur, agents: { ...cur.agents, [a]: row } }
            })
          const rows = AGENTS.map(a => ({ a, cur: doc.agents?.[a] ?? {} }))
          return (
            <SectionCard icon="lucide:cpu" title="Agent profile" subtitle="Which harness, provider and model each agent runs on">
              <div className="sa-section__body sa-stack">
                <p className="sa-muted">
                  Applied to the next session each agent builds — a question already in flight keeps the session it started on.
                  {' '}Models come from the platform <Link to="/models">catalogue</Link>.
                </p>
              </div>
              {/* WHAT IS ACTUALLY RUNNING — reported by the engine, not inferred from the last write. */}
              <Receipt items={[
                ['Saved', <Code>v{prof?.version ?? 0}</Code>],
                ['Engine running', running
                  ? <span className="sa-row sa-row--tight sa-row--wrap">
                      <Status state={running.version === prof?.version ? 'ok' : 'critical'}>v{running.version}</Status>
                      {/* WHEN it said so. A report with no time on it cannot be told from a stale one. */}
                      {running.at ? <span className="sa-muted">as of {dateTime(running.at)}</span> : null}
                    </span>
                  : <span className="sa-muted">engine has not reported — start it to see what it is running</span>],
              ]} />
              {/* AN EXPLICIT EMPTY OPTION on every select. A <select> whose value matches no option renders the FIRST
                  one instead — so an untouched row displayed "claude-code-pty / opencode-go" and read as a choice
                  nobody had made. Unset must look unset, and here it means precisely one thing: this agent keeps
                  whatever the engine defaults to. */}
              <RecordList rows={rows} keyOf={(r) => r.a} columns={[
                { key: 'a', label: 'Agent' },
                { key: 'harness', label: 'Harness', render: ({ a, cur }) => (
                  <select className="sa-input sa-input--sm" value={cur.harness ?? ''} onChange={e => setAgent(a, 'harness', e.target.value)}>
                    <option value="">— engine default —</option>
                    {HARNESSES.map(h => <option key={h} value={h}>{h}</option>)}
                  </select>) },
                { key: 'provider', label: 'Provider', render: ({ a, cur }) => (
                  <select className="sa-input sa-input--sm" value={cur.provider ?? ''} onChange={e => setAgent(a, 'provider', e.target.value)}>
                    <option value="">— engine default —</option>
                    {(cat?.providers ?? [])
                      .filter(p => !cur.harness || (cat?.harnesses?.[cur.harness]?.providers ?? []).includes(p.name))
                      .map(p =>
                        <option key={p.name} value={p.name} disabled={!!p.disabled}>
                          {p.name}{p.disabled ? ' — turned off' : ''}
                        </option>)}
                    {/* Keep a value the contract no longer offers visible rather than silently
                        rewriting this agent to something nobody chose. */}
                    {cur.provider && !(cat?.providers ?? []).some(p => p.name === cur.provider) &&
                      <option value={cur.provider}>{cur.provider} (unknown to the proxy)</option>}
                  </select>) },
                { key: 'model', label: 'Model', render: ({ a, cur }) => (
                  <select className="sa-input sa-input--sm" value={cur.model ?? ''} onChange={e => setAgent(a, 'model', e.target.value)}>
                    <option value="">— engine default —</option>
                    {/* No provider chosen yet means no models to offer — the catalogue is keyed by
                        account, so the question "which models" has no answer until one is picked. */}
                    {(cur.provider ? cat?.models?.[cur.provider] ?? [] : []).map((m: string) =>
                      <option key={m} value={m}>{m}</option>)}
                    {cur.model && !(cur.provider ? cat?.models?.[cur.provider] ?? [] : []).includes(cur.model) &&
                      <option value={cur.model}>{cur.model} (not in the catalogue)</option>}
                  </select>) },
                // How much the model reasons. Each harness takes it its own way and clamps it to what the model
                // offers; unset keeps the harness's default.
                { key: 'thinking', label: 'Thinking', render: ({ a, cur }) => (
                  <select className="sa-input sa-input--sm" value={cur.thinking ?? ''} onChange={e => setAgent(a, 'thinking', e.target.value)}>
                    <option value="">— default —</option>
                    {THINKING.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>) },
              ]} />

              {/* CAUTIONS COME FROM THE PROFILE, not from this file — adding one later is a data change. */}
              {AGENTS.some(a => { const h = doc.agents?.[a]?.harness; return h && doc.harnessNotes?.[a]?.[h] }) && (
                <div className="sa-section__body sa-stack">
                  {AGENTS.flatMap(a => {
                    const h = doc.agents?.[a]?.harness
                    const note = h ? doc.harnessNotes?.[a]?.[h] : null
                    return note ? [<Notice key={`${a}-${h}`} state={note.level === 'warn' ? 'attention' : 'neutral'}><strong>{a} → {h}</strong> · {note.text}</Notice>] : []
                  })}
                </div>
              )}

              <ActionBar>
                <button className="sa-btn sa-btn--primary" onClick={saveProfile}>Apply</button>
                <button className="sa-btn" onClick={() => { setDraft(prof?.profile ?? prof?.running?.profile ?? null); setProfMsg('') }}>Reset</button>
                {profMsg && <span className="sa-note">{profMsg}</span>}
              </ActionBar>

              {/* The engine's own view, per agent, including which layer decided each value — an ICA_* on the
                  box overrides this profile, and that must be visible here rather than a silent surprise. */}
              {running?.agents && (
                <div className="sa-section__body">
                  <details className="sa-disclosure">
                    <summary className="sa-disclosure__summary sa-label">
                      <Icon icon="lucide:chevron-right" />What the engine reports it is running
                      {running.at && <span className="sa-disclosure__meta">reported {dateTime(running.at)}</span>}
                    </summary>
                    {/* A TABLE, not aligned text: the values differ in length, so only columns let you scan them. */}
                    <div className="sa-disclosure__panel">
                      <RecordList rows={AGENTS.filter(a => running.agents[a]).map(a => ({ a, r: running.agents[a] }))} keyOf={(x) => x.a} columns={[
                        // A row the profile pins is worth distinguishing from one running the engine's own default —
                        // otherwise this table cannot say which of your choices took effect.
                        { key: 'a', label: 'Agent', render: ({ a }) => { const mine = doc.agents?.[a]; const pinned = !!(mine?.harness && mine?.provider && mine?.model); return <>{a}{pinned ? '' : <span className="sa-muted"> · default</span>}</> } },
                        { key: 'harness', label: 'Harness', render: ({ r }) => <Code>{r.harness}</Code> },
                        { key: 'provider', label: 'Provider', render: ({ r }) => <Code>{r.provider}</Code> },
                        { key: 'model', label: 'Model', render: ({ r }) => <Code>{r.model}</Code> },
                      ]} />
                    </div>
                  </details>
                </div>
              )}
            </SectionCard>
          )
        })()}
      </> : <Notice>Which model each agent runs on is decided by the platform.</Notice>)}
      {view === 'settings' && <>
        {projectId && <Configuration api={api} projectId={projectId} />}
        {projectId && <ConversationSettings api={api} projectId={projectId} />}
        <SectionCard icon="lucide:key-round" title="Project API key" subtitle="In every engine’s .env; it unlocks this project’s pooled provider credentials">
          <div className="sa-section__body sa-stack">
            <p className="sa-muted">Rotating issues a <strong>second</strong> key — both work, so nothing goes down — then “Finish” retires the old one.</p>
            {rot && <>
              {rot.done
                ? <Notice state="ok">Done — the old key no longer works. Any box still holding it will fail to connect until its <Code>.env</Code> is updated.</Notice>
                : <Notice state="attention">Shown once. Put it in every engine’s <Code>.env</Code> and restart, then press Finish.</Notice>}
              <EnvBlock text={profileEnv(rot.apiKey)} />
            </>}
          </div>
          <ActionBar>
            {!rot
              ? <button className="sa-btn" onClick={rotateKey}>Rotate key</button>
              : <>
                  <CopyButton text={profileEnv(rot.apiKey)} />
                  {!rot.done && <button className="sa-btn sa-btn--primary" onClick={finishRotation}>Finish — retire the old key</button>}
                  <button className="sa-btn sa-btn--link" onClick={() => setRot(null)}>Close</button>
                </>}
          </ActionBar>
        </SectionCard>

        <SectionCard icon="lucide:triangle-alert" accent="loss" title="Danger zone" subtitle="Delete this project: it tears down its engine wiring, machine mapping and channel credentials">
          <ActionBar><button className="sa-btn" onClick={() => setDelProj(true)}>Delete project…</button></ActionBar>
        </SectionCard>
      </>}

      {delProj && <ConfirmDelete kind="project" name={meta.project || projectId || ''} onClose={() => setDelProj(false)}
        consequences={[`Delete project “${meta.project || projectId}”`, 'Tear down its engine wiring + machine mapping', 'Revoke its channel / bot credentials', 'Soft-delete — restorable from the org’s project list (Show deleted)']}
        onConfirm={async () => { await api('/projects', { method: 'DELETE', body: JSON.stringify({ id: projectId }) }); navigate(`/o/${orgId}`) }} />}

      {view === 'agent' && <ConnectorConsole hub={hub} />}

      {view === 'analyst' && <AnalystConsole hub={hub} />}

      {view === 'grounding' && <GroundingConsole hub={hub} />}

      {view === 'sources' && <DataSourcesPanel hub={hub} api={api} projectId={projectId ?? ''} projectName={String(status?.name ?? '')} />}
      {view === 'access' && <AccessPanel projectId={projectId!} orgId={orgId ?? status?.orgId ?? null} api={api} token={token} />}
      {view === 'channels' && <ChannelsPanel projectId={projectId!} api={api} />}
    </Shell>
  )
}
