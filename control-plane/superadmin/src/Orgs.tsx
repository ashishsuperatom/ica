// The organisation pages: the list of them, one organisation (its projects, people, warehouse, usage, billing,
// settings), the landing for someone in one, the profile page, and the platform's models and credentials pages.
import { useState, useEffect, useCallback, useContext } from 'react'
import { dropToken } from '../../shared/session-token'
import { keptClear } from '../../../clients/kept'
import { Credentials } from './Credentials'
import { AgentsScreen } from './Models'
import { WarehousePanel } from './Warehouse'
import { OrgPeoplePanel, OrgKeysPanel } from './People'
import { BillingPanel } from './Billing'
import { UsagePanel } from './Usage'
import { useUser, useClerk } from '@clerk/react'
import { useParams, useNavigate } from 'react-router-dom'
import { UserProfile, MenuItem, MenuRule, ChartFrame, Section as SectionCard, Kpi, TimeColumns, Donut, PageHeader, Tabs, Notice, Figures, RecordList, Receipt, Form, Field, Status, Loading, ActionBar, Icon, day } from '@superatom/ui'
import { useAuth, useApi, ShellMode, Shell, Dialog, ShowDeleted, ConfirmDelete, HOST_SCOPE } from './console'
import { FlyAllowancePanel } from './FlyAllowance'
import { OrgConnectorsPanel } from './Connectors'
import { ORG_PLACES } from './places'

// ── Org list ─────────────────────────────────────────────────────────────────
// Landing for admin.superatom.site. The API already returns only the orgs this person belongs to, so the
// common case (exactly one) goes straight there and the URL becomes /org/<id> as if they had typed it.
// Someone in several orgs picks; someone in none is told, rather than shown an empty console.
/** The person, at the rail's foot: our own menu (the same as the workspace's); only sign-in and security is Clerk's. */
export function PersonMenu({ onProfile }: { onProfile: () => void }) {
  const { user } = useUser()
  const clerk = useClerk()
  const email = user?.primaryEmailAddress?.emailAddress
  return (
    <UserProfile name={user?.fullName || email || 'Signed in'} email={email} menu={<>
      <MenuItem icon="solar:user-circle-linear" label="Profile" onClick={onProfile} />
      <MenuItem icon="solar:shield-keyhole-linear" label="Sign-in and security" onClick={() => clerk.openUserProfile()} />
      <MenuRule />
      <MenuItem icon="solar:logout-2-linear" label="Log out" onClick={() => { dropToken(); void keptClear(); void clerk.signOut() }} />
    </>} />
  )
}

/** Who is signed in: their name and email, what they are on the platform, the organisations they are in. */
export function ProfilePage({ superadmin, orgs }: { superadmin: boolean; orgs: { id: string; name: string }[] }) {
  const { user } = useUser()
  const clerk = useClerk()
  const nav = useNavigate()
  const email = user?.primaryEmailAddress?.emailAddress
  return (<>
    <PageHeader title="Profile" />
    <SectionCard icon="solar:user-circle-linear" title={user?.fullName || email || 'Signed in'}>
      <Receipt items={[
        ['Name', user?.fullName || '—'],
        ['Email', email ?? '—'],
        ['On the platform', superadmin ? 'Administrator of Superatom' : 'Member of its organisations'],
        ['Signed up', day(user?.createdAt)],
      ]} />
      <ActionBar><button type="button" className="sa-btn" onClick={() => clerk.openUserProfile()}>Sign-in and security</button></ActionBar>
    </SectionCard>
    <SectionCard icon="solar:buildings-2-linear" title="Your organisations">
      <RecordList rows={orgs} keyOf={(o) => o.id} empty="Not in an organisation yet." onRow={(o) => nav(`/o/${o.id}`)} columns={[{ key: 'name', label: 'Organisation', render: (o) => o.name }]} />
    </SectionCard>
  </>)
}

