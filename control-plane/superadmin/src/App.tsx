import { Component, useState, useEffect, useCallback, useMemo } from 'react'
import { CompositionGraph } from './CompositionGraph'
import { ProjectWarehouse } from './ProjectWarehouse'
import { useProjectHub } from './hub'
import { useSession, SignIn } from '@clerk/react'
import { BrowserRouter, Routes, Route, Link, useParams, useNavigate, useLocation } from 'react-router-dom'
import { SignInFrame, AppShell, RailSidebar, NavList, type RailPlace, Search, useSearchKey, type SearchItem, ConnectionStatus, Breadcrumbs, Arranged, type Crumb, LocalThread, Toasts, Section as SectionCard, Kpi, PageHeader, Notice, Code, Figures, RecordList, Form, Field, Status, Empty, dateTime, Icon, Select, useConfirm } from '@superatom/ui'
import '@superatom/ui/design.css'
import { useRole, useAuth, useApi, Shell, ROUTER_BASE, Moved } from './console'
import { AdminContext, ADMIN_OWN_BLOCKS } from './AdminBlocks'
import { NAMES, named, purposesOf, ORG_PLACES, PLATFORM_PLACES, holds, type Place } from './places'
import { PersonMenu, ProfilePage, MyOrgLanding, OrgListPage, ModelsPage, CredentialsPage, OrgDetailPage } from './Orgs'
import { ProjectDetailPage } from './Project'

// ── The console's own few rules (injected once) ──────────────────────────────
// Everything else is the platform's design system (@superatom/ui, imported in main.tsx). The rail's places and links take
// the primary colour here, where the user UI leaves them neutral.
const CSS = `
:root{--accent:var(--primary)}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font);font-feature-settings:var(--font-features);
 background:var(--page);color:var(--ink);-webkit-font-smoothing:antialiased;font-size:var(--t-base)}
a{color:var(--primary);text-decoration:none}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
/* a console screen inside a block of the admin workspace, its content padded */
.admin-block{min-width:0}
.admin-block .content{padding:14px 16px}
`

function Style() { return <style dangerouslySetInnerHTML={{ __html: CSS }} /> }

export { useRole, HOST_SCOPE, ROUTER_BASE } from './console'

// ── App ────────────────────────────────────────────────────────────────────
export function App() {
  const { isSignedIn } = useSession()
  if (!isSignedIn) {
    return (
      <><Style /><SignInFrame subtitle="Sign in to the admin console."><SignIn /></SignInFrame></>
    )
  }
  return <BrowserRouter basename={ROUTER_BASE}><Console /></BrowserRouter>
}

