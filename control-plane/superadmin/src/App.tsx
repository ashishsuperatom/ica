import { Component, useState, useEffect, useCallback, useMemo, useRef, createContext, useContext, useSyncExternalStore } from 'react'
import { cached as cacheRead, keep as cacheKeep, forget as cacheForget, changed as cacheChanged, revision as cacheRevision, subscribe as cacheSubscribe } from './cache'
import { loadToken, mintToken, dropToken, claimReauthOnce, tokenValid } from '../../shared/session-token'
import { Credentials } from './Credentials'
import { AgentsScreen } from './Models'
import { DashboardsPanel } from './Dashboards'
import { AgentKeysPanel, AuditPanel } from './AgentKeys'
import { AccessPoliciesPanel } from './AccessPolicies'
import { GroupsPanel } from './Groups'
import { WarehousePanel } from './Warehouse'
import { OrgPeoplePanel, OrgKeysPanel, ProjectAccessPanel } from './People'
import { CompositionGraph } from './CompositionGraph'
import { ProjectWarehouse } from './ProjectWarehouse'
import { BillingPanel } from './Billing'
import { UsagePanel } from './Usage'
import { useProjectHub } from './hub'
import { Inspector, SECTIONS, SECTION_LABEL, type Section } from './Inspector'
import { ConnectorConsole } from './ConnectorConsole'
import { GroundingConsole } from './GroundingConsole'
import { AnalystConsole } from './AnalystConsole'
import { useSession, SignIn, UserButton } from '@clerk/react'
import { BrowserRouter, Routes, Route, Link, useParams, useNavigate, useLocation } from 'react-router-dom'
import { modelOn } from '../../../vm/packages/agent-contract/contract.mjs'
import { AppShell, Sidebar, Breadcrumbs, Arranged, ChartFrame, type Crumb, LocalThread, Toasts, Section as SectionCard, Kpi, TimeColumns, Donut, PageHeader, Tabs, Notice, Code, Figures, RecordList, Receipt, Form, Field, Status, Empty, ActionBar, Icon, type StatusState, type Accent } from '@superatom/ui'
import '@superatom/ui/design.css'
import { AdminContext, ADMIN_OWN_BLOCKS } from './AdminBlocks'

// ── COPY, AND SAY SO ─────────────────────────────────────────────────────────
// Four copy buttons did their work in total silence. Copying a credential is the one moment you MUST know it
// worked: the value is shown once, and "did that copy?" cannot be answered by looking at the screen — so
// people click again, or paste into the wrong window and lose a key they can no longer see.
//
// It was worse than silent. Every one of them called `navigator.clipboard?.writeText(...)`, and the optional
// chaining means that where the clipboard API is missing — any insecure context, which includes plain http on
// a LAN box — the click did NOTHING and reported nothing. A button that silently does nothing is indis-
// tinguishable from one that worked, which is how you end up pasting a stale key you copied minutes ago.
//
// So: confirm on success, say so on failure, and fall back to selecting the text if there is no clipboard at
// all, because "select this and press ⌘C" is still an answer.
/** An event's detail as a reader takes it in: who and what kind of connection, else its fields as words — never raw JSON. */
function eventWords(detail: string | null | undefined): string {
  if (!detail) return ''
  let d: any
  try { d = JSON.parse(detail) } catch { return detail }
  if (!d || typeof d !== 'object') return String(d)
  const who = d.email ?? (typeof d.userId === 'string' ? d.userId.replace(/^user_/, '').slice(0, 8) + '…' : null)
  if (d.type && who) return `${d.type} · ${who}`
  return Object.entries(d).filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object').slice(0, 4).map(([k, v]) => `${k} ${String(v).slice(0, 40)}`).join(' · ')
}

function CopyButton({ text, label = 'Copy', className = 'sa-btn' }: { text: string; label?: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(t)
  }, [state])
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard in this context')
      await navigator.clipboard.writeText(text)
      setState('done')
    } catch { setState('failed') }
  }
  return (
    <button type="button" className={className} onClick={copy} title={state === 'failed' ? 'Select the text above and press ⌘C' : undefined}>
      <Icon icon={state === 'done' ? 'lucide:check' : state === 'failed' ? 'lucide:text-select' : 'lucide:copy'} className="sa-btn__icon" />
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Select it above and ⌘C' : label}
    </button>
  )
}


const VM_URL = import.meta.env.VITE_VM_URL ?? 'http://localhost:5050'

// ── Design system — Stripe dashboard look (injected once) ─────────────────────
const CSS = `
/* ONE DESIGN SYSTEM: the console's names, bound to the platform's tokens (@superatom/ui design/tokens.css, imported in
   main.tsx) — the same palette, type and radii as every other surface. The console keeps its own layout classes. */
:root{--purple:var(--primary);--purple-d:var(--primary-strong);--sub:var(--muted);
 --bg:var(--page);--card:var(--surface);--line2:var(--panel);
 --ok:var(--win-ink);--okbg:var(--win-wash);--warnbg:var(--warn-wash);--bad:var(--loss);--brand:var(--primary);--faint2:var(--faint);--accent:var(--primary)}
*{box-sizing:border-box}
body{margin:0;font-family:var(--font);font-feature-settings:var(--font-features);
 background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;font-size:var(--t-base)}
a{color:var(--purple);text-decoration:none}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}

/* layout: fixed left sidebar + main. The sidebar is the ONLY nav — sub-sections expand
   inline underneath their parent item, so the content pane keeps the full remaining width. */
.app{display:flex;min-height:100vh}
.side{width:212px;flex-shrink:0;background:#fff;border-right:1px solid var(--line);
 display:flex;flex-direction:column;position:sticky;top:0;height:100vh}
.side .org{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid var(--line2);cursor:default}
.side .avatar{width:27px;height:27px;border-radius:7px;background:var(--purple);color:#fff;
 display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12.5px;flex-shrink:0}
.side .org .nm{font-size:13px;font-weight:600;color:var(--ink);line-height:1.25}
.side .org .sub{font-size:11px;color:var(--faint)}
.side nav{padding:6px;flex:1;overflow-y:auto}
.side .grp{font-size:10.5px;font-weight:600;color:var(--faint);text-transform:uppercase;letter-spacing:.04em;padding:11px 9px 4px}
.side .nav{display:flex;align-items:center;gap:9px;padding:6px 9px;border-radius:7px;
 font-size:13.5px;color:var(--ink);font-weight:500;cursor:pointer;margin-bottom:1px}
.side .nav:hover{background:#f6f8fb}
.side .nav.on{background:var(--primary-wash);color:var(--purple);font-weight:600}
.side .nav svg{width:16px;height:16px;flex-shrink:0;opacity:.85}
/* expander chevron + the nested sub-items it reveals */
.side .chev{margin-left:auto;width:11px;height:11px;opacity:.55;transition:transform .15s}
.side .chev.open{transform:rotate(90deg)}
.side .subnav{display:block;margin-left:20px;padding:5px 9px 5px 11px;border-left:1px solid var(--line);
 font-size:13px;color:var(--sub);cursor:pointer;border-radius:0 6px 6px 0}
.side .subnav:hover{background:#f6f8fb;color:var(--ink)}
.side .subnav.on{background:var(--primary-wash);color:var(--purple);font-weight:600;border-left-color:var(--purple)}
.side .foot{border-top:1px solid var(--line2);padding:9px 12px;display:flex;align-items:center;gap:10px}
/* a console screen inside a block of the admin workspace: its section links as a row of actions, its content padded */
.admin-block{min-width:0}
.admin-block__nav.side{width:auto;height:auto;position:static;border:0;border-bottom:1px solid var(--line);flex-direction:row;flex-wrap:wrap;gap:2px 4px;padding:8px 12px;background:var(--surface-subtle)}
.admin-block__nav.side .grp{display:none}
.admin-block__nav.side .nav{margin:0;padding:4px 9px;font-size:12.5px}
.admin-block__nav.side .subnav{margin-left:0;border-left:0;padding:4px 9px;border-radius:6px}
.admin-block .content{padding:14px 16px}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:12px;padding:8px 20px;border-bottom:1px solid var(--line);
 background:#fff;position:sticky;top:0;z-index:5;min-height:44px}
.content{padding:16px 20px 40px;width:100%;min-width:0}
.signin{max-width:420px;margin:110px auto;padding:0 16px;text-align:center}
`