export function MyOrgLanding() {
  const token = useAuth(); const api = useApi(token)
  const [orgs, setOrgs] = useState<Org[] | null>(null)
  const nav = useNavigate()
  useEffect(() => {
    if (!token) return
    api('/organizations?deleted=0').then(r => r.json()).then((d: any) => {
      const list: any[] = Array.isArray(d) ? d : (d?.organizations ?? [])
      setOrgs(list)
      if (list.length === 1) nav(`/o/${list[0].id}`, { replace: true })
    }).catch(() => setOrgs([]))
  }, [token, api, nav])

  if (!orgs) return <Shell><Loading>Reading your organisations…</Loading></Shell>
  if (orgs.length === 0) return (
    <Shell>
      <PageHeader title="No access yet" subtitle="This account is not a member of any organisation." />
      <Notice state="attention">Ask an administrator to add your email address to their organisation.</Notice>
    </Shell>
  )
  return (
    <Shell>
      <PageHeader title="Your organisations" subtitle="Choose the organisation to open." />
      <SectionCard icon="lucide:building-2" title="Organisations" note={`${orgs.length}`}>
        <RecordList rows={orgs} keyOf={(o) => String(o.id)} onRow={(o) => nav(`/o/${o.id}`)} columns={[
          { key: 'name', label: 'Name' },
          { key: 'myLevel', label: 'You are', render: (o) => o.myLevel ? <Status state="neutral">{o.myLevel === 'org-admin' ? 'administrator' : 'member'}</Status> : '—' },
        ]} />
      </SectionCard>
    </Shell>
  )
}

/** An organisation as the list of them gives it. */
type Org = { id: string; name: string; myLevel?: string; deleted?: boolean | number | null }
/** A project as its organisation lists it. */
type OrgProject = { id: string; name: string; provider?: string; created_at?: string | number; deleted?: boolean | number | null }

export type ProjectCard = { id: string; name: string; orgId: string; running: boolean | null }