// ── THE CONSOLE, IN THREE LAYERS ──────────────────────────────────────────────────────────────────────────────────
// The platform (Superatom's own: organisations, engines, models, credentials) → an organisation (its projects, people,
// warehouse, usage, billing) → a project (its knowledge, data, agents, people, operations). Each place is a page with its
// own address — /, /o/<org>/<place>, /o/<org>/p/<project>/<place> — so a link or a reload lands on it. The sidebar holds
// the places of the layer you are in; the breadcrumbs the way up, each with a switcher.
function Console() {
  const token = useAuth()
  const role = useRole(token)
  const superadmin = role === 'superadmin'
  const loc = useLocation(); const nav = useNavigate()
  const m = /^\/o\/([^/]+)(?:\/p\/([^/]+)(?:\/(.*))?|\/([^/]+))?\/?$/.exec(loc.pathname)
  const org = m?.[1] ?? null, project = m?.[2] ?? null
  // Where you are in the layer: the place after the project, or after the organisation, or the platform's own place.
  const place = (project ? m?.[3] : org ? m?.[4] : loc.pathname.split('/')[1]) ?? ''
  const layer: 'platform' | 'org' | 'project' = project ? 'project' : org ? 'org' : 'platform'
  const api = useApi(token, null), orgApi = useApi(token, org)
  const [, bump] = useState(0)
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([])
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [orgCaps, setOrgCaps] = useState<string[] | null>(null)
  const [projCaps, setProjCaps] = useState<string[] | null>(null)
  useEffect(() => { if (!token) return; void api('/organizations').then((r) => (r.ok ? r.json() : [])).then((d: any) => { const os: any[] = Array.isArray(d) ? d : d?.organizations ?? []; for (const o of os) NAMES.set(o.id, o.name); setOrgs(os.map((o) => ({ id: o.id, name: o.name }))); bump((n) => n + 1) }).catch(() => {}) }, [token, api])
  useEffect(() => { setProjects([]); setOrgCaps(null); if (!token || !org) return
    void orgApi('/projects').then((r) => (r.ok ? r.json() : [])).then((ps: any[]) => { const list = (Array.isArray(ps) ? ps : []).filter((p) => !p.deleted); for (const p of list) NAMES.set(p.id, p.name); setProjects(list.map((p) => ({ id: p.id, name: p.name }))); bump((n) => n + 1) }).catch(() => {})
    void orgApi('/me').then((r) => (r.ok ? r.json() : null)).then((d: any) => setOrgCaps(d?.capabilities ?? [])).catch(() => setOrgCaps([])) }, [token, org, orgApi])
  useEffect(() => { setProjCaps(null); if (!token || !project) return; void api(`/projects/${project}/me`).then((r) => (r.ok ? r.json() : null)).then((d: any) => setProjCaps(d?.capabilities ?? [])).catch(() => setProjCaps([])) }, [token, project, api])
  const env = useMemo(() => ({ api, token, superadmin, openScreen: (path: string) => nav(path) }), [api, token, superadmin, nav])

  const orgName = org ? NAMES.get(org) ?? named(org, 'Organisation') : ''
  const projectName = project ? NAMES.get(project) ?? named(project, 'Project') : ''
  const P = (slug: string) => `/o/${org}/p/${project}${slug ? `/${slug}` : ''}`
  const O = (slug: string) => `/o/${org}${slug ? `/${slug}` : ''}`
  const item = (key: string, label: string, icon: string, to: string, active: boolean, title?: string) => ({ key, label, icon, active, onClick: () => nav(to), ...(title ? { title } : {}) })
  // The rail holds the layer's areas, each in its own (faded) colour; the panel the pages of the area picked. An area of
  // one page has no panel: its rail place opens the page.
  type Area = { key: string; label: string; icon: string; pages: { key: string; label: string; icon: string; to: string; active: boolean; title?: string }[] }
  const projectPlaces = purposesOf().map((g) => ({ ...g, places: g.places.filter((pl) => holds(projCaps, pl.needs)) })).filter((g) => g.places.length)
  const AREA_ICON: Record<string, string> = { knowledge: 'solar:lightbulb-bolt-linear', data: 'solar:database-linear', agents: 'solar:widget-linear', people: 'solar:users-group-rounded-linear', activity: 'solar:history-linear', engine: 'solar:server-square-linear', project: 'solar:folder-2-linear' }
  const page = (key: string, pl: Place, to: string, active: boolean) => ({ key, label: pl.label, icon: pl.icon, to, active, title: pl.says })
  const areas: Area[] = layer === 'platform' ? [
    ...PLATFORM_PLACES.filter((pl) => superadmin || pl.slug === '').filter((pl) => pl.slug !== 'credentials').map((pl) => ({ key: `pf-${pl.slug}`, label: pl.label, icon: pl.icon,
      pages: pl.slug === 'models' ? PLATFORM_PLACES.filter((x) => x.slug === 'models' || x.slug === 'credentials').map((x) => page(`pf-${x.slug}`, x, `/${x.slug}`, place === x.slug && !org)) : [page(`pf-${pl.slug}`, pl, `/${pl.slug}`, place === pl.slug && !org)] })),
  ] : layer === 'org' ? (() => {
    const at = (slug: string) => ORG_PLACES.find((pl) => pl.slug === slug && holds(orgCaps, pl.needs))
    const one = (slug: string, icon?: string): Area[] => { const pl = at(slug); return pl ? [{ key: `o-${slug}`, label: pl.label, icon: icon ?? pl.icon, pages: [page(`o-${slug}`, pl, O(slug), place === slug)] }] : [] }
    const money = ['usage', 'billing'].map(at).filter(Boolean) as Place[]
    return [
      { key: 'o-projects', label: 'Projects', icon: 'solar:folder-2-linear', pages: [page('o-', ORG_PLACES[0]!, O(''), place === ''), ...projects.slice(0, 12).map((p) => ({ key: `pr-${p.id}`, label: p.name, icon: 'solar:folder-linear', to: `/o/${org}/p/${p.id}`, active: false }))] },
      ...one('people'), ...one('warehouse'),
      ...(money.length ? [{ key: 'o-money', label: 'Usage and billing', icon: 'solar:wallet-linear', pages: money.map((pl) => page(`o-${pl.slug}`, pl, O(pl.slug), place === pl.slug)) }] : []),
      ...one('settings'),
    ]
  })() : [
    { key: 'p-attention', label: 'Attention', icon: 'solar:bell-linear', pages: [{ key: 'p-attention', label: 'Attention', icon: 'solar:bell-linear', to: P(''), active: place === '' }] },
    ...projectPlaces.map((g) => ({ key: `p-${g.key}`, label: g.title, icon: AREA_ICON[g.key] ?? 'solar:widget-linear', pages: g.places.map((pl) => page(`p-${pl.slug}`, pl, P(pl.slug), place === pl.slug)) })),
  ]
  // Search (⌘K, or the button in the panel's head): this layer's pages, one's organisations and this one's projects, the
  // platform's pages.
  // The project's socket (shared with every page of the project): its state top right, as in the workspace.
  const hub = useProjectHub(project ?? undefined, token)
  const connection = project ? <ConnectionStatus status={hub.status === 'live' ? 'open' : hub.status === 'connecting' ? 'connecting' : 'reconnecting'}
    message={hub.waking ? 'starting the engine' : hub.err || undefined} /> : undefined
  const [searching, setSearching] = useState(false)
  useSearchKey(useCallback(() => setSearching(true), []))
  const searchItems: SearchItem[] = [
    ...areas.flatMap((a) => a.pages.map((x) => ({ key: `pg:${x.key}`, label: x.label, sub: a.label === x.label ? undefined : a.label, icon: x.icon, group: layer === 'project' ? projectName : layer === 'org' ? orgName : 'Superatom', onSelect: () => nav(x.to) }))),
    ...projects.map((p) => ({ key: `pr:${p.id}`, label: p.name, sub: orgName, icon: 'solar:folder-linear', group: 'Projects', onSelect: () => nav(`/o/${org}/p/${p.id}`) })),
    ...orgs.map((o) => ({ key: `org:${o.id}`, label: o.name, icon: 'solar:buildings-2-linear', group: 'Organisations', onSelect: () => nav(`/o/${o.id}`) })),
    ...(superadmin && layer !== 'platform' ? PLATFORM_PLACES.map((pl) => ({ key: `pf:${pl.slug}`, label: pl.label, icon: pl.icon, group: 'Superatom', onSelect: () => nav(`/${pl.slug}`) })) : []),
    { key: 'me', label: 'Profile', icon: 'solar:user-circle-linear', group: 'You', onSelect: () => nav('/profile') },
  ]
  const searchButton = <button type="button" className="sa-icon-btn sa-icon-btn--lg" onClick={() => setSearching(true)} title="Search (⌘K)" aria-label="Search"><Icon icon="solar:magnifer-linear" /></button>
  const railPlaces: RailPlace[] = areas.map((a, i) => ({
    key: a.key, label: a.label, icon: a.icon, accent: `var(--place-${(i % 6) + 1})`, actions: searchButton,
    ...(a.pages.length === 1 ? { onClick: () => nav(a.pages[0]!.to) } : { panel: <NavList groups={[{ label: a.label, items: a.pages.map((x) => item(x.key, x.label, x.icon, x.to, x.active, x.title)) }]} /> }),
  }))
  const railAt = areas.find((a) => a.pages.some((x) => x.active))?.key ?? ''
  const layerHome = layer === 'project' ? P('') : layer === 'org' ? O('') : '/'
  const placeLabel = layer === 'project' ? (place === '' ? 'Attention' : purposesOf().flatMap((g) => g.places).find((pl) => pl.slug === place)?.label ?? place)
    : layer === 'org' ? ORG_PLACES.find((pl) => pl.slug === place)?.label ?? 'Projects' : place === 'profile' ? 'Profile' : PLATFORM_PLACES.find((pl) => pl.slug === place)?.label ?? 'Organisations'
  const crumbs: Crumb[] = [
    ...(superadmin ? [{ key: 'home', label: 'Superatom', icon: 'solar:home-angle-linear', onClick: () => nav('/'), choices: PLATFORM_PLACES.map((pl) => ({ key: pl.slug || 'orgs', label: pl.label, icon: pl.icon, active: layer === 'platform' && place === pl.slug, onClick: () => nav(`/${pl.slug}`) })) }] : []),
    ...(org ? [{ key: 'org', label: orgName, icon: 'solar:buildings-2-linear', onClick: () => nav(O('')), choices: orgs.map((o) => ({ key: o.id, label: o.name, icon: 'solar:buildings-2-linear', active: o.id === org, onClick: () => nav(`/o/${o.id}${layer === 'org' && place ? `/${place}` : ''}`) })) }] : []),
    ...(project ? [{ key: 'project', label: projectName, icon: 'solar:folder-2-linear', onClick: () => nav(P('')), choices: projects.map((p) => ({ key: p.id, label: p.name, icon: 'solar:folder-linear', active: p.id === project, onClick: () => nav(`/o/${org}/p/${p.id}${place ? `/${place}` : ''}`) })) }] : []),
    { key: 'place', label: placeLabel },
  ]
  const full = (layer === 'project' && (place === 'graph' || place === 'warehouse')) || (layer === 'org' && place === 'warehouse')
  return (
    <>
      <Style />
      {searching && <Search items={searchItems} placeholder="Search pages, projects, organisations…" onClose={() => setSearching(false)} />}
      <AppShell wide accent={railPlaces.find((p) => p.key === railAt)?.accent} crumbs={<Breadcrumbs items={crumbs} />} status={connection} sidebar={(collapsed, toggle) => (
        <RailSidebar name={layer === 'project' ? projectName : layer === 'org' ? orgName : 'Superatom'} places={railPlaces} current={railAt}
          pinned={!collapsed} onPin={(p) => toggle(!p)} onHome={() => nav(layerHome)} onMark={() => nav('/')} markTitle="Superatom"
          foot={<PersonMenu onProfile={() => nav('/profile')} />} />
      )}>
        <AdminContext.Provider value={env}>
          <div className={full ? 'sa-fullpage' : 'sa-console__page'}>
            {/* A page's cards can be arranged (Arrange, at the bottom): kept per place, the same for every organisation and project. */}
            <Arranged scope={`page:${loc.pathname.replace(/\/o\/[^/]+/, '/o/*').replace(/\/p\/[^/]+/, '/p/*')}`} className={full ? 'sa-fill' : undefined}>
            <PageGuard key={loc.pathname}><Routes>
              <Route path="/" element={superadmin ? <OrgListPage /> : <MyOrgLanding />} />
              <Route path="/engines" element={<EnginesPage />} />
              <Route path="/addresses" element={<AddressesPage />} />
              <Route path="/attention" element={<AttentionPage key="platform" />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/credentials" element={<CredentialsPage />} />
              <Route path="/profile" element={<ProfilePage superadmin={superadmin} orgs={orgs} />} />
              <Route path="/o/:orgId/p/:projectId/graph" element={<CompositionGraph projectId={project ?? ''} token={token} />} />
              <Route path="/o/:orgId/p/:projectId/warehouse" element={<ProjectWarehouse key={project ?? ''} projectId={project ?? ''} token={token} />} />
              <Route path="/o/:orgId/p/:projectId" element={<AttentionPage key={project ?? ''} projectId={project ?? undefined} />} />
              <Route path="/o/:orgId/p/:projectId/attention" element={<Moved to={(p) => p.replace(/\/attention$/, '')} />} />
              <Route path="/o/:orgId/p/:projectId/*" element={<ProjectDetailPage />} />
              <Route path="/o/:orgId/:tab?" element={<OrgDetailPage />} />
              {/* Earlier addresses land on their place. */}
              <Route path="/w/*" element={<Moved to={(p) => p.replace(/^\/w/, '') || '/'} />} />
              <Route path="/agents" element={<Moved to={() => '/models'} />} />
              <Route path="/org/:orgId/projects/:projectId/*" element={<Moved to={(p) => p.replace(/^\/org\/([^/]+)\/projects\/([^/]+)/, '/o/$1/p/$2').replace(/\/inspector\/composition$/, '/graph')} />} />
              <Route path="/org/:orgId" element={<Moved to={(p, q) => `/o/${p.split('/')[2]}${q.get('tab') && q.get('tab') !== 'projects' ? `/${q.get('tab') === 'users' ? 'people' : q.get('tab')}` : ''}`} />} />
              <Route path="/pro/:projectId/*" element={<ProjectMoved />} />
              <Route path="*" element={<Empty icon="lucide:map-pin-off">There is nothing at this address. <Link to="/">Go to the start</Link>.</Empty>} />
            </Routes></PageGuard>
            </Arranged>
          </div>
        </AdminContext.Provider>
      </AppShell>
      <Toasts />
    </>
  )
}

/** A page that fails says so, in its place — the sidebar, the breadcrumbs and every other page keep working. */
class PageGuard extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return <Notice state="critical" action={<button className="sa-btn" onClick={() => this.setState({ error: null })}>Try again</button>}>This page failed: {this.state.error.message}</Notice>
  }
}