function Style() { return <style dangerouslySetInnerHTML={{ __html: CSS }} /> }

// minimal Stripe-ish line icons
const I = {
  key: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><circle cx="7.5" cy="15.5" r="3.5"/><path d="M10 13 20 3M17 6l2 2M14 9l2 2"/></svg>,
  home: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>,
  grid: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8M20.5 20a5 5 0 0 0-4-4.9"/></svg>,
  map: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="9" r="2.5"/><circle cx="9" cy="18" r="2.5"/><path d="M8 7l8 1.5M8.5 16l8-6"/></svg>,
  chev: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M9 5l7 7-7 7"/></svg>,
  pulse: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>,
  globe: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/></svg>,
  term: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>,
  chat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>,
}

// a machine's or a thing's state word → the state it is in
const STATE_OF: Record<string, StatusState> = {
  started: 'ok', running: 'ok', active: 'ok', online: 'ok',
  starting: 'attention', created: 'attention', creating: 'attention', pending: 'attention',
  suspended: 'attention', stopping: 'attention', stopped: 'neutral',
  destroyed: 'critical', destroying: 'critical',
}
function Pill({ s }: { s?: string }) {
  return <Status state={STATE_OF[s ?? ''] ?? 'neutral'}>{s ?? 'unknown'}</Status>
}

/** Where a page is: its trail of places, the last one the page itself. */
function ago(ms: number) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// ── auth / api ───────────────────────────────────────────────────────────────
// Read a JWT's exp (unix seconds); 0 if unparseable → treated as expired.
// ── Where are we, and who is looking? ───────────────────────────────────────
// superadmin.superatom.site — the platform console (org creation, every org).
// admin.superatom.site      — the customer console: /org/<orgId> and /pro/<projectId>. The path says which,
//                             so nothing has to be looked up to know what is being viewed.
// The apex still serves the app under /admin/ (unchanged), so the basename follows the host.
export const HOST_SCOPE: 'superadmin' | 'admin' | 'apex' =
  /^superadmin\./.test(location.host) ? 'superadmin' : /^admin\./.test(location.host) ? 'admin' : 'apex'
export const ROUTER_BASE = HOST_SCOPE === 'apex' ? '/admin' : ''

/** The platform role carried by our own JWT. Superadmin features are not RENDERED without it — and the API
 *  refuses them regardless, so this only decides what is worth showing. */
export function useRole(token: string | null): 'superadmin' | 'user' | null {
  return useMemo(() => {
    if (!token) return null
    try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role ?? 'user' }
    catch { return null }
  }, [token])
}

function useAuth() {
  const { session } = useSession()
  const [token, setToken] = useState<string | null>(loadToken)
  useEffect(() => {
    // Re-exchange whenever we lack a VALID token (missing OR expired) and a Clerk session is available.
    if (tokenValid(token) || !session) return
    session.getToken().then((ct) => mintToken(ct).then((t) => { if (t) setToken(t) }))
  }, [session, token])
  return token
}
/** Reads that change by the second (a machine's state, its event log) are always asked fresh, never shown from the cache. */
const LIVE = /\/(status|logs|attention)(\?|$)/
function useApi(token: string | null, orgId?: string | null) {
  // The console's cache (cache.ts): a read is shown from this browser at once, asked of the server every time, and
  // replaced when the server says something else — every reader then reads again, getting the fresh copy at once.
  const rev = useSyncExternalStore(cacheSubscribe, cacheRevision)
  return useCallback(async (path: string, init?: RequestInit) => {
    const who = (() => { try { const c = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return String(c.email ?? c.userId ?? '') } catch { return '' } })()
    const scope = `${who}|${orgId ?? ''}|`
    const read = !init?.method || init.method === 'GET'
    const ask = async () => {
      const res = await fetch(`/api${path}`, {
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(orgId ? { 'x-org-id': orgId } : {}) },
        ...init,
      })
      // Self-heal: a 401 means the token was rejected (expired mid-session). Drop it and re-exchange on
      // reload. The sessionStorage guard prevents a reload loop if re-exchange also fails (dead Clerk session).
      if (res.status === 401 && claimReauthOnce()) {
        dropToken()
        location.reload()
      }
      return res
    }
    if (!read) { const res = await ask(); if (res.ok) cacheForget(scope); return res }
    if (!token || LIVE.test(path)) return ask()
    const key = scope + path
    const before = cacheRead(key)
    const fresh = ask().then(async (res) => {
      if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
        const text = await res.clone().text()
        if (text !== before) { cacheKeep(key, text); if (before !== null) cacheChanged(key) }
      }
      return res
    })
    if (before === null) return fresh
    void fresh.catch(() => {})
    return new Response(before, { status: 200, headers: { 'content-type': 'application/json' } })
  }, [token, orgId, rev])   // eslint-disable-line react-hooks/exhaustive-deps
}

/** Pages are drawn inside the console's layout (its sidebar and breadcrumbs are the way around), so a page draws its
 *  content only. */
const ShellMode = createContext<'page' | 'block'>('block')

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-block">
      <div className="content"><div className="sa-stack sa-stack--4">{children}</div></div>
    </div>
  )
}

// ── App ────────────────────────────────────────────────────────────────────
export function App() {
  const { isSignedIn } = useSession()
  if (!isSignedIn) {
    return (
      <><Style /><div className="signin">
        <div className="sa-stack sa-stack--4">
          <PageHeader title="Superatom" subtitle="Sign in to the admin console." />
          <SignIn />
        </div>
      </div></>
    )
  }
  return <BrowserRouter basename={ROUTER_BASE}><Console /></BrowserRouter>
}

// ── THE CONSOLE, IN THREE LAYERS ──────────────────────────────────────────────────────────────────────────────────
// The platform (Superatom's own: organisations, engines, models, credentials) → an organisation (its projects, people,
// warehouse, usage, billing) → a project (its knowledge, data, agents, people, operations). Each place is a page with its
// own address — /, /o/<org>/<place>, /o/<org>/p/<project>/<place> — so a link or a reload lands on it. The sidebar holds
// the places of the layer you are in; the breadcrumbs the way up, each with a switcher.
const NAMES = new Map<string, string>()
const named = (id: string, kind: string) => NAMES.get(id) ?? `${kind} ${id.slice(0, 8)}`