export function OrgListPage() {
  const token = useAuth(); const api = useApi(token)
  const [orgs, setOrgs] = useState<Org[] | null>(null); const [showDeleted, setShowDeleted] = useState(false)
  const [projects, setProjects] = useState<ProjectCard[] | null>(null)
  const [making, setMaking] = useState(false)
  const [draft, setDraft] = useState({ name: '', adminEmail: '' })
  const [err, setErr] = useState('')
  // Everyone already in an organisation or project, given a sign-in account (nobody signs up on their own).
  const [accounts, setAccounts] = useState<{ busy?: boolean; text?: string; bad?: boolean } | null>(null)
  const makeAccounts = async () => {
    setAccounts({ busy: true })
    const r = await api('/sign-in-accounts', { method: 'POST' }).catch(() => null)
    const d: any = r ? await r.json().catch(() => null) : null
    if (!r?.ok || !d) { setAccounts({ text: `It could not be done (${r ? r.status : 'unreachable'}).`, bad: true }); return }
    setAccounts({ text: `${d.people} people: ${d.made} accounts made, ${d.existed} already there${d.problems.length ? `; ${d.problems.length} could not be made — ${d.problems.slice(0, 3).map((p: any) => p.email).join(', ')}` : ''}.`, bad: !!d.problems.length })
  }
  const nav = useNavigate()
  const fetchOrgs = useCallback(() => { if (token) api(`/organizations?deleted=${showDeleted ? '1' : '0'}`).then(r => r.json()).then((d) => setOrgs(Array.isArray(d) ? d : [])).catch(() => setOrgs([])) }, [token, api, showDeleted])
  useEffect(() => { fetchOrgs() }, [fetchOrgs])
  // Every organisation's projects, and whether each one's engine is running (the platform console sees them all at once;
  // an organisation's console asks each of its organisations).
  useEffect(() => {
    if (!token || !orgs) return
    let live = true
    void (async () => {
      const running = new Map<string, boolean>()
      if (HOST_SCOPE === 'superadmin') {
        const d: any = await api('/profiles').then((r) => (r.ok ? r.json() : null)).catch(() => null)
        for (const p of d?.projects ?? []) running.set(p.projectId, !!p.running)
      }
      const all = await Promise.all(orgs.filter((o) => !o.deleted).map(async (o) => {
        const r = await fetch('/api/projects?deleted=0', { headers: { authorization: `Bearer ${token}`, 'x-org-id': o.id } }).catch(() => null)
        const list: any[] = r?.ok ? await r.json() : []
        return list.filter((p) => !p.deleted).map((p): ProjectCard => ({ id: p.id, name: p.name, orgId: o.id, running: running.has(p.id) ? running.get(p.id)! : null }))
      }))
      if (live) setProjects(all.flat())
    })()
    return () => { live = false }
  }, [token, api, orgs])
  // What happened in the last 30 days: each project's model use by day (what the platform meters).
  const [usage, setUsage] = useState<{ project: string; day: string; calls: number; tokens: number; credits: number }[] | null>(null)
  useEffect(() => {
    if (!token || !projects) return
    if (!projects.length) { setUsage([]); return }
    let live = true
    void Promise.all(projects.map(async (p) => {
      const r = await fetch(`/api/projects/${p.id}/usage`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null)
      const d: any = r?.ok ? await r.json().catch(() => null) : null
      return (d?.usage ?? []).map((u: any) => ({ project: p.id, day: String(u.day), calls: Number(u.calls) || 0, tokens: (Number(u.tokens_in) || 0) + (Number(u.tokens_out) || 0), credits: (Number(u.credits_micro) || 0) / 1e6 }))
    })).then((rows) => { if (live) setUsage(rows.flat()) })
    return () => { live = false }
  }, [token, projects])
  // The first admin is created WITH the organisation: an org nobody can enter is not much use.
  async function create() {
    setErr('')
    const r = await api('/organizations', { method: 'POST', body: JSON.stringify({ name: draft.name, adminEmail: draft.adminEmail }) })
    if (!r.ok) { setErr(((await r.json().catch(() => ({}))) as any).error ?? `It was not made (${r.status})`); return }
    setDraft({ name: '', adminEmail: '' }); setMaking(false); fetchOrgs()
  }
  // Deletion is NOT here — it lives on the org page's Danger zone (deliberate, type-to-confirm). Restore is safe.
  const restore = async (id: string) => { await api('/organizations', { method: 'PUT', body: JSON.stringify({ id }) }); fetchOrgs() }
  const live = (orgs ?? []).filter((o) => !o.deleted), deleted = (orgs ?? []).filter((o) => o.deleted)
  const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10))
  const all = projects ?? []
  const orgOfProject = new Map(all.map((p) => [p.id, p.orgId]))
  const byDay: Record<string, Record<string, number>> = {}
  for (const u of usage ?? []) { const o = orgOfProject.get(u.project) ?? '?'; (byDay[u.day] ??= {})[o] = (byDay[u.day]?.[o] ?? 0) + u.tokens }
  const callsBy = new Map<string, number>(); for (const u of usage ?? []) callsBy.set(u.project, (callsBy.get(u.project) ?? 0) + u.calls)
  const callsByOrg = new Map<string, number>(); for (const [p, c] of callsBy) { const o = orgOfProject.get(p); if (o) callsByOrg.set(o, (callsByOrg.get(o) ?? 0) + c) }
  const totals = (usage ?? []).reduce((t, u) => ({ calls: t.calls + u.calls, tokens: t.tokens + u.tokens, credits: t.credits + u.credits }), { calls: 0, tokens: 0, credits: 0 })
  const compact = (v: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(v)
  const runningCount = all.filter((p) => p.running).length
  const known = all.filter((p) => p.running !== null).length

  // Nothing here moves as it loads: every figure, both charts and the list hold their place from the first paint, and
  // fill in as their numbers arrive.
  return (
    <Shell>
      <PageHeader title="Organisations" subtitle="Every organisation on the platform, its projects, and whether their engines are running."
        actions={HOST_SCOPE !== 'admin' ? <span className="sa-row sa-row--tight">
          <button className="sa-btn" disabled={!!accounts?.busy} title="Make a sign-in account for everyone already in an organisation or a project" onClick={() => void makeAccounts()}><Icon icon="lucide:user-check" /> {accounts?.busy ? 'Making sign-in accounts…' : 'Sign-in accounts'}</button>
          <button className="sa-btn sa-btn--primary" onClick={() => setMaking(true)}><Icon icon="lucide:plus" /> New organisation</button>
        </span> : undefined} />
      {accounts?.text && <Notice state={accounts.bad ? 'attention' : 'ok'} action={<button className="sa-btn" onClick={() => setAccounts(null)}>Done</button>}>{accounts.text}</Notice>}
      <Figures>
        <Kpi label="Organisations" value={live.length} loading={orgs === null} accent="series-1" />
        <Kpi label="Projects" value={all.length} loading={projects === null} accent="series-2" />
        <Kpi label="Engines running" value={known ? `${runningCount} of ${known}` : '—'} loading={projects === null} accent={runningCount < known ? 'warn' : 'win'} foot={known ? (runningCount < known ? `${known - runningCount} not reporting` : 'all reporting') : 'none known'} />
        <Kpi label="Model calls · 30 days" value={compact(totals.calls)} loading={usage === null} accent="series-3" foot={`${compact(totals.tokens)} tokens${totals.credits > 0 ? ` · ${compact(totals.credits)} credits` : ''}`} />
      </Figures>
      <div className="sa-two-col">
        <SectionCard icon="lucide:chart-column" title="Model use" subtitle="Tokens a day, last 30 days, by organisation">
          <div className="sa-section__chart"><ChartFrame loading={usage === null} height={284}>
            <TimeColumns periods={days} values={byDay} format={compact} empty="No model use in the last 30 days" series={live.map((o) => ({ key: o.id, label: o.name }))} />
          </ChartFrame></div>
        </SectionCard>
        <SectionCard icon="lucide:chart-pie" title="Where the work is" subtitle="Model calls by project, last 30 days">
          <div className="sa-section__chart"><ChartFrame loading={usage === null}>
            <Donut height={240} format={compact} empty="No model calls in the last 30 days"
              slices={[...callsBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, v]) => ({ name: all.find((p) => p.id === id)?.name ?? id.slice(0, 8), value: v }))} />
          </ChartFrame></div>
        </SectionCard>
      </div>
      <SectionCard icon="lucide:building-2" title="Organisations" note={orgs ? `${live.length}` : undefined}>
        <RecordList rows={live} keyOf={(o) => String(o.id)} onRow={(o) => nav(`/o/${o.id}`)} loading={orgs === null} loadingRows={3}
          search={(o) => String(o.name)} searchLabel="Find an organisation…" pageSize={10}
          empty={HOST_SCOPE !== 'admin' ? 'No organisations yet. Make the first one.' : 'No organisations yet.'}
          columns={[
            { key: 'name', label: 'Organisation', render: (o) => <strong>{o.name}</strong> },
            { key: 'projects', label: 'Projects', align: 'end', render: (o) => projects ? String(all.filter((p) => p.orgId === o.id).length) : '…' },
            { key: 'engines', label: 'Engines running', align: 'end', render: (o) => { if (!projects) return '…'; const mine = all.filter((p) => p.orgId === o.id && p.running !== null); return mine.length ? `${mine.filter((p) => p.running).length} of ${mine.length}` : '—' } },
            { key: 'calls', label: 'Model calls · 30 days', align: 'end', render: (o) => usage ? compact(callsByOrg.get(o.id) ?? 0) : '…' },
            { key: 'open', label: '', align: 'end', render: () => <Icon icon="lucide:chevron-right" /> },
          ]} />
      </SectionCard>
      <div className="sa-row"><ShowDeleted value={showDeleted} onChange={setShowDeleted} /></div>
      {showDeleted && deleted.length > 0 && (
        <SectionCard icon="lucide:archive" accent="neutral" title="Deleted organisations" subtitle="Restoring one brings back its projects and people">
          <RecordList rows={deleted} keyOf={(o) => String(o.id)} columns={[
            { key: 'name', label: 'Organisation' },
            { key: 'act', label: '', align: 'end', render: (o) => <button className="sa-btn" onClick={() => restore(o.id)}>Restore</button> },
          ]} />
        </SectionCard>
      )}
      {making && (
        <Dialog icon="lucide:building-2" title="New organisation" subtitle="Its first administrator is invited with it" onClose={() => setMaking(false)}>
          <Form onSubmit={() => void create()} error={err} actions={<><button type="button" className="sa-btn" onClick={() => setMaking(false)}>Cancel</button><button className="sa-btn sa-btn--primary">Make the organisation</button></>}>
            <Field label="Name"><input id="org-name" className="sa-input" required autoFocus value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="Acme" /></Field>
            <Field label="First administrator’s email"><input id="org-admin" className="sa-input" type="email" required value={draft.adminEmail} onChange={e => setDraft({ ...draft, adminEmail: e.target.value })} placeholder="name@acme.com" /></Field>
          </Form>
        </Dialog>
      )}
    </Shell>
  )
}