/** An earlier address, sent to where its place is now. */
/** /pro/<project>/… — the project's organisation is asked for, then the address is the layered one. */
function ProjectMoved() {
  const token = useAuth(); const api = useApi(token); const loc = useLocation(); const nav = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const [lost, setLost] = useState(false)
  useEffect(() => {
    if (!token) return
    // The project says which organisation owns it.
    void (async () => {
      const rest = loc.pathname.replace(/^\/pro\/[^/]+/, '').replace(/^\/inspector\/composition$/, '/graph')
      const s: any = await api(`/projects/${projectId}/status`).then((r) => r.json()).catch(() => null)
      const org: string | null = s?.orgId ?? null
      if (org) nav(`/o/${org}/p/${projectId}${rest}`, { replace: true }); else setLost(true)
    })()
  }, [token])   // eslint-disable-line react-hooks/exhaustive-deps
  return lost ? <Empty icon="lucide:search-x">This project is not one of yours, or it no longer exists.</Empty> : <Empty icon="lucide:loader">Finding the project…</Empty>
}

/** Every project's engine across the platform, and whether it reports. */
function EnginesPage() {
  const token = useAuth(); const api = useApi(token); const nav = useNavigate()
  const [rows, setRows] = useState<{ projectId: string; project: string; org: string; orgId: string; running: boolean | null; engineVersion: { tag: string; publishedAt: string } | null; engineDigest: string | null }[] | null>(null)
  useEffect(() => { if (token) void api('/profiles').then((r) => (r.ok ? r.json() : null)).then((d: any) => setRows(Array.isArray(d?.projects) ? d.projects : [])).catch(() => setRows([])) }, [token, api])
  const list = rows ?? []
  return (
    <Shell>
      <PageHeader title="Engines" subtitle="Every project's engine, and whether it is reporting." />
      <Figures><Kpi label="Projects" value={list.length} loading={!rows} accent="series-1" /><Kpi label="Reporting" value={list.filter((r) => r.running).length} loading={!rows} accent="win" /><Kpi label="Silent" value={list.filter((r) => !r.running).length} loading={!rows} accent="warn" /></Figures>
      <RecordList rows={rows} search={(r) => `${r.project} ${r.org}`} searchLabel="Find a project or organisation…" pageSize={15} keyOf={(r) => r.projectId} onRow={(r) => nav(`/o/${r.orgId}/p/${r.projectId}/engine`)} columns={[
        { key: 'project', label: 'Project' }, { key: 'org', label: 'Organisation' },
        { key: 'running', label: 'Engine', render: (r) => <Status state={r.running ? 'ok' : 'attention'}>{r.running ? 'reporting' : 'not reporting'}</Status> },
        // WHICH VERSION, by when it was published — a date reads at a glance; the build's name is in the tooltip.
        { key: 'version', label: 'Engine version', render: (r) => r.engineVersion
          ? <span className="sa-num" title={r.engineVersion.tag}>{dateTime(r.engineVersion.publishedAt)}</span>
          : <span className="sa-muted">{r.running ? (r.engineDigest ? 'a version not in the registry' : 'an older engine (does not say)') : '—'}</span> },
      ]} />
    </Shell>
  )
}