interface Place { slug: string; label: string; icon: string; says: string; needs?: string }
/** The places of a project, by purpose — the order the work happens in — each with what it needs of the person. */
function purposesOf(): { key: string; title: string; places: Place[] }[] {
  return [
    { key: 'knowledge', title: 'Knowledge', places: [
      { slug: 'graph', label: 'Composition graph', icon: 'lucide:network', says: 'Domains, intermediate and atomic concepts — walk, change and compose them.', needs: 'project.manage' },
      { slug: 'inspector/changes', label: 'Graph changes', icon: 'lucide:git-commit-horizontal', says: 'Every edit to the graph: which node, by whom, why.', needs: 'project.manage' },
      { slug: 'inspector/questions', label: 'Questions', icon: 'lucide:message-circle-question', says: 'Every question and the agent it went to.', needs: 'project.manage' },
      { slug: 'inspector/sessions', label: 'Sessions', icon: 'lucide:messages-square', says: 'Each chat made from the graph, and what changed since.', needs: 'project.manage' }] },
    { key: 'data', title: 'Data', places: [
      { slug: 'warehouse', label: 'Warehouse', icon: 'lucide:warehouse', says: 'The organisation\'s tables granted to this project: rows, columns, values.', needs: 'warehouse.use' },
      { slug: 'index', label: 'Data index', icon: 'lucide:table-properties', says: 'Every source, its tables and fields.', needs: 'project.manage' },
      { slug: 'inspector/grounding', label: 'Grounding', icon: 'lucide:anchor', says: 'Names people use, matched to the records they mean.', needs: 'project.manage' },
      { slug: 'inspector/index', label: 'Datasource index', icon: 'lucide:list-tree', says: 'What the engine indexed of each source.', needs: 'project.manage' },
      { slug: 'data-access', label: 'Data access', icon: 'lucide:shield-check', says: 'Rows, columns and denials per person, role, group or key.', needs: 'project.data' }] },
    { key: 'agents', title: 'Agents', places: [
      { slug: 'agents', label: 'Agents and models', icon: 'lucide:cpu', says: 'The harness, account and model each agent runs.', needs: 'project.manage' },
      { slug: 'agent', label: 'Connector', icon: 'lucide:plug', says: 'Connect a data source with the connector agent.', needs: 'project.manage' },
      { slug: 'analyst', label: 'Analyst', icon: 'lucide:search', says: 'Explore the data with the analyst.', needs: 'project.manage' },
      { slug: 'grounding', label: 'Grounding agent', icon: 'lucide:bot', says: 'Build the grounding.', needs: 'project.manage' }] },
    { key: 'people', title: 'People', places: [
      { slug: 'access', label: 'Access and roles', icon: 'lucide:users', says: 'Who works in the project, and as what.', needs: 'project.people' },
      { slug: 'groups', label: 'Groups', icon: 'lucide:users-round', says: 'Groups and their members.', needs: 'project.people' },
      { slug: 'agent-keys', label: 'Agent keys', icon: 'lucide:key-round', says: 'Keys agents and scripts use, and their scopes.', needs: 'project.keys' }] },
    { key: 'operations', title: 'Operations', places: [
      { slug: '', label: 'Engine', icon: 'lucide:gauge', says: 'The engine: compute, state, connections.', needs: 'project.view' },
      { slug: 'events', label: 'Event log', icon: 'lucide:list', says: 'What the project did.', needs: 'project.audit' },
      { slug: 'audit', label: 'Audit history', icon: 'lucide:history', says: 'Who did what, and how it ended.', needs: 'project.audit' },
      { slug: 'dashboards', label: 'Dashboards', icon: 'lucide:layout-dashboard', says: 'Published dashboards and their builds.', needs: 'project.view' },
      { slug: 'subdomains', label: 'Addresses', icon: 'lucide:globe', says: 'The project\'s addresses.', needs: 'project.manage' },
      { slug: 'channels', label: 'Channels', icon: 'lucide:message-square', says: 'Teams and other channels.', needs: 'project.manage' },
      { slug: 'inspector/summary', label: 'Engine contents', icon: 'lucide:scan-search', says: 'What the engine holds, at a glance.', needs: 'project.manage' },
      { slug: 'inspector/files', label: 'Files', icon: 'lucide:folder-tree', says: 'The project\'s files on the engine.', needs: 'project.manage' },
      { slug: 'inspector/db', label: 'Database', icon: 'lucide:database', says: 'The engine\'s tables.', needs: 'project.manage' },
      { slug: 'inspector/logs', label: 'Logs', icon: 'lucide:scroll-text', says: 'The engine\'s logs.', needs: 'project.manage' },
      { slug: 'settings', label: 'Settings', icon: 'lucide:settings-2', says: 'Keys, the agent profile, the danger zone.', needs: 'project.manage' }] },
  ]
}
/** The places of an organisation. */
const ORG_PLACES: Place[] = [
  { slug: '', label: 'Projects', icon: 'lucide:folder-kanban', says: 'Its projects.' },
  { slug: 'people', label: 'People and roles', icon: 'lucide:users', says: 'Who is in it, and as what.', needs: 'org.people' },
  { slug: 'warehouse', label: 'Warehouse', icon: 'lucide:warehouse', says: 'Its tables, what each project may read and write, its keys.', needs: 'warehouse' },
  { slug: 'usage', label: 'Usage and credits', icon: 'lucide:gauge', says: 'What its people used.' },
  { slug: 'billing', label: 'Billing', icon: 'lucide:receipt', says: 'Who it is billed as, how it pays.', needs: 'org.billing' },
  { slug: 'settings', label: 'Settings', icon: 'lucide:settings-2', says: 'The organisation itself.', needs: 'org.roles' },
]
/** The platform's places (Superatom's own). */
const PLATFORM_PLACES: Place[] = [
  { slug: '', label: 'Organisations', icon: 'lucide:building-2', says: 'Every organisation and its owners.' },
  { slug: 'engines', label: 'Engines', icon: 'lucide:server', says: 'Every project\'s engine, and whether it reports.' },
  { slug: 'attention', label: 'Attention', icon: 'lucide:bell', says: 'What needs a decision.' },
  { slug: 'models', label: 'Models and agents', icon: 'lucide:cpu', says: 'The model catalogue and the agents\' harnesses.' },
  { slug: 'credentials', label: 'Credentials', icon: 'lucide:key-round', says: 'The accounts models are reached through.' },
]
const holds = (caps: string[] | null, needs?: string) => !needs || !caps ? true : needs === 'warehouse' ? caps.some((c) => c.startsWith('warehouse.')) : caps.includes(needs)

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
  const projectPlaces = purposesOf().map((g) => ({ ...g, places: g.places.filter((pl) => holds(projCaps, pl.needs)) })).filter((g) => g.places.length)
  const groups = layer === 'platform' ? [
    { label: 'Superatom', items: PLATFORM_PLACES.filter((pl) => superadmin || pl.slug === '').map((pl) => item(`pf-${pl.slug}`, pl.label, pl.icon, `/${pl.slug}`, place === pl.slug && !org, pl.says)) },
  ] : layer === 'org' ? [
    ...(superadmin ? [{ items: [item('up', 'Superatom', 'lucide:arrow-left', '/', false)] }] : []),
    { label: orgName, items: ORG_PLACES.filter((pl) => holds(orgCaps, pl.needs)).map((pl) => item(`o-${pl.slug}`, pl.label, pl.icon, O(pl.slug), place === pl.slug, pl.says)) },
    // A few projects to jump straight to; all of them are on the organisation's Projects page (searchable, paged).
    ...(projects.length ? [{ label: 'Projects', items: [...projects.slice(0, 8).map((p) => item(`pr-${p.id}`, p.name, 'lucide:folder', `/o/${org}/p/${p.id}`, false)),
      ...(projects.length > 8 ? [item('pr-all', `All ${projects.length} projects`, 'lucide:list', O(''), false)] : [])] }] : []),
  ] : [
    { items: [item('up', orgName, 'lucide:arrow-left', O(''), false, `Back to ${orgName}`)] },
    { label: projectName, items: [item('p-attention', 'Attention', 'lucide:bell', P('attention'), place === 'attention')] },
    ...projectPlaces.map((g) => ({ label: g.title, items: g.places.map((pl) => item(`p-${pl.slug}`, pl.label, pl.icon, P(pl.slug), place === pl.slug, pl.says)) })),
  ]
  const placeLabel = layer === 'project' ? (place === 'attention' ? 'Attention' : purposesOf().flatMap((g) => g.places).find((pl) => pl.slug === place)?.label ?? 'Engine')
    : layer === 'org' ? ORG_PLACES.find((pl) => pl.slug === place)?.label ?? 'Projects' : PLATFORM_PLACES.find((pl) => pl.slug === place)?.label ?? 'Organisations'
  const crumbs: Crumb[] = [
    ...(superadmin ? [{ key: 'home', label: 'Superatom', icon: 'lucide:house', onClick: () => nav('/'), choices: PLATFORM_PLACES.map((pl) => ({ key: pl.slug || 'orgs', label: pl.label, icon: pl.icon, active: layer === 'platform' && place === pl.slug, onClick: () => nav(`/${pl.slug}`) })) }] : []),
    ...(org ? [{ key: 'org', label: orgName, icon: 'lucide:building', onClick: () => nav(O('')), choices: orgs.map((o) => ({ key: o.id, label: o.name, icon: 'lucide:building', active: o.id === org, onClick: () => nav(`/o/${o.id}${layer === 'org' && place ? `/${place}` : ''}`) })) }] : []),
    ...(project ? [{ key: 'project', label: projectName, icon: 'lucide:folder-kanban', onClick: () => nav(P('')), choices: projects.map((p) => ({ key: p.id, label: p.name, icon: 'lucide:folder', active: p.id === project, onClick: () => nav(`/o/${org}/p/${p.id}${place ? `/${place}` : ''}`) })) }] : []),
    { key: 'place', label: placeLabel },
  ]
  const full = (layer === 'project' && (place === 'graph' || place === 'warehouse')) || (layer === 'org' && place === 'warehouse')
  return (
    <>
      <Style />
      <AppShell wide crumbs={<Breadcrumbs items={crumbs} />} sidebar={(collapsed, toggle) => (
        <Sidebar name={layer === 'project' ? projectName : layer === 'org' ? orgName : 'Superatom'} connected groups={groups} collapsed={collapsed} onToggle={toggle} foot={() => <UserButton />} />
      )}>
        <AdminContext.Provider value={env}>
          <div className={full ? 'sa-fullpage' : 'sa-console__page'}>
            {/* A page's cards can be arranged (Arrange, at the bottom): kept per place, the same for every organisation and project. */}
            <Arranged scope={`page:${loc.pathname.replace(/\/o\/[^/]+/, '/o/*').replace(/\/p\/[^/]+/, '/p/*')}`} className={full ? 'sa-fill' : undefined}>
            <PageGuard key={loc.pathname}><Routes>
              <Route path="/" element={superadmin ? <OrgListPage /> : <MyOrgLanding />} />
              <Route path="/engines" element={<EnginesPage />} />
              <Route path="/attention" element={<AttentionPage key="platform" />} />
              <Route path="/models" element={<ModelsPage />} />
              <Route path="/credentials" element={<CredentialsPage />} />
              <Route path="/o/:orgId/p/:projectId/graph" element={<CompositionGraph projectId={project ?? ''} token={token} />} />
              <Route path="/o/:orgId/p/:projectId/warehouse" element={<ProjectWarehouse key={project ?? ''} projectId={project ?? ''} token={token} />} />
              <Route path="/o/:orgId/p/:projectId/attention" element={<AttentionPage key={project ?? ''} projectId={project ?? undefined} />} />
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
function Moved({ to }: { to: (path: string, q: URLSearchParams) => string }) {
  const loc = useLocation(); const nav = useNavigate()
  useEffect(() => { nav(to(loc.pathname, new URLSearchParams(loc.search)), { replace: true }) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
/** /pro/<project>/… — the project's organisation is asked for, then the address is the layered one. */
function ProjectMoved() {
  const token = useAuth(); const api = useApi(token); const loc = useLocation(); const nav = useNavigate()
  const { projectId } = useParams<{ projectId: string }>()
  const [lost, setLost] = useState(false)
  useEffect(() => {
    if (!token) return
    // The project says which organisation owns it; one that does not know is found in the person's projects.
    void (async () => {
      const rest = loc.pathname.replace(/^\/pro\/[^/]+/, '').replace(/^\/inspector\/composition$/, '/graph')
      const s: any = await api(`/projects/${projectId}/status`).then((r) => r.json()).catch(() => null)
      let org: string | null = s?.orgId ?? null
      if (!org) { const mine: any = await api('/me/projects').then((r) => r.json()).catch(() => null); org = (Array.isArray(mine) ? mine : []).find((o: any) => (o.projects ?? []).some((p: any) => p.id === projectId))?.org?.id ?? null }
      if (org) nav(`/o/${org}/p/${projectId}${rest}`, { replace: true }); else setLost(true)
    })()
  }, [token])   // eslint-disable-line react-hooks/exhaustive-deps
  return lost ? <Empty icon="lucide:search-x">This project is not one of yours, or it no longer exists.</Empty> : <Empty icon="lucide:loader">Finding the project…</Empty>
}

/** Every project's engine across the platform, and whether it reports. */
function EnginesPage() {
  const token = useAuth(); const api = useApi(token); const nav = useNavigate()
  const [rows, setRows] = useState<{ projectId: string; project: string; org: string; orgId: string; running: boolean | null }[] | null>(null)
  useEffect(() => { if (token) void api('/profiles').then((r) => (r.ok ? r.json() : null)).then((d: any) => setRows(Array.isArray(d?.projects) ? d.projects : [])).catch(() => setRows([])) }, [token, api])
  const list = rows ?? []
  return (
    <Shell>
      <PageHeader title="Engines" subtitle="Every project's engine, and whether it is reporting." />
      <Figures><Kpi label="Projects" value={list.length} loading={!rows} accent="series-1" /><Kpi label="Reporting" value={list.filter((r) => r.running).length} loading={!rows} accent="win" /><Kpi label="Silent" value={list.filter((r) => !r.running).length} loading={!rows} accent="warn" /></Figures>
      <RecordList rows={rows} search={(r) => `${r.project} ${r.org}`} searchLabel="Find a project or organisation…" pageSize={15} keyOf={(r) => r.projectId} onRow={(r) => nav(`/o/${r.orgId}/p/${r.projectId}`)} columns={[
        { key: 'project', label: 'Project' }, { key: 'org', label: 'Organisation' },
        { key: 'running', label: 'Engine', render: (r) => <Status state={r.running ? 'ok' : 'attention'}>{r.running ? 'reporting' : 'not reporting'}</Status> },
      ]} />
    </Shell>
  )
}

/** What needs a decision — a project's, or the platform's: each item opens its step below (the one place a thread helps). */
function AttentionPage({ projectId }: { projectId?: string }) {
  return <LocalThread blocks={ADMIN_OWN_BLOCKS} home={{ type: 'attention', props: projectId ? { projectId } : {} }} />
}

// ── A dialog over the page ───────────────────────────────────────────────────
// The design system has no dialog yet: this is the one place that draws the scrim, and everything inside is a Section.
function Dialog({ icon, accent, title, subtitle, onClose, footer, children }: {
  icon: string; accent?: Accent; title: string; subtitle?: string; onClose: () => void; footer?: React.ReactNode; children: React.ReactNode
}) {
  return (
    <div role="dialog" aria-modal="true" aria-label={title} onClick={onClose} className="sa-dialog">
      <div className="sa-dialog__frame" onClick={(e) => e.stopPropagation()}>
        <SectionCard icon={icon} accent={accent} title={title} subtitle={subtitle} footer={footer}>{children}</SectionCard>
      </div>
    </div>
  )
}

/** Values shown once, one per line, to be copied exactly; focusing them selects them all (the copy button's fallback). */
function EnvBlock({ text }: { text: string }) {
  return (
    <div className="sa-stack sa-stack--3" tabIndex={0} aria-label="Values to copy" onFocus={(e) => window.getSelection()?.selectAllChildren(e.currentTarget)}>
      {text.split('\n').map((l) => <Code key={l}>{l}</Code>)}
    </div>
  )
}

/** "Show deleted" — a filter on a list, in its section's head. */
function ShowDeleted({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return <label className="sa-row sa-row--tight sa-muted"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /> Show deleted</label>
}

// ── Destructive-action guard ─────────────────────────────────────────────────
// A delete is NEVER one click from a list. This modal spells out the consequences and only arms the
// Delete button once the user has typed the exact resource name — so deletion is always deliberate.
function ConfirmDelete({ kind, name, consequences, onConfirm, onClose }: {
  kind: string; name: string; consequences: string[]; onConfirm: () => void | Promise<void>; onClose: () => void
}) {
  const [typed, setTyped] = useState(''); const [busy, setBusy] = useState(false)
  const armed = typed.trim() === name
  const run = async () => { if (!armed || busy) return; setBusy(true); try { await onConfirm() } finally { setBusy(false) } }
  return (
    <Dialog icon="lucide:trash-2" accent="loss" title={`Delete ${kind} “${name}”?`} onClose={onClose}>
      <div className="sa-section__body"><Notice state="critical">This can’t be undone from here. Deleting will:</Notice></div>
      <ul className="sa-notes">{consequences.map((c, i) => <li key={i}>{c}</li>)}</ul>
      <Form onSubmit={() => void run()}
        actions={<><button type="button" className="sa-btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="sa-btn sa-btn--danger sa-btn--primary" disabled={!armed || busy}>{busy ? 'Deleting…' : `Delete ${kind}`}</button></>}>
        <Field label={`Type ${name} to confirm`}>
          <input className="sa-input" value={typed} onChange={e => setTyped(e.target.value)} placeholder={name} autoFocus />
        </Field>
      </Form>
    </Dialog>
  )
}

// ── Org list ─────────────────────────────────────────────────────────────────
// Landing for admin.superatom.site. The API already returns only the orgs this person belongs to, so the
// common case (exactly one) goes straight there and the URL becomes /org/<id> as if they had typed it.
// Someone in several orgs picks; someone in none is told, rather than shown an empty console.
function MyOrgLanding() {
  const token = useAuth(); const api = useApi(token)
  const [orgs, setOrgs] = useState<any[] | null>(null)
  const nav = useNavigate()
  useEffect(() => {
    if (!token) return
    api('/organizations?deleted=0').then(r => r.json()).then((d: any) => {
      const list: any[] = Array.isArray(d) ? d : (d?.organizations ?? [])
      setOrgs(list)
      if (list.length === 1) nav(`/o/${list[0].id}`, { replace: true })
    }).catch(() => setOrgs([]))
  }, [token, api, nav])

  if (!orgs) return <Shell><Empty icon="lucide:loader">Reading your organisations…</Empty></Shell>
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

const ORG_ACCENTS: Accent[] = ['series-1', 'series-2', 'series-3', 'warn', 'win']
type ProjectCard = { id: string; name: string; orgId: string; running: boolean | null }

/** A project as a card: its name, whether its engine is running, and where it opens. */
function ProjectCardButton({ p, onOpen }: { p: ProjectCard; onOpen: () => void }) {
  const state: StatusState = p.running === null ? 'neutral' : p.running ? 'ok' : 'attention'
  return (
    <button type="button" className="sa-sub-card" onClick={onOpen} title={`Open ${p.name}`}>
      <span className="sa-sub-card__title"><span className="sa-row sa-row--tight"><Icon icon="lucide:folder-kanban" />{p.name}</span></span>
      <span className="sa-sub-card__text"><Status state={state}>{p.running === null ? 'engine not known' : p.running ? 'engine running' : 'engine has not reported'}</Status></span>
    </button>
  )
}

function OrgListPage() {
  const token = useAuth(); const api = useApi(token)
  const [orgs, setOrgs] = useState<any[] | null>(null); const [showDeleted, setShowDeleted] = useState(false)
  const [projects, setProjects] = useState<ProjectCard[] | null>(null)
  const [making, setMaking] = useState(false)
  const [draft, setDraft] = useState({ name: '', adminEmail: '' })
  const [err, setErr] = useState('')
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
        actions={HOST_SCOPE !== 'admin' ? <button className="sa-btn sa-btn--primary" onClick={() => setMaking(true)}><Icon icon="lucide:plus" /> New organisation</button> : undefined} />
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
function ModelsPage() {
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
function CredentialsPage() {
  const token = useAuth(); const api = useApi(token)
  return (
    <Shell>
      <PageHeader title="Credentials" subtitle="The keys the coding agents use, and who may use them. Stored sealed; values are never shown here." />
      <Credentials api={api} />
    </Shell>
  )
}

function OrgDetailPage() {
  const token = useAuth(); const { orgId, tab: place } = useParams<{ orgId: string; tab?: string }>(); const api = useApi(token, orgId)
  // The place is in the address: /o/<org>/<place> (people, warehouse, usage, billing, settings; none = its projects).
  const tab = (place === 'people' ? 'users' : place ?? 'projects') as 'projects' | 'users' | 'usage' | 'warehouse' | 'billing' | 'settings'
  const setSearch = (q: { tab: string }) => nav(`/o/${orgId}${q.tab === 'projects' ? '' : `/${q.tab === 'users' ? 'people' : q.tab}`}`)
  const inBlock = useContext(ShellMode) === 'block'
  const [projects, setProjects] = useState<any[]>([]); const [users, setUsers] = useState<any[]>([])
  const [showDeleted, setShowDeleted] = useState(false); const nav = useNavigate()
  const [conn, setConn] = useState<{ id: string; apiKey: string; wsUrl: string } | null>(null)   // external-project connection info (copyable panel)
  const [newProject, setNewProject] = useState({ name: '', provider: 'fly' })
  const [makingProject, setMakingProject] = useState(false)
  const [newUser, setNewUser] = useState({ email: '', name: '', role: 'user' })
  // Teams-token generation moved to the PROJECT's Settings view. Here we only need the org NAME (for the
  // type-to-confirm delete) + the Danger-zone modal toggle.
  const [orgName, setOrgName] = useState(''); const [delOrg, setDelOrg] = useState(false)
  useEffect(() => { if (token) api('/organizations').then(r => r.json()).then((os: any[]) => setOrgName(Array.isArray(os) ? (os.find(o => o.id === orgId)?.name ?? '') : '')).catch(() => {}) }, [token, api, orgId])
  const [projectsRead, setProjectsRead] = useState(false)
  const fetchProjects = useCallback(() => { if (token) api(`/projects?deleted=${showDeleted ? '1' : '0'}`).then(r => r.json()).then((d) => { setProjects(Array.isArray(d) ? d : []); setProjectsRead(true) }).catch(() => setProjectsRead(true)) }, [token, api, showDeleted])
  const [usersRead, setUsersRead] = useState(false)
  useEffect(() => { if (!token) return; fetchProjects(); api('/users').then(r => (r.ok ? r.json() : [])).then((d) => { setUsers(Array.isArray(d) ? d : []); setUsersRead(true) }).catch(() => setUsersRead(true)) }, [token, api, fetchProjects])
  async function createProject() {
    const provider = newProject.provider || 'fly'   // 'fly' = managed machine · 'external' = local/EC2 (you run the engine)
    const r = await api('/projects', { method: 'POST', body: JSON.stringify({ name: newProject.name, provider, createdBy: 'superadmin' }) })
    const p = await r.json(); setNewProject({ name: '', provider: 'fly' }); fetchProjects()
    // External = no Fly machine → show the connection info in a copyable panel (key is shown ONCE).
    // Managed (fly) → just open the project.
    if (p.provider === 'external' && p.apiKey) setConn({ id: p.id, apiKey: p.apiKey, wsUrl: p.wsUrl })
    else nav(`/o/${orgId}/p/${p.id}`)
  }
  async function createUser() { await api('/users', { method: 'POST', body: JSON.stringify({ email: newUser.email, name: newUser.name, role: newUser.role }) }); setNewUser({ email: '', name: '', role: 'user' }); api('/users').then(r => r.json()).then(setUsers).catch(() => {}) }
  // Project delete lives on the project's own Settings → Danger zone (type-to-confirm), not on this list.
  const restoreProject = async (id: string) => { await api('/projects', { method: 'PUT', body: JSON.stringify({ id }) }); fetchProjects() }

  // ── ROTATING A PROJECT'S API KEY ──────────────────────────────────────────
  // That key sits in every engine's .env and on the proxy box, and it unlocks the project's pooled provider
  // credentials — so it has to be rotatable by someone who is not editing a database by hand. Two steps on
  // purpose: rotating ISSUES a second key and both work, so boxes can be moved across without an outage;
  // finishing drops the old one. Anything else means a rotation costs downtime, and a rotation that costs
  // downtime is one nobody performs — which is how an exposed key stays live for months.
  const [rot, setRot] = useState<{ id: string; apiKey: string; done?: boolean } | null>(null)
  const rotateKey = async (id: string) => {
    const r = await api(`/project-key/${id}/rotate`, { method: 'POST' })
    if (!r.ok) { alert(`Could not rotate: ${r.status} ${await r.text()}`); return }
    const b = await r.json() as any
    setRot({ id, apiKey: b.apiKey })
  }
  const finishRotation = async () => {
    if (!rot) return
    const r = await api(`/project-key/${rot.id}/prune`, { method: 'POST', body: JSON.stringify({ keep: rot.apiKey }) })
    if (!r.ok) { alert(`Could not finish: ${r.status} ${await r.text()}`); return }
    setRot({ ...rot, done: true })
  }

  // The warehouse is the whole page: the explorer, with everything else beside its tables.
  if (tab === 'warehouse') return <WarehousePanel api={api} orgId={orgId ?? ''} projects={projects.filter((p: any) => !p.deleted).map((p: any) => ({ id: p.id, name: p.name }))} keys={<OrgKeysPanel api={api} />} />

  return (
    <Shell>
      {conn && (() => {
        const env = `ICA_PROJECT=${conn.id}\nICA_KEY=${conn.apiKey}\nICA_HUB=${conn.wsUrl}`
        return (
          <Dialog icon="lucide:server" title="Project created on your own compute" subtitle="No Fly machine — you run the engine" onClose={() => setConn(null)}
            footer={<><CopyButton text={env} />
              <button className="sa-btn" onClick={() => { const id = conn.id; setConn(null); nav(`/o/${orgId}/p/${id}`) }}>Open project</button>
              <span className="sa-grow" />
              <button className="sa-btn sa-btn--link" onClick={() => setConn(null)}>Close</button></>}>
            <div className="sa-section__body sa-stack">
              <Notice state="attention">Run your own code-engine with these. The API key is shown <strong>once</strong> — copy it now.</Notice>
              <EnvBlock text={env} />
            </div>
          </Dialog>
        )
      })()}
      {rot && (() => {
        const env = `ICA_PROJECT=${rot.id}\nICA_KEY=${rot.apiKey}`
        return (
          <Dialog icon="lucide:key-round" title={rot.done ? 'Rotation complete' : 'New key issued — both keys work'} onClose={() => setRot(null)}
            footer={<><CopyButton text={env} />
              {!rot.done && <button className="sa-btn sa-btn--primary" onClick={finishRotation}>Finish — retire the old key</button>}
              <span className="sa-grow" />
              <button className="sa-btn sa-btn--link" onClick={() => setRot(null)}>Close</button></>}>
            <div className="sa-section__body sa-stack">
              {rot.done
                ? <Notice state="ok">The old key no longer works. Any box still holding it will fail to connect until its <Code>.env</Code> is updated.</Notice>
                : <Notice state="attention">The old key still works, so nothing is down. Put this in every engine’s <Code>.env</Code> and restart it, then press <strong>Finish</strong> to retire the old key. Shown <strong>once</strong>.</Notice>}
              <EnvBlock text={env} />
            </div>
          </Dialog>
        )
      })()}
      {(() => { const pl = ORG_PLACES.find((x) => x.slug === (tab === 'projects' ? '' : tab === 'users' ? 'people' : tab)); return <PageHeader title={pl?.label ?? orgName} subtitle={pl?.says} /> })()}
      {/* In the workspace the sidebar and the breadcrumbs are the way between these; the tabs are for the page alone. */}
      {inBlock ? null : <Tabs label="Parts of the organisation" value={tab} onChange={(t) => setSearch({ tab: t })} items={[
        { key: 'projects', label: 'Projects', icon: 'lucide:folder-kanban', count: projects.length },
        { key: 'users', label: 'Users', icon: 'lucide:users', count: users.length },
        { key: 'usage', label: 'Usage', icon: 'lucide:gauge' },
        { key: 'warehouse', label: 'Warehouse', icon: 'lucide:database' },
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
          <Dialog icon="lucide:folder-plus" title="New project" subtitle="Choose where its engine runs" onClose={() => setMakingProject(false)}>
            <Form onSubmit={() => { void createProject(); setMakingProject(false) }} actions={<><button type="button" className="sa-btn" onClick={() => setMakingProject(false)}>Cancel</button><button className="sa-btn sa-btn--primary">Make the project</button></>}>
              <Field label="Name"><input id="proj-name" className="sa-input" required autoFocus value={newProject.name} onChange={e => setNewProject({ ...newProject, name: e.target.value })} placeholder="Finance analytics" /></Field>
              <Field label="Where its engine runs">
                <select id="proj-provider" className="sa-input" value={newProject.provider} onChange={e => setNewProject({ ...newProject, provider: e.target.value })}>
                  <option value="fly">A managed machine (Fly)</option>
                  <option value="external">Your own machine (local or EC2)</option>
                </select>
              </Field>
            </Form>
          </Dialog>
        )}
      </>}

      {tab === 'usage' && <UsagePanel api={api} />}
      {tab === 'billing' && <BillingPanel api={api} />}
      {tab === 'users' && <OrgPeoplePanel api={api} />}

      {/* Deleting an ORGANISATION is a platform act — the customer console never offers it, and the API refuses
          it for anyone but superadmin regardless. */}
      {tab === 'settings' && (HOST_SCOPE !== 'admin'
        ? <SectionCard icon="lucide:triangle-alert" accent="loss" title="Danger zone" subtitle="Delete this organisation: it removes the organisation and every project inside it">
            <ActionBar><button className="sa-btn" onClick={() => setDelOrg(true)}>Delete organisation…</button></ActionBar>
          </SectionCard>
        : <Empty>Nothing to set here: an organisation is deleted from the platform console.</Empty>)}
      {delOrg && <ConfirmDelete kind="organization" name={orgName || orgId || ''} onClose={() => setDelOrg(false)}
        consequences={[`Delete organization “${orgName || orgId}”`, `Delete all ${projects.length} project(s) inside it`, 'Detach their engines / bots', 'Soft-delete — restorable from the org list (Show deleted)']}
        onConfirm={async () => { await api('/organizations', { method: 'DELETE', body: JSON.stringify({ id: orgId }) }); nav('/') }} />}
    </Shell>
  )
}

// ── Project detail — live monitoring dashboard ───────────────────────────────
const evtState = (e: string): StatusState =>
  /fail|error|evict/.test(e) ? 'critical' :
  /suspend|stop|leave|disconnect/.test(e) ? 'attention' :
  /connect|woke|start|join|deliver/.test(e) ? 'ok' : 'running'

// The Teams setup steps, each a title and what to do.
const TEAMS_GUIDE: [string, React.ReactNode][] = [
  ['1 · Create the bot', <>Azure Portal → create an <em>Azure Bot</em> resource. For “Type of App”, <em>Multi-tenant</em> is simplest.</>],
  ['2 · Enable the Teams channel', <>On the Azure Bot → <em>Channels</em> → select <em>Microsoft Teams</em> → agree &amp; apply. Without this, Teams can’t reach the bot.</>],
  ['3 · Set the messaging endpoint', <>Copy the endpoint shown below → Azure Bot → <em>Configuration</em> → <em>Messaging endpoint</em> → Save.</>],
  ['4 · App ID', <>Azure Bot → <em>Configuration</em> → <em>Microsoft App ID</em> (the app registration’s <em>Application (client) ID</em>).</>],
  ['5 · Client secret', <>Azure Portal → <em>App registrations</em> → your bot’s app → <em>Certificates &amp; secrets</em> → <em>New client secret</em> → copy the <strong>Value</strong> immediately (shown only once — the “Secret ID” is <em>not</em> it).</>],
  ['6 · Tenant ID', <>Azure Portal → <em>Microsoft Entra ID</em> → <em>Overview</em> → <em>Tenant ID</em> (needed for single-tenant apps).</>],
  ['7 · Connect here', <>Paste the three values below → <em>Connect Teams</em>. This stores the credentials so the engine can answer — it does <em>not</em> yet put the bot in Teams.</>],
  ['8 · Build the Teams app package', <>One per project — don’t reuse another project’s. A <em>.zip</em> of <em>manifest.json</em> + two icons (<em>color</em> 192×192, <em>outline</em> 32×32), all at the zip root. In manifest.json: set <em>bots[0].botId</em> (and <em>webApplicationInfo.id</em> if present) to <strong>this</strong> bot’s App ID, give it a <strong>new unique</strong> <em>id</em> (a fresh GUID — the app’s own id, not the bot’s), and a distinct <em>name</em>. (Prefer a UI? <em>dev.teams.microsoft.com → Apps → Import app</em> lets you edit + publish instead.)</>],
  ['9 · Upload it to your org', <>Teams → <em>Apps</em> → <em>Manage your apps</em> → <em>Upload an app</em> → <em>“Upload an app to your org’s app catalog”</em> → pick the .zip. (Admins can also use <em>Teams admin center → Manage apps → Upload</em>.)</>],
  ['10 · Find it in Teams', <>Teams → <em>Apps</em> → <em>Built for your org</em> → your app → <em>Add</em>. Org apps can take a while (up to ~24h) to appear — give it time and refresh.</>],
  ['11 · Start chatting', <>Open a 1:1 chat with the bot and message it (e.g. “how many customers do we have?”), or add it to a channel and <em>@mention</em> it. It answers for <em>this</em> project only.</>],
]

// Channels: connect a chat surface (Teams, Slack, …) to this project. It mints a scoped service
// token + stores the channel's bot credentials in the project's ChannelDO — all via the admin
// session (no manual token). Per-project, per-channel; nothing here touches other projects.
function ChannelsPanel({ projectId, api }: { projectId: string; api: (path: string, init?: RequestInit) => Promise<Response> }) {
  const endpoint = `https://superatom.site/api/messaging/${projectId}/teams/messages`
  const [appId, setAppId] = useState(''); const [secret, setSecret] = useState(''); const [tenantId, setTenantId] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const [status, setStatus] = useState<{ connected?: boolean; appId?: string; tenantId?: string; hasSecret?: boolean; configuredAt?: number } | null>(null)
  const refreshStatus = () => api(`/messaging/${projectId}/teams/status`).then(r => (r.ok ? r.json() : null)).then(d => setStatus(d?.channels?.teams ?? null)).catch(() => {})
  useEffect(() => { refreshStatus() }, [projectId])   // show "connected" without ever re-exposing the secret
  async function connect() {
    setBusy(true); setMsg(null)
    try {
      // 1) mint a scoped service token for this project's teams channel
      const st = await api(`/projects/${projectId}/service-token`, { method: 'POST', body: JSON.stringify({ channel: 'teams' }) })
      if (!st.ok) throw new Error(`service-token failed (${st.status})`)
      const { token: serviceToken } = await st.json()
      // 2) store token + bot secrets in the ChannelDO
      const r = await api(`/messaging/${projectId}/teams/config`, { method: 'POST', body: JSON.stringify({
        serviceToken, secrets: { teams: { appId: appId.trim(), appPassword: secret.trim(), tenantId: tenantId.trim() } },
      }) })
      if (!r.ok) throw new Error(`config failed (${r.status})`)
      setMsg({ ok: true, text: 'Saved. If the bot isn’t in Teams yet, publish the app to your org — see the setup guide.' })
      setSecret(''); refreshStatus()
    } catch (err: any) { setMsg({ ok: false, text: String(err?.message ?? err) }) } finally { setBusy(false) }
  }
  return (
    <>
      <SectionCard icon="lucide:message-square" title="Microsoft Teams" subtitle="Each channel joins the engine as a scoped bot, routed to this project only"
        actions={<button type="button" className="sa-btn sa-btn--link" onClick={() => setShowGuide(v => !v)}>
          <Icon icon={showGuide ? 'lucide:x' : 'lucide:book-open'} className="sa-btn__icon" />{showGuide ? 'Hide setup guide' : 'Setup guide'}</button>}>
        {status?.connected && <>
          <Receipt items={[
            ['Status', <Status state="ok">Connected</Status>],
            ['App ID', <Code>{status.appId}</Code>],
            ['Tenant', <Code>{status.tenantId}</Code>],
            ['Client secret', status.hasSecret ? 'set' : '—'],
            ...(status.configuredAt ? [['Configured', new Date(status.configuredAt).toLocaleString()] as [string, React.ReactNode]] : []),
          ]} />
          <div className="sa-section__body"><Notice>The secret is stored, never shown. Re-enter the fields below only to update it.</Notice></div>
        </>}
        {showGuide && <Receipt items={TEAMS_GUIDE} />}
        <Form onSubmit={() => void connect()} error={msg && !msg.ok ? msg.text : undefined}
          actions={<button className="sa-btn sa-btn--primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect Teams'}</button>}>
          <Field label="Messaging endpoint" help="Paste into Azure Bot → Configuration. First time? Open the setup guide.">
            <input className="sa-input" readOnly value={endpoint} onFocus={e => e.currentTarget.select()} />
          </Field>
          <Field label="App ID"><input className="sa-input" value={appId} onChange={e => setAppId(e.target.value)} required placeholder="b153838f-…" /></Field>
          <Field label="Client secret"><input className="sa-input" value={secret} onChange={e => setSecret(e.target.value)} required type="password" placeholder="secret value" /></Field>
          <Field label="Tenant ID"><input className="sa-input" value={tenantId} onChange={e => setTenantId(e.target.value)} required placeholder="b9bd0c3d-…" /></Field>
        </Form>
        {msg?.ok && <div className="sa-section__body"><Notice state="ok">{msg.text}</Notice></div>}
      </SectionCard>
      <SectionCard icon="lucide:hash" title="Slack">
        <Empty icon="lucide:clock">Coming soon — the same flow, one adapter away.</Empty>
      </SectionCard>
    </>
  )
}

// ── Access (per project) ────────────────────────────────────────────────────
// Who may use THIS project, and as what. People are created once in the organisation; here they are assigned.
// The assignment call goes to the ORG (it is the one that knows who belongs to it) and the org writes into this
// project — so a project can never invent a user of its own. Roles are the project's own.
function AccessPanel({ projectId, orgId, api, token }: { projectId: string; orgId: string | null; api: ReturnType<typeof useApi>; token: string | null }) {
  const orgApi = useApi(token, orgId)
  return <ProjectAccessPanel projectId={projectId} api={api} orgApi={orgId ? orgApi : null} />
}

// ── Datasource index (per project) ──────────────────────────────────────────
// What tables and fields each source has — the map the agents search before writing a query. Building it used to
// mean shell access to the box, so a new project could not be made useful without one. Same builder, run from
// here, streaming progress. It RESUMES: re-running continues where it stopped, so a failed run is not wasted.
function IndexPanel({ hub }: { hub: ReturnType<typeof useProjectHub> }) {
  const [lines, setLines] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [summary, setSummary] = useState<any>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => hub.subscribe((m: any) => {
    if (m?.t === 'index:status' || m?.t === 'index:line') setLines(l => [...l, m.text])
    if (m?.t === 'index:done') {
      setBusy(false); setSummary(m)
      setLines(l => [...l, m.ok ? `finished in ${(m.ms / 1000).toFixed(1)}s` : `failed: ${m.error}`])
    }
  }), [hub])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [lines])

  const start = (rebuild: boolean) => {
    setLines([]); setSummary(null); setBusy(true)
    hub.send({ to: { type: 'code-engine' }, payload: { t: 'index:build', rebuild } })
  }

  return (
    <>
      <SectionCard icon="lucide:database-zap" title="Build the index" subtitle="Records the tables and fields of each connected source, so an agent finds where something lives instead of guessing"
        actions={<>
          <button className="sa-btn" disabled={busy || hub.status !== 'live'} onClick={() => start(true)}>Rebuild from empty</button>
          <button className="sa-btn sa-btn--primary" disabled={busy || hub.status !== 'live'} onClick={() => start(false)}>{busy ? 'Building…' : 'Build / resume'}</button>
        </>}>
        <div className="sa-section__body sa-stack">
          <Notice>Building resumes: running it again picks up where it left off and skips what is already indexed.</Notice>
          {hub.status !== 'live' && <Notice state="attention">The engine is not connected.</Notice>}
        </div>
      </SectionCard>

      {summary?.sources && (
        <SectionCard icon="lucide:database" title="Sources" note={`${summary.sources.length}`}>
          <RecordList rows={summary.sources as any[]} keyOf={(s) => String(s.id)} columns={[
            { key: 'id', label: 'Source' },
            { key: 'dialect', label: 'Dialect' },
            { key: 'containers', label: 'Tables', align: 'end', render: (s) => s.error ? '—' : String(s.containers) },
            { key: 'indexed', label: 'Indexed now', align: 'end', render: (s) => s.error ? '—' : `+${s.indexed}` },
            { key: 'fields', label: 'Fields', align: 'end', render: (s) => s.error ? '—' : String(s.fields) },
            { key: 'state', label: 'State', wrap: true, render: (s) => s.error ? <span className="sa-row sa-row--tight"><Status state="critical">failed</Status>{s.error}</span> : <Status state="ok">indexed</Status> },
          ]} />
        </SectionCard>
      )}

      {lines.length > 0 && (
        <SectionCard icon="lucide:scroll-text" title="Progress" note={busy ? 'building' : undefined}>
          <div className="sa-section__scroll sa-section__scroll--tall sa-scroll">
            <pre className="sa-section__text">{lines.join('\n')}<div ref={endRef} /></pre>
          </div>
        </SectionCard>
      )}
    </>
  )
}

function ProjectDetailPage() {
  const token = useAuth(); const params = useParams<{ orgId: string; projectId: string; '*': string }>()
  const role = useRole(token)   // superadmin-only sections are not rendered without it (the API refuses regardless)
  const { orgId, projectId } = params
  const navigate = useNavigate()
  const api = useApi(token, orgId)
  const [status, setStatus] = useState<any>(null)
  const [logs, setLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false); const [error, setError] = useState('')
  // The view id is flat: a top-level item ('overview'), or 'inspector/<section>' for an Inspector sub-section.
  // It lives in the URL PATH (the route splat), so a reload / shared link lands on the same view — e.g.
  // /admin/org/<org>/projects/<id>/semantic or /inspector/db-kinds. setView navigates instead of setState.
  const view = params['*'] || 'overview'
  // Two ways in: /org/<org>/projects/<id>/… (from the org) and /pro/<id>/… (straight to the project). Keep the
  // reader on whichever they used, so a shared link and the back button behave.
  const base = `/o/${orgId}/p/${projectId}`
  const setView = (v: string) => navigate(`${base}${v && v !== 'overview' ? '/' + v : ''}`)
  // The org + project NAMES (the sidebar/crumbs/header show real names, not just truncated ids).
  const [meta, setMeta] = useState<{ project?: string; org?: string }>({})
  // Settings view: the Teams bot credential + the Danger zone (delete). Kept OFF the project list — a delete is
  // never one click from a card.
  const [svc, setSvc] = useState<{ projectId: string; channel: string; token: string; wsUrl: string; expiresAt: number } | null>(null)
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
    if (!r.ok) { alert(`Could not rotate: ${r.status} ${await r.text()}`); return }
    setRot({ apiKey: (await r.json() as any).apiKey })
  }
  const finishRotation = async () => {
    if (!rot) return
    const r = await api(`/project-key/${projectId}/prune`, { method: 'POST', body: JSON.stringify({ keep: rot.apiKey }) })
    if (!r.ok) { alert(`Could not finish: ${r.status} ${await r.text()}`); return }
    setRot({ ...rot, done: true })
  }
  const genServiceToken = async (channel: string) => {
    const r = await api(`/projects/${projectId}/service-token`, { method: 'POST', body: JSON.stringify({ channel }) })
    if (r.ok) setSvc(await r.json())
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
    await api('/domains', { method: 'DELETE', body: JSON.stringify({ subdomain: s }) }).catch(() => {})
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

  async function upload(file: File) {
    setUploading(true); setError('')
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('projectId', projectId!)
      const r = await fetch(`${VM_URL}/upload`, { method: 'POST', body: fd })
      if (!r.ok) throw new Error(await r.text())
    } catch (err: any) { setError(err.message) } finally { setUploading(false) }
  }

  const m = status?.machine
  const conns: any[] = status?.connections ?? []
  const liveState = m?.state   // unified, backend-decided (Fly state or online/offline)
  const provider = status?.provider

  // The place's name and what it is for, from the project's places (the sidebar's words).
  const here = purposesOf().flatMap(p => p.places).find(pl => pl.slug === (view === 'overview' ? '' : view))
  const title = here?.label ?? 'Engine'

  // One line on what the view is for, from the places by purpose (the same words as the workspace's sidebar).
  const says = here?.says
  const profileEnv = (key: string) => `ICA_PROJECT=${projectId}\nICA_KEY=${key}`

  return (
    <Shell>
      <PageHeader title={title} subtitle={says}
        actions={loading ? <span className="sa-row sa-row--tight sa-muted"><span className="sa-spinner" /> connecting…</span> : <Pill s={liveState} />} />

      {view === 'overview' && <>
        <Figures>
          <Kpi label="Compute" value={provider === 'external' ? 'Local / EC2' : 'Fly machine'} />
          <Kpi label="State" value={<Pill s={liveState} />} />
          <Kpi label="Heartbeat" value={m?.lastHeartbeat ? ago(m.lastHeartbeat) : '—'} />
          <Kpi label="Connections" value={conns.length} />
          {provider !== 'external' && m?.idlePhase && <Kpi label="Idle phase" value={<Pill s={m.idlePhase} />} />}
          {m?.region && <Kpi label="Region" value={m.region} />}
        </Figures>
        <SectionCard icon="lucide:plug" title="Live connections" subtitle="Who is connected to the project’s hub now" note={`${conns.length}`}>
          <RecordList rows={conns} keyOf={(c) => String(c.wsId)} empty="Nobody is connected to the hub right now." columns={[
            { key: 'type', label: 'Who', render: (c) => <span className="sa-row sa-row--tight"><Status state="ok">live</Status>{c.type}</span> },
            { key: 'wsId', label: 'Connection', align: 'end', render: (c) => <Code>{c.wsId}</Code> },
          ]} />
        </SectionCard>
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
        <SectionCard icon="lucide:activity" title="Event log" subtitle="From the project’s Durable Object" actions={<Status state="ok">live</Status>}>
          <RecordList rows={logs} keyOf={(l) => String(l.id)} empty="No events recorded yet." columns={[
            { key: 'event', label: 'Event', render: (l) => <Status state={evtState(l.event)}>{l.event}</Status> },
            { key: 'detail', label: 'Detail', render: (l) => <span title={l.detail || undefined}>{eventWords(l.detail)}</span> },
            { key: 'at', label: 'Time', align: 'end', render: (l) => new Date(l.created_at * 1000).toLocaleTimeString() },
          ]} />
        </SectionCard>
      )}

      {view === 'dashboards' && <DashboardsPanel api={api} token={token} projectId={projectId!} />}
      {view === 'agent-keys' && <AgentKeysPanel api={api} projectId={projectId!} />}
      {view === 'audit' && <AuditPanel api={api} projectId={projectId!} />}
      {view === 'data-access' && <AccessPoliciesPanel api={api} projectId={projectId!} />}
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
                      {running.at ? <span className="sa-muted">as of {new Date(running.at).toLocaleString()}</span> : null}
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
                      {running.at && <span className="sa-disclosure__meta">reported {new Date(running.at).toLocaleString()}</span>}
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
        <SectionCard icon="lucide:bot" title="Teams bot credential" subtitle="A scoped service token so a Teams bot can act as this project’s runtime. Shown once">
          <ActionBar><button className="sa-btn" onClick={() => genServiceToken('teams')}>Generate Teams token</button></ActionBar>
        </SectionCard>
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

      {svc && (() => {
        const env = `SA_HUB_WS=${svc.wsUrl}\nSA_PROJECT_ID=${svc.projectId}\nSA_ENGINE_TOKEN=${svc.token}`
        const exp = new Date(svc.expiresAt).toLocaleDateString()
        return (
          <Dialog icon="lucide:bot" title={`${svc.channel} bot credential — service token`} onClose={() => setSvc(null)}
            footer={<><CopyButton text={env} /><span className="sa-grow" /><button className="sa-btn sa-btn--link" onClick={() => setSvc(null)}>Close</button></>}>
            <div className="sa-section__body sa-stack">
              <Notice>Paste into the surface’s <Code>.env</Code>. It authorises the bot as a <Code>runtime</Code> for this project only, until {exp}.</Notice>
              <EnvBlock text={env} />
            </div>
          </Dialog>
        )
      })()}
      {delProj && <ConfirmDelete kind="project" name={meta.project || projectId || ''} onClose={() => setDelProj(false)}
        consequences={[`Delete project “${meta.project || projectId}”`, 'Tear down its engine wiring + machine mapping', 'Revoke its channel / bot credentials', 'Soft-delete — restorable from the org’s project list (Show deleted)']}
        onConfirm={async () => { await api('/projects', { method: 'DELETE', body: JSON.stringify({ id: projectId }) }); navigate(`/o/${orgId}`) }} />}

      {view === 'agent' && <>
        <SectionCard icon="lucide:upload" title="Data source" subtitle="Upload a file the agent can use, or describe the source in the console below"
          actions={<label className="sa-btn" role="button">
            <Icon icon="lucide:upload" className="sa-btn__icon" />{uploading ? 'Uploading…' : 'Upload file'}
            <input type="file" hidden onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} disabled={uploading} />
          </label>}>
          {error ? <div className="sa-section__body"><Notice state="critical">{error}</Notice></div> : null}
        </SectionCard>
        <ConnectorConsole hub={hub} />
      </>}

      {view === 'analyst' && <AnalystConsole hub={hub} />}

      {view === 'grounding' && <GroundingConsole hub={hub} />}

      {view === 'index' && <IndexPanel hub={hub} />}
      {view === 'access' && <AccessPanel projectId={projectId!} orgId={orgId ?? status?.orgId ?? null} api={api} token={token} />}
      {view === 'channels' && <ChannelsPanel projectId={projectId!} api={api} />}
    </Shell>
  )
}