// ── Org detail ─────────────────────────────────────────────────────────────
// Platform-wide, like Credentials: which models exist on an account is one fact for the whole platform, and
// this is the list a project's profile chooses from. It is never sent to a project or an engine — they are
// given the decision, not the options.
export function ModelsPage() {
  const token = useAuth(); const api = useApi(token)
  return (
    <Shell>
      <PageHeader title="Agents" subtitle="Which model each project’s agents run on, and what they may choose from." />
      <AgentsScreen api={api} />
    </Shell>
  )
}

// Platform-wide, not per-org: one pool of provider keys serves every project, and which project may use which
// is exactly what the screen is for.
export function CredentialsPage() {
  const token = useAuth(); const api = useApi(token)
  return (
    <Shell>
      <PageHeader title="Credentials" subtitle="The keys the coding agents use, and who may use them. Stored sealed; values are never shown here." />
      <Credentials api={api} />
    </Shell>
  )
}

export function OrgDetailPage() {
  const token = useAuth(); const { orgId, tab: place } = useParams<{ orgId: string; tab?: string }>(); const api = useApi(token, orgId)
  // The place is in the address: /o/<org>/<place> (people, warehouse, usage, billing, settings; none = its projects).
  const tab = (place === 'people' ? 'users' : place ?? 'projects') as 'projects' | 'users' | 'usage' | 'warehouse' | 'connectors' | 'billing' | 'settings'
  const setSearch = (q: { tab: string }) => nav(`/o/${orgId}${q.tab === 'projects' ? '' : `/${q.tab === 'users' ? 'people' : q.tab}`}`)
  const inBlock = useContext(ShellMode) === 'block'
  const [projects, setProjects] = useState<OrgProject[]>([]); const [users, setUsers] = useState<{ id: string }[]>([])
  const [showDeleted, setShowDeleted] = useState(false); const nav = useNavigate()
  const [newProject, setNewProject] = useState({ name: '' })
  const [makingProject, setMakingProject] = useState(false)
  // Teams-token generation moved to the PROJECT's Settings view. Here we only need the org NAME (for the
  // type-to-confirm delete) + the Danger-zone modal toggle.
  const [orgName, setOrgName] = useState(''); const [delOrg, setDelOrg] = useState(false)
  useEffect(() => { if (token) api('/organizations').then(r => r.json()).then((os: any[]) => setOrgName(Array.isArray(os) ? (os.find(o => o.id === orgId)?.name ?? '') : '')).catch(() => {}) }, [token, api, orgId])
  const [projectsRead, setProjectsRead] = useState(false)
  const fetchProjects = useCallback(() => { if (token) api(`/projects?deleted=${showDeleted ? '1' : '0'}`).then(r => r.json()).then((d) => { setProjects(Array.isArray(d) ? d : []); setProjectsRead(true) }).catch(() => setProjectsRead(true)) }, [token, api, showDeleted])
  const [usersRead, setUsersRead] = useState(false)
  useEffect(() => { if (!token) return; fetchProjects(); api('/users').then(r => (r.ok ? r.json() : [])).then((d) => { setUsers(Array.isArray(d) ? d : []); setUsersRead(true) }).catch(() => setUsersRead(true)) }, [token, api, fetchProjects])
  // A project is made without an engine; where it runs is chosen on its Engine page (docs/deploying-the-engine.md).
  async function createProject() {
    const r = await api('/projects', { method: 'POST', body: JSON.stringify({ name: newProject.name, createdBy: 'superadmin' }) })
    const p = await r.json(); setNewProject({ name: '' }); fetchProjects()
    nav(`/o/${orgId}/p/${p.id}`)
  }
  // Project delete lives on the project's own Settings → Danger zone (type-to-confirm), not on this list.
  const restoreProject = async (id: string) => { await api('/projects', { method: 'PUT', body: JSON.stringify({ id }) }); fetchProjects() }

  // The warehouse is the whole page: the explorer, with everything else beside its tables.
  if (tab === 'warehouse') return <WarehousePanel api={api} orgId={orgId ?? ''} projects={projects.filter((p) => !p.deleted).map((p) => ({ id: p.id, name: p.name }))} />

  return (
    <Shell>
      {(() => { const pl = ORG_PLACES.find((x) => x.slug === (tab === 'projects' ? '' : tab === 'users' ? 'people' : tab)); return <PageHeader title={pl?.label ?? orgName} subtitle={pl?.says} /> })()}
      {/* In the workspace the sidebar and the breadcrumbs are the way between these; the tabs are for the page alone. */}
      {inBlock ? null : <Tabs label="Parts of the organisation" value={tab} onChange={(t) => setSearch({ tab: t })} items={[
        { key: 'projects', label: 'Projects', icon: 'lucide:folder-kanban', count: projects.length },
        { key: 'users', label: 'Users', icon: 'lucide:users', count: users.length },
        { key: 'usage', label: 'Usage', icon: 'lucide:gauge' },
        { key: 'warehouse', label: 'Warehouse', icon: 'lucide:database' },
        { key: 'connectors', label: 'Connectors', icon: 'lucide:plug' },
        { key: 'settings', label: 'Settings', icon: 'lucide:settings-2' },
      ]} />}

      {tab === 'projects' && <>
        <Figures>
          <Kpi label="Projects" value={projects.filter((p) => !p.deleted).length} loading={!projectsRead} accent="series-1" />
          <Kpi label="People" value={users.length} loading={!usersRead} accent="series-2" />
        </Figures>
        <SectionCard icon="lucide:folder-kanban" title="Projects" subtitle="Open one to see its agents, data, people and engine"
          actions={<><ShowDeleted value={showDeleted} onChange={setShowDeleted} /><button className="sa-btn sa-btn--primary" onClick={() => setMakingProject(true)}><Icon icon="lucide:plus" /> New project</button></>}>
          <div className="sa-home__group">
            <RecordList rows={projects.filter((p) => !p.deleted)} keyOf={(p) => String(p.id)} onRow={(p) => nav(`/o/${orgId}/p/${p.id}`)} loading={!projectsRead} loadingRows={3}
              search={(p) => String(p.name)} searchLabel="Find a project…" pageSize={10} empty="No projects yet. Make the first one."
              columns={[
                { key: 'name', label: 'Project', render: (p) => <strong>{p.name}</strong> },
                { key: 'made', label: 'Made', render: (p) => <span className="sa-muted">{p.created_at ? new Date(Number(p.created_at) * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</span> },
                { key: 'open', label: '', align: 'end', render: () => <Icon icon="lucide:chevron-right" /> },
              ]} />
            {projects.some((p) => p.deleted) && (
              <RecordList rows={projects.filter((p) => p.deleted)} keyOf={(p) => String(p.id)} columns={[
                { key: 'name', label: 'Deleted project' },
                { key: 'act', label: '', align: 'end', render: (p) => <button className="sa-btn" onClick={() => restoreProject(p.id)}>Restore</button> },
              ]} />
            )}
          </div>
        </SectionCard>
        {makingProject && (
          <Dialog icon="lucide:folder-plus" title="New project" onClose={() => setMakingProject(false)}>
            <Form onSubmit={() => { void createProject(); setMakingProject(false) }} actions={<><button type="button" className="sa-btn" onClick={() => setMakingProject(false)}>Cancel</button><button className="sa-btn sa-btn--primary">Make the project</button></>}>
              <Field label="Name"><input id="proj-name" className="sa-input" required autoFocus value={newProject.name} onChange={e => setNewProject({ ...newProject, name: e.target.value })} placeholder="Finance analytics" /></Field>
            </Form>
          </Dialog>
        )}
      </>}

      {tab === 'usage' && <UsagePanel api={api} />}
      {tab === 'connectors' && <OrgConnectorsPanel api={api} />}
      {tab === 'billing' && <BillingPanel api={api} />}
      {tab === 'users' && <><OrgPeoplePanel api={api} /><OrgKeysPanel api={api} /></>}

      {/* Deleting an ORGANISATION is a platform act — the customer console never offers it, and the API refuses
          it for anyone but superadmin regardless. */}
      {tab === 'settings' && <div className="sa-stack sa-stack--4">
        <FlyAllowancePanel api={api} editable={HOST_SCOPE === 'superadmin'} />
        {HOST_SCOPE !== 'admin' && <SectionCard icon="lucide:triangle-alert" accent="loss" title="Danger zone" subtitle="Delete this organisation: it removes the organisation and every project inside it">
          <ActionBar><button className="sa-btn" onClick={() => setDelOrg(true)}>Delete organisation…</button></ActionBar>
        </SectionCard>}
      </div>}
      {delOrg && <ConfirmDelete kind="organization" name={orgName || orgId || ''} onClose={() => setDelOrg(false)}
        consequences={[`Delete organization “${orgName || orgId}”`, `Delete all ${projects.length} project(s) inside it`, 'Detach their engines / bots', 'Soft-delete — restorable from the org list (Show deleted)']}
        onConfirm={async () => { await api('/organizations', { method: 'DELETE', body: JSON.stringify({ id: orgId }) }); nav('/') }} />}
    </Shell>
  )
}