/** Every address on superatom.site and the project it opens — the platform's to move or take back, whatever a project claimed. */
function AddressesPage() {
  const token = useAuth(); const api = useApi(token); const nav = useNavigate()
  type Project = { projectId: string; project: string; org: string; orgId: string }
  const [rows, setRows] = useState<{ subdomain: string; projectId: string }[] | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [moving, setMoving] = useState<{ subdomain: string; to: string } | null>(null)
  const [confirm, confirmDialog] = useConfirm()
  const [err, setErr] = useState('')
  const load = useCallback(() => {
    void api('/domains/all').then((r) => (r.ok ? r.json() : null)).then((d: any) => setRows(Array.isArray(d?.domains) ? d.domains : [])).catch(() => setRows([]))
    void api('/profiles').then((r) => (r.ok ? r.json() : null)).then((d: any) => setProjects(Array.isArray(d?.projects) ? d.projects : [])).catch(() => {})
  }, [api])
  useEffect(() => { if (token) load() }, [token, load])
  const of = (id: string) => projects.find((p) => p.projectId === id)
  const send = async (path: string, method: string, body: Record<string, unknown>) => {
    setErr('')
    const r = await api(path, { method, body: JSON.stringify(body) })
    if (!r.ok) { setErr(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Refused (${r.status})`); return false }
    load(); return true
  }
  const list = (rows ?? []).map((r) => ({ ...r, project: of(r.projectId)?.project ?? r.projectId, org: of(r.projectId)?.org ?? '—', orgId: of(r.projectId)?.orgId ?? '' }))
  return (
    <Shell>
      {confirmDialog}
      <PageHeader title="Addresses" subtitle="Every <name>.superatom.site and the project it opens. Move one to another project, or take it back." />
      {err && <Notice state="critical">{err}</Notice>}
      {moving && (
        <SectionCard icon="solar:global-linear" title={`Move ${moving.subdomain}.superatom.site`} subtitle={`Now: ${of(rows?.find((r) => r.subdomain === moving.subdomain)?.projectId ?? '')?.project ?? '—'}`}>
          <Form onSubmit={() => { void send('/domains/assign', 'PUT', { subdomain: moving.subdomain, projectId: moving.to }).then((ok) => ok && setMoving(null)) }}
            actions={<><button type="submit" className="sa-btn sa-btn--primary" disabled={!moving.to}>Move it</button><button type="button" className="sa-btn" onClick={() => setMoving(null)}>Cancel</button></>}>
            <Field label="To the project">
              <Select label="Project" value={moving.to} onChange={(to) => setMoving({ ...moving, to })} placeholder="Pick a project"
                options={projects.map((p) => ({ value: p.projectId, label: p.project, note: p.org }))} />
            </Field>
          </Form>
        </SectionCard>
      )}
      <RecordList rows={rows ? list : null} search={(r) => `${r.subdomain} ${r.project} ${r.org}`} searchLabel="Find an address or project…" pageSize={20} keyOf={(r) => r.subdomain} empty="No project has an address yet." columns={[
        { key: 'subdomain', label: 'Address', render: (r) => <a href={`https://${r.subdomain}.superatom.site`} target="_blank" rel="noreferrer">{r.subdomain}.superatom.site</a> },
        { key: 'project', label: 'Project', render: (r) => (r.orgId ? <button type="button" className="sa-btn sa-btn--link" onClick={() => nav(`/o/${r.orgId}/p/${r.projectId}`)}>{r.project}</button> : <Code>{r.project}</Code>) },
        { key: 'org', label: 'Organisation' },
        { key: 'act', label: '', align: 'end', render: (r) => (
          <span className="sa-row sa-row--tight">
            <button type="button" className="sa-btn sa-btn--link" onClick={() => setMoving({ subdomain: r.subdomain, to: '' })}>Move</button>
            <button type="button" className="sa-btn sa-btn--link" onClick={async () => { if (await confirm({ title: `Take ${r.subdomain}.superatom.site from ${r.project}?`, body: 'The address stops opening it at once.', confirm: 'Take back', danger: true })) void send('/domains/any', 'DELETE', { subdomain: r.subdomain }) }}>Take back</button>
          </span>) },
      ]} />
    </Shell>
  )
}

/** What needs a decision — a project's, or the platform's: each item opens its step below (the one place a thread helps). */
function AttentionPage({ projectId }: { projectId?: string }) {
  return <LocalThread blocks={ADMIN_OWN_BLOCKS} home={{ type: 'attention', props: projectId ? { projectId } : {} }} />
}
