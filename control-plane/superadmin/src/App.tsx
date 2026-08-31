import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useProjectHub } from './hub'
import { Inspector, SECTIONS, SECTION_LABEL, type Section } from './Inspector'
import { ConnectorConsole } from './ConnectorConsole'
import { GroundingConsole } from './GroundingConsole'
import { AnalystConsole } from './AnalystConsole'
import { useSession, SignIn, UserButton } from '@clerk/react'
import { BrowserRouter, Routes, Route, Link, useParams, useNavigate, useSearchParams } from 'react-router-dom'

const VM_URL = import.meta.env.VITE_VM_URL ?? 'http://localhost:5050'

// ── Design system — Stripe dashboard look (injected once) ─────────────────────
const CSS = `
:root{--purple:#635bff;--purple-d:#5145e8;--ink:#1a1f36;--sub:#697386;--faint:#8792a2;
 --bg:#f6f8fb;--card:#fff;--line:#e3e8ee;--line2:#eef1f6;
 --ok:#0e7c46;--okbg:#d7f7e3;--warn:#9a6700;--warnbg:#fdf1d6;--bad:#b3093c;--brand:#635bff;--muted:#697386;--faint2:#8792a2;--accent:#635bff}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
 background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased;font-size:14px}
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
.side .nav.on{background:#f0f1ff;color:var(--purple);font-weight:600}
.side .nav svg{width:16px;height:16px;flex-shrink:0;opacity:.85}
/* expander chevron + the nested sub-items it reveals */
.side .chev{margin-left:auto;width:11px;height:11px;opacity:.55;transition:transform .15s}
.side .chev.open{transform:rotate(90deg)}
.side .subnav{display:block;margin-left:20px;padding:5px 9px 5px 11px;border-left:1px solid var(--line);
 font-size:13px;color:var(--sub);cursor:pointer;border-radius:0 6px 6px 0}
.side .subnav:hover{background:#f6f8fb;color:var(--ink)}
.side .subnav.on{background:#f0f1ff;color:var(--purple);font-weight:600;border-left-color:var(--purple)}
.side .foot{border-top:1px solid var(--line2);padding:9px 12px;display:flex;align-items:center;gap:10px}
.main{flex:1;min-width:0;display:flex;flex-direction:column}
.top{display:flex;align-items:center;gap:12px;padding:8px 20px;border-bottom:1px solid var(--line);
 background:#fff;position:sticky;top:0;z-index:5;min-height:44px}
.content{padding:16px 20px 40px;width:100%;min-width:0}

.h1{font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0 0 2px}
.bread{font-size:13px;color:var(--sub);display:flex;gap:7px;align-items:center}
.row{display:flex;align-items:center;gap:10px}
.between{display:flex;align-items:center;justify-content:space-between}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;
 box-shadow:0 1px 1px rgba(48,49,61,.04)}
.grid{display:grid;gap:12px}
.btn{padding:7px 14px;background:var(--purple);color:#fff;border:none;border-radius:7px;
 font-size:14px;font-weight:600;cursor:pointer;transition:background .15s;white-space:nowrap}
.btn:hover{background:var(--purple-d)}
.btn:disabled{opacity:.5;cursor:default}
.btn.ghost{background:#fff;color:var(--ink);border:1px solid var(--line);font-weight:500}
.btn.ghost.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.btn.sm{padding:5px 11px;font-size:12.5px;border-radius:6px}
.btn.danger{background:#fff;color:var(--bad);border:1px solid #f3d0dc}
.btn.ok{background:var(--ok)}
.input,select.input{padding:8px 11px;border:1px solid var(--line);border-radius:7px;font-size:14px;
 background:#fff;outline:none;transition:box-shadow .15s,border-color .15s}
.input:focus{border-color:var(--purple);box-shadow:0 0 0 3px #635bff22}
.pill{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px;text-transform:capitalize}
.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--faint)}
.muted{color:var(--sub)}
.tile{background:var(--card);border:1px solid var(--line);border-radius:9px;padding:11px 13px}
.tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--sub)}
.tile .v{font-size:17px;font-weight:700;margin-top:3px}
.list>*{margin-bottom:10px}
.evt{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--line2);font-size:13px}
.evt:last-child{border-bottom:none}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.clickable{cursor:pointer}
.clickable:hover{border-color:var(--purple)}
.empty{color:var(--faint);font-size:14px;text-align:center;padding:32px 0}
.spin{width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--purple);
 border-radius:50%;display:inline-block;animation:s .7s linear infinite}
@keyframes s{to{transform:rotate(360deg)}}
.signin{max-width:420px;margin:110px auto;padding:0 16px;text-align:center}
`

function Style() { return <style dangerouslySetInnerHTML={{ __html: CSS }} /> }

// minimal Stripe-ish line icons
const I = {
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

// status → color
const SC: Record<string, string> = {
  started: 'var(--ok)', running: 'var(--ok)', active: 'var(--ok)',
  starting: 'var(--warn)', created: 'var(--warn)', creating: 'var(--warn)', pending: 'var(--warn)',
  suspended: 'var(--warn)', stopping: 'var(--warn)', stopped: 'var(--muted)',
  destroyed: 'var(--bad)', destroying: 'var(--bad)',
}
const sc = (s?: string) => SC[s ?? ''] ?? 'var(--muted)'
function Pill({ s }: { s?: string }) {
  const c = sc(s)
  return <span className="pill" style={{ background: `color-mix(in srgb, ${c} 13%, #fff)`, color: c }}>{s ?? 'unknown'}</span>
}
function ago(ms: number) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

// ── auth / api ───────────────────────────────────────────────────────────────
// Read a JWT's exp (unix seconds); 0 if unparseable → treated as expired.
function jwtExp(t: string | null): number {
  if (!t) return 0
  try {
    let b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    b += '='.repeat((4 - (b.length % 4)) % 4)
    const p = JSON.parse(atob(b))
    return typeof p.exp === 'number' ? p.exp : 0
  } catch { return 0 }
}
// A token is usable only if it's present AND more than 60s from expiry (clock-skew margin).
function tokenValid(t: string | null): boolean {
  return jwtExp(t) * 1000 - Date.now() > 60_000
}

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
  const [token, setToken] = useState<string | null>(() => {
    const t = localStorage.getItem('sa-token')
    if (tokenValid(t)) return t
    localStorage.removeItem('sa-token')   // discard a stale/expired cached token instead of reusing it
    return null
  })
  useEffect(() => {
    // Re-exchange whenever we lack a VALID token (missing OR expired) and a Clerk session is available.
    if (tokenValid(token) || !session) return
    session.getToken().then(async (ct) => {
      try {
        const r = await fetch('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clerkToken: ct }) })
        if (!r.ok) return
        const { token: t } = await r.json()
        localStorage.setItem('sa-token', t)
        sessionStorage.removeItem('sa-reauth')   // a fresh token clears the 401 self-heal guard
        setToken(t)
      } catch {}
    })
  }, [session, token])
  return token
}
function useApi(token: string | null, orgId?: string | null) {
  return useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(`/api${path}`, {
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(orgId ? { 'x-org-id': orgId } : {}) },
      ...init,
    })
    // Self-heal: a 401 means the token was rejected (expired mid-session). Drop it and re-exchange on
    // reload. The sessionStorage guard prevents a reload loop if re-exchange also fails (dead Clerk session).
    if (res.status === 401 && !sessionStorage.getItem('sa-reauth')) {
      sessionStorage.setItem('sa-reauth', '1')
      localStorage.removeItem('sa-token')
      location.reload()
    }
    return res
  }, [token, orgId])
}

function Shell({ children, crumbs, nav }: { children: React.ReactNode; crumbs?: React.ReactNode; nav?: React.ReactNode }) {
  return (
    <div className="app">
      <Style />
      <aside className="side">
        <div className="org">
          <div className="avatar">S</div>
          <div><div className="nm">Superatom</div><div className="sub">Admin console</div></div>
        </div>
        <nav>
          <div className="grp">Manage</div>
          <Link to="/" className="nav">{I.home}Organizations</Link>
          {nav}
        </nav>
        <div className="foot"><UserButton /></div>
      </aside>
      <div className="main">
        <div className="top">{crumbs ?? <span className="muted" style={{ fontSize: 13 }}>Superatom admin</span>}</div>
        <div className="content">{children}</div>
      </div>
    </div>
  )
}

// ── App ────────────────────────────────────────────────────────────────────
export function App() {
  const { isSignedIn } = useSession()
  if (!isSignedIn) {
    return (
      <><Style /><div className="signin">
        <div className="brand" style={{ fontSize: 26, marginBottom: 20 }}>super<span>atom</span></div>
        <SignIn />
      </div></>
    )
  }
  return (
    <BrowserRouter basename={ROUTER_BASE}>
      <Routes>
        {/* Landing: the platform console lists every org; the customer console sends you to your own. */}
        <Route path="/" element={HOST_SCOPE === 'admin' ? <MyOrgLanding /> : <OrgListPage />} />
        <Route path="/org/:orgId" element={<OrgDetailPage />} />
        {/* /pro/<projectId> — a project on its own, no org in the path. */}
        <Route path="/pro/:projectId/*" element={<ProjectDetailPage />} />
        {/* The older nested form still resolves, so existing links keep working. */}
        <Route path="/org/:orgId/projects/:projectId/*" element={<ProjectDetailPage />} />
      </Routes>
    </BrowserRouter>
  )
}

// ── Destructive-action guard ─────────────────────────────────────────────────
// A delete is NEVER one click from a list. This modal spells out the consequences and only arms the
// Delete button once the user has typed the exact resource name — so deletion is always deliberate.
function ConfirmDelete({ kind, name, consequences, onConfirm, onClose }: {
  kind: string; name: string; consequences: string[]; onConfirm: () => void | Promise<void>; onClose: () => void
}) {
  const [typed, setTyped] = useState(''); const [busy, setBusy] = useState(false)
  const armed = typed.trim() === name
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={onClose}>
      <div className="card" style={{ maxWidth: 520, width: '92%', padding: 22 }} onClick={e => e.stopPropagation()}>
        <h3 style={{ marginTop: 0, color: 'var(--bad)' }}>Delete {kind} “{name}”?</h3>
        <p className="muted" style={{ marginTop: 4, marginBottom: 8 }}>This can’t be undone from here. Deleting will:</p>
        <ul style={{ margin: '0 0 14px 18px', fontSize: 13, color: 'var(--muted)', lineHeight: 1.65 }}>
          {consequences.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
        <label style={{ display: 'block', fontSize: 13, marginBottom: 6 }}>Type <strong>{name}</strong> to confirm:</label>
        <input className="input" value={typed} onChange={e => setTyped(e.target.value)} placeholder={name} autoFocus
          onKeyDown={e => { if (e.key === 'Enter' && armed && !busy) { setBusy(true); Promise.resolve(onConfirm()).finally(() => setBusy(false)) } }}
          style={{ width: '100%', marginBottom: 14 }} />
        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn danger" disabled={!armed || busy}
            onClick={async () => { setBusy(true); try { await onConfirm() } finally { setBusy(false) } }}>
            {busy ? 'Deleting…' : `Delete ${kind}`}
          </button>
        </div>
      </div>
    </div>
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
      if (list.length === 1) nav(`/org/${list[0].id}`, { replace: true })
    }).catch(() => setOrgs([]))
  }, [token, api, nav])

  if (!orgs) return <Shell><div className="muted" style={{ padding: 24 }}>Loading…</div></Shell>
  if (orgs.length === 0) return (
    <Shell><div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>No access yet</h2>
      <div className="muted">This account is not a member of any organisation. Ask an administrator to add your email address.</div>
    </div></Shell>
  )
  return (
    <Shell>
      <h2 style={{ marginTop: 0 }}>Your organisations</h2>
      <div className="grid">
        {orgs.map(o => (
          <Link key={o.id} to={`/org/${o.id}`} className="card">
            <div className="card-title">{o.name}</div>
            {o.myLevel && <div className="muted" style={{ fontSize: 12 }}>{o.myLevel === 'org-admin' ? 'administrator' : 'member'}</div>}
          </Link>
        ))}
      </div>
    </Shell>
  )
}

function OrgListPage() {
  const token = useAuth(); const api = useApi(token)
  const [orgs, setOrgs] = useState<any[]>([]); const [showDeleted, setShowDeleted] = useState(false)
  const nav = useNavigate()
  const fetchOrgs = useCallback(() => { if (token) api(`/organizations?deleted=${showDeleted ? '1' : '0'}`).then(r => r.json()).then(setOrgs).catch(() => {}) }, [token, api, showDeleted])
  useEffect(() => { fetchOrgs() }, [fetchOrgs])
  // The first admin is created WITH the organisation: an org nobody can enter is not much use, and this is the
  // only moment where forgetting is easy to do and annoying to notice.
  async function create(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const fd = new FormData(e.currentTarget); await api('/organizations', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), adminEmail: fd.get('adminEmail') }) }); (e.target as HTMLFormElement).reset(); fetchOrgs() }
  // Deletion is NOT here — it lives on the org page's Danger zone (deliberate, type-to-confirm). Restore is safe.
  const restore = async (id: string) => { await api('/organizations', { method: 'PUT', body: JSON.stringify({ id }) }); fetchOrgs() }

  return (
    <Shell>
      <div className="between" style={{ marginBottom: 18 }}>
        <h1 className="h1">Organizations</h1>
        <label className="row muted" style={{ fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} /> Show deleted
        </label>
      </div>
      {/* Creating organisations belongs to the platform console alone. */}
      {HOST_SCOPE !== 'admin' && <form onSubmit={create} className="row" style={{ marginBottom: 20 }}>
        <input name="name" placeholder="New organization name" required className="input" style={{ flex: 1 }} />
        <input name="adminEmail" type="email" placeholder="First admin's email" className="input" style={{ flex: 1 }} />
        <button className="btn">Create</button>
      </form>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))' }}>
        {orgs.map(o => (
          <div key={o.id} className="card clickable" style={{ opacity: o.deleted ? .55 : 1 }} onClick={() => !o.deleted && nav(`/org/${o.id}`)}>
            <div className="between">
              <strong style={{ fontSize: 15 }}>{o.name}</strong>
              {o.deleted
                ? <button className="btn sm ok" onClick={e => { e.stopPropagation(); restore(o.id) }}>Restore</button>
                : <span className="muted" style={{ fontSize: 12 }}>Open →</span>}
            </div>
            <code className="mono">{o.id}</code>
          </div>
        ))}
      </div>
      {orgs.length === 0 && <div className="empty">No organizations yet — create one above.</div>}
    </Shell>
  )
}

// ── Org detail ─────────────────────────────────────────────────────────────
function OrgDetailPage() {
  const token = useAuth(); const { orgId } = useParams<{ orgId: string }>(); const api = useApi(token, orgId)
  const [search, setSearch] = useSearchParams()
  const tab = (search.get('tab') as 'projects' | 'users' | 'settings') || 'projects'
  const [projects, setProjects] = useState<any[]>([]); const [users, setUsers] = useState<any[]>([])
  const [showDeleted, setShowDeleted] = useState(false); const nav = useNavigate()
  const [conn, setConn] = useState<{ id: string; apiKey: string; wsUrl: string } | null>(null)   // external-project connection info (copyable panel)
  // Teams-token generation moved to the PROJECT's Settings view. Here we only need the org NAME (for the
  // type-to-confirm delete) + the Danger-zone modal toggle.
  const [orgName, setOrgName] = useState(''); const [delOrg, setDelOrg] = useState(false)
  useEffect(() => { if (token) api('/organizations').then(r => r.json()).then((os: any[]) => setOrgName(Array.isArray(os) ? (os.find(o => o.id === orgId)?.name ?? '') : '')).catch(() => {}) }, [token, api, orgId])
  const fetchProjects = useCallback(() => { if (token) api(`/projects?deleted=${showDeleted ? '1' : '0'}`).then(r => r.json()).then(setProjects).catch(() => {}) }, [token, api, showDeleted])
  useEffect(() => { if (!token) return; fetchProjects(); api('/users').then(r => r.json()).then(setUsers).catch(() => {}) }, [token, api, fetchProjects])
  async function createProject(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); const fd = new FormData(e.currentTarget)
    const provider = String(fd.get('provider') || 'fly')   // 'fly' = managed machine · 'external' = local/EC2 (you run the engine)
    const r = await api('/projects', { method: 'POST', body: JSON.stringify({ name: fd.get('name'), provider, createdBy: 'superadmin' }) })
    const p = await r.json(); (e.target as HTMLFormElement).reset(); fetchProjects()
    // External = no Fly machine → show the connection info in a copyable panel (key is shown ONCE).
    // Managed (fly) → just open the project.
    if (p.provider === 'external' && p.apiKey) setConn({ id: p.id, apiKey: p.apiKey, wsUrl: p.wsUrl })
    else nav(`/org/${orgId}/projects/${p.id}`)
  }
  async function createUser(e: React.FormEvent<HTMLFormElement>) { e.preventDefault(); const fd = new FormData(e.currentTarget); await api('/users', { method: 'POST', body: JSON.stringify({ email: fd.get('email'), name: fd.get('name'), role: fd.get('role') }) }); (e.target as HTMLFormElement).reset(); api('/users').then(r => r.json()).then(setUsers).catch(() => {}) }
  // Project delete lives on the project's own Settings → Danger zone (type-to-confirm), not on this list.
  const restoreProject = async (id: string) => { await api('/projects', { method: 'PUT', body: JSON.stringify({ id }) }); fetchProjects() }

  return (
    <Shell crumbs={<><Link to="/">Organizations</Link><span>/</span><code className="mono">{orgId?.slice(0, 8)}…</code></>}>
      {conn && (() => {
        const env = `ICA_PROJECT=${conn.id}\nICA_KEY=${conn.apiKey}\nICA_HUB=${conn.wsUrl}`
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setConn(null)}>
            <div className="card" style={{ maxWidth: 660, width: '92%', padding: 22 }} onClick={e => e.stopPropagation()}>
              <h3 style={{ marginTop: 0 }}>Project created — Local / EC2 compute</h3>
              <p className="muted" style={{ marginTop: 4 }}>No Fly machine. Run your own code-engine with these — the API key is shown <strong>once</strong>, so copy it now.</p>
              <textarea readOnly value={env} onFocus={e => e.currentTarget.select()} rows={3}
                style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, padding: 12, borderRadius: 8, resize: 'vertical', whiteSpace: 'pre' }} />
              <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
                <button className="btn" onClick={() => { navigator.clipboard?.writeText(env); }}>Copy</button>
                <button className="btn ghost" onClick={() => { const id = conn.id; setConn(null); nav(`/org/${orgId}/projects/${id}`) }}>Open project</button>
                <button className="btn ghost" onClick={() => setConn(null)} style={{ marginLeft: 'auto' }}>Close</button>
              </div>
            </div>
          </div>
        )
      })()}
      <div className="row" style={{ gap: 8, marginBottom: 18 }}>
        {(['projects', 'users', 'settings'] as const).map(t => (
          <button key={t} className={`btn ghost ${tab === t ? 'on' : ''}`} onClick={() => setSearch({ tab: t })} style={{ textTransform: 'capitalize' }}>{t}</button>
        ))}
        <label className="row muted" style={{ marginLeft: 'auto', fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={showDeleted} onChange={e => setShowDeleted(e.target.checked)} /> Show deleted
        </label>
      </div>

      {tab === 'projects' && <>
        <form onSubmit={createProject} className="row" style={{ marginBottom: 18 }}>
          <input name="name" placeholder="New project name" required className="input" style={{ flex: 1 }} />
          <select name="provider" defaultValue="fly" className="input" title="Where the code-engine runs">
            <option value="fly">Fly machine (managed)</option>
            <option value="external">Local / EC2 (you run the engine)</option>
          </select>
          <button className="btn">Create project</button>
        </form>
        <div className="list">
          {projects.map(p => (
            <div key={p.id} className="card clickable between" style={{ opacity: p.deleted ? .55 : 1 }} onClick={() => !p.deleted && nav(`/org/${orgId}/projects/${p.id}`)}>
              <div><strong>{p.name}</strong><br/><code className="mono">{p.id}</code></div>
              {p.deleted
                ? <button className="btn sm ok" onClick={e => { e.stopPropagation(); restoreProject(p.id) }}>Restore</button>
                : <span className="muted" style={{ fontSize: 12 }}>Open →</span>}
            </div>
          ))}
        </div>
        {projects.length === 0 && <div className="empty">No projects yet.</div>}
      </>}

      {tab === 'users' && <>
        <form onSubmit={createUser} className="row" style={{ marginBottom: 18 }}>
          <input name="email" type="email" placeholder="Email" required className="input" style={{ flex: 2 }} />
          <input name="name" placeholder="Name" className="input" style={{ flex: 1 }} />
          <select name="role" className="input"><option value="user">user</option><option value="admin">admin</option></select>
          <button className="btn">Add</button>
        </form>
        <div className="list">
          {users.map(u => (
            <div key={u.id} className="card row">
              <strong>{u.email}</strong><span className="muted">{u.name}</span>
              <Pill s={u.role} />
              <code className="mono" style={{ marginLeft: 'auto' }}>{u.id}</code>
            </div>
          ))}
        </div>
        {users.length === 0 && <div className="empty">No users yet.</div>}
      </>}

      {/* Deleting an ORGANISATION is a platform act — the customer console never offers it, and the API refuses
          it for anyone but superadmin regardless. */}
      {tab === 'settings' && HOST_SCOPE !== 'admin' && (
        <div className="card" style={{ padding: 18, borderColor: 'var(--bad)', maxWidth: 720 }}>
          <h3 style={{ margin: '0 0 4px', color: 'var(--bad)' }}>Danger zone</h3>
          <div className="between">
            <div><strong>Delete this organization</strong><div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Removes the org and every project inside it.</div></div>
            <button className="btn danger" onClick={() => setDelOrg(true)}>Delete organization…</button>
          </div>
        </div>
      )}
      {delOrg && <ConfirmDelete kind="organization" name={orgName || orgId || ''} onClose={() => setDelOrg(false)}
        consequences={[`Delete organization “${orgName || orgId}”`, `Delete all ${projects.length} project(s) inside it`, 'Detach their engines / bots', 'Soft-delete — restorable from the org list (Show deleted)']}
        onConfirm={async () => { await api('/organizations', { method: 'DELETE', body: JSON.stringify({ id: orgId }) }); nav('/') }} />}
    </Shell>
  )
}

// ── Project detail — live monitoring dashboard ───────────────────────────────
const EVT_COLOR = (e: string) =>
  /fail|error|evict/.test(e) ? 'var(--bad)' :
  /suspend|stop|leave|disconnect/.test(e) ? 'var(--warn)' :
  /connect|woke|start|join|deliver/.test(e) ? 'var(--ok)' : 'var(--accent)'

// Channels: connect a chat surface (Teams, Slack, …) to this project. It mints a scoped service
// token + stores the channel's bot credentials in the project's ChannelDO — all via the admin
// session (no manual token). Per-project, per-channel; nothing here touches other projects.
function ChannelsPanel({ projectId, api }: { projectId: string; api: (path: string, init?: RequestInit) => Promise<Response> }) {
  const endpoint = `https://superatom.site/api/messaging/${projectId}/teams/messages`
  const [appId, setAppId] = useState(''); const [secret, setSecret] = useState(''); const [tenantId, setTenantId] = useState('')
  const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [showGuide, setShowGuide] = useState(false)
  const [status, setStatus] = useState<{ connected?: boolean; appId?: string; tenantId?: string; hasSecret?: boolean; configuredAt?: number } | null>(null)
  const fld: React.CSSProperties = { display: 'block', marginBottom: 10, fontSize: 13, color: 'var(--muted)' }
  const refreshStatus = () => api(`/messaging/${projectId}/teams/status`).then(r => (r.ok ? r.json() : null)).then(d => setStatus(d?.channels?.teams ?? null)).catch(() => {})
  useEffect(() => { refreshStatus() }, [projectId])   // show "connected" without ever re-exposing the secret
  async function connect(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null)
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
    <div>
      <div className="card" style={{ marginBottom: 14 }}>
        <strong>Messaging channels</strong>
        <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>Connect a chat surface to this project. Each connects to the engine as a scoped bot, routed by URL to this project only.</div>
      </div>
      <form onSubmit={connect} className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Microsoft Teams</strong>
          <button type="button" onClick={() => setShowGuide(v => !v)}
            style={{ fontSize: 12, padding: '3px 9px', border: '1px solid var(--line)', borderRadius: 6, background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }}>
            {showGuide ? '× Hide setup guide' : 'ⓘ Setup guide'}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12.5, margin: '4px 0 12px' }}>Set the messaging endpoint in Azure, then paste the bot's App ID, client secret, and tenant ID below and connect. First time? Open the setup guide.</div>
        {status?.connected && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', alignItems: 'center', margin: '0 0 12px', padding: '8px 12px', border: '1px solid var(--ok)', borderRadius: 8, background: 'rgba(60,190,120,.08)', fontSize: 12.5 }}>
            <span style={{ color: 'var(--ok)', fontWeight: 600 }}>● Connected</span>
            <span className="muted">App ID <span className="mono">{status.appId}</span></span>
            <span className="muted">Tenant <span className="mono">{status.tenantId}</span></span>
            <span className="muted">Client secret {status.hasSecret ? 'set ✓' : '—'}</span>
            {status.configuredAt ? <span className="muted">· configured {new Date(status.configuredAt).toLocaleString()}</span> : null}
            <span className="muted" style={{ flexBasis: '100%', fontSize: 11.5 }}>The secret is stored, never shown. Re-enter the fields below only to update it.</span>
          </div>
        )}
        {showGuide && (
          <ol style={{ margin: '0 0 14px', paddingLeft: 30, fontSize: 12.5, lineHeight: 1.65, color: 'var(--muted)', background: 'rgba(127,127,127,.06)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 14px 12px 32px' }}>
            <li><strong>Create the bot.</strong> Azure Portal → create an <em>Azure Bot</em> resource. For “Type of App”, <em>Multi-tenant</em> is simplest.</li>
            <li><strong>Enable the Teams channel.</strong> On the Azure Bot → <em>Channels</em> → select <em>Microsoft Teams</em> → agree &amp; apply. Without this, Teams can’t reach the bot.</li>
            <li><strong>Set the messaging endpoint.</strong> Copy the endpoint shown below → Azure Bot → <em>Configuration</em> → <em>Messaging endpoint</em> → Save.</li>
            <li><strong>App ID.</strong> Azure Bot → <em>Configuration</em> → <em>Microsoft App ID</em> (the app registration’s <em>Application (client) ID</em>).</li>
            <li><strong>Client secret.</strong> Azure Portal → <em>App registrations</em> → your bot’s app → <em>Certificates &amp; secrets</em> → <em>New client secret</em> → copy the <strong>Value</strong> immediately (shown only once — the “Secret ID” is <em>not</em> it).</li>
            <li><strong>Tenant ID.</strong> Azure Portal → <em>Microsoft Entra ID</em> → <em>Overview</em> → <em>Tenant ID</em> (needed for single-tenant apps).</li>
            <li><strong>Connect here.</strong> Paste the three values below → <em>Connect Teams</em>. This stores the credentials so the engine can answer — it does <em>not</em> yet put the bot in Teams.</li>
            <li><strong>Build the Teams app package</strong> (one per project — don’t reuse another project’s). A <em>.zip</em> of <em>manifest.json</em> + two icons (<em>color</em> 192×192, <em>outline</em> 32×32), all at the zip root. In manifest.json: set <em>bots[0].botId</em> (and <em>webApplicationInfo.id</em> if present) to <strong>this</strong> bot’s App ID, give it a <strong>new unique</strong> <em>id</em> (a fresh GUID — the app’s own id, not the bot’s), and a distinct <em>name</em>. (Prefer a UI? <em>dev.teams.microsoft.com → Apps → Import app</em> lets you edit + publish instead.)</li>
            <li><strong>Upload it to your org.</strong> Teams → <em>Apps</em> → <em>Manage your apps</em> → <em>Upload an app</em> → <em>“Upload an app to your org’s app catalog”</em> → pick the .zip. (Admins can also use <em>Teams admin center → Manage apps → Upload</em>.)</li>
            <li><strong>Find it in Teams.</strong> Teams → <em>Apps</em> → <em>Built for your org</em> → your app → <em>Add</em>. Org apps can take a while (up to ~24h) to appear — give it time and refresh.</li>
            <li><strong>Start chatting.</strong> Open a 1:1 chat with the bot and message it (e.g. “how many customers do we have?”), or add it to a channel and <em>@mention</em> it. It answers for <em>this</em> project only.</li>
          </ol>
        )}
        <label style={fld}>Messaging endpoint <span style={{ fontSize: 11 }}>(paste into Azure Bot → Configuration)</span>
          <input readOnly value={endpoint} onFocus={e => e.currentTarget.select()} className="mono" style={{ width: '100%', marginTop: 4, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6, fontSize: 12 }} />
        </label>
        <label style={fld}>App ID<input value={appId} onChange={e => setAppId(e.target.value)} required placeholder="b153838f-…" style={{ width: '100%', marginTop: 4, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6 }} /></label>
        <label style={fld}>Client secret<input value={secret} onChange={e => setSecret(e.target.value)} required type="password" placeholder="secret value" style={{ width: '100%', marginTop: 4, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6 }} /></label>
        <label style={fld}>Tenant ID<input value={tenantId} onChange={e => setTenantId(e.target.value)} required placeholder="b9bd0c3d-…" style={{ width: '100%', marginTop: 4, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: 6 }} /></label>
        <div className="row" style={{ gap: 10, marginTop: 12, alignItems: 'center' }}>
          <button className="btn" disabled={busy}>{busy ? 'Connecting…' : 'Connect Teams'}</button>
          {msg && <span style={{ fontSize: 13, color: msg.ok ? 'var(--ok)' : 'var(--bad)' }}>{msg.text}</span>}
        </div>
      </form>
      <div className="card" style={{ marginTop: 14, opacity: .55 }}>
        <strong>Slack</strong><div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>Coming soon — same flow, one adapter away.</div>
      </div>
    </div>
  )
}

// ── Access (per project) ────────────────────────────────────────────────────
// Who may use THIS project, and as what. People are created once in the organisation; here they are assigned.
// The assignment call goes to the ORG (it is the one that knows who belongs to it) and the org writes into this
// project — so a project can never invent a user of its own. Roles are the project's own.
function AccessPanel({ projectId, orgId, api, token }: { projectId: string; orgId: string | null; api: ReturnType<typeof useApi>; token: string | null }) {
  const [access, setAccess] = useState<any[]>([])
  const [roles, setRoles] = useState<any[]>([])
  const [orgUsers, setOrgUsers] = useState<any[]>([])
  const [err, setErr] = useState('')
  const orgApi = useApi(token, orgId)

  const load = useCallback(async () => {
    if (!token) return
    api(`/projects/${projectId}/access`).then(r => r.json()).then(d => setAccess(d.access ?? [])).catch(() => {})
    api(`/projects/${projectId}/roles`).then(r => r.json()).then(d => setRoles(d.roles ?? [])).catch(() => {})
    if (orgId) orgApi('/users').then(r => r.json()).then(d => setOrgUsers(Array.isArray(d) ? d : (d.users ?? []))).catch(() => {})
  }, [api, orgApi, projectId, orgId, token])
  useEffect(() => { load() }, [load])

  const assigned = new Set(access.map(a => String(a.email).toLowerCase()))
  const available = orgUsers.filter(u => !assigned.has(String(u.email).toLowerCase()))

  async function assign(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setErr('')
    const fd = new FormData(e.currentTarget)
    const r = await orgApi('/assignments', { method: 'POST', body: JSON.stringify({ projectId, email: fd.get('email'), roleId: fd.get('roleId') }) })
    if (!r.ok) { setErr(await r.text()); return }
    ;(e.target as HTMLFormElement).reset(); load()
  }
  async function unassign(email: string) {
    setErr('')
    const r = await orgApi('/assignments', { method: 'DELETE', body: JSON.stringify({ projectId, email }) })
    if (!r.ok) { setErr(await r.text()); return }
    load()
  }

  return (
    <>
      {err && <div className="card" style={{ padding: 10, borderColor: 'var(--bad)', marginBottom: 12 }}>{err}</div>}
      {!orgId && <div className="muted" style={{ marginBottom: 12 }}>Loading the organisation…</div>}

      <form onSubmit={assign} className="row" style={{ marginBottom: 18, gap: 8 }}>
        <select name="email" required className="input" style={{ flex: 1 }} disabled={!available.length}>
          {available.length
            ? available.map(u => <option key={u.email} value={u.email}>{u.email}{u.name ? ` — ${u.name}` : ''}</option>)
            : <option value="">everyone in the organisation already has access</option>}
        </select>
        <select name="roleId" className="input">
          {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
        <button className="btn" disabled={!available.length || !orgId}>Give access</button>
      </form>

      <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
        {access.map(a => (
          <div key={a.email} className="card" style={{ padding: 12 }}>
            <div className="between">
              <div>
                <strong>{a.email}</strong>
                <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {a.role_name ?? a.role_id}
                  {a.source === 'org-admin' && ' · administers the organisation'}
                </div>
              </div>
              {a.source === 'org-admin'
                ? <span className="muted" style={{ fontSize: 12 }}>managed by the organisation</span>
                : <button className="btn danger" onClick={() => unassign(a.email)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
      {access.length === 0 && <div className="empty">Nobody has been given access yet.</div>}

      <h3 style={{ marginTop: 26 }}>Roles</h3>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Roles belong to this project — the same person can hold a different one elsewhere.
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(240px,1fr))' }}>
        {roles.map(r => (
          <div key={r.id} className="card" style={{ padding: 12 }}>
            <div className="between"><strong>{r.name}</strong>{r.builtin && <span className="muted" style={{ fontSize: 11 }}>built-in</span>}</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{(r.permissions ?? []).join(', ') || '—'}</div>
          </div>
        ))}
      </div>
    </>
  )
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
      <div className="muted" style={{ marginBottom: 12, maxWidth: 720 }}>
        The index records the tables and fields each connected source has, so an agent can find where something
        lives instead of guessing. Building is resumable — running it again picks up where it left off and skips
        what is already indexed.
      </div>
      <div className="row" style={{ gap: 8, marginBottom: 16 }}>
        <button className="btn" disabled={busy || hub.status !== 'live'} onClick={() => start(false)}>
          {busy ? 'Building…' : 'Build / resume'}
        </button>
        <button className="btn danger" disabled={busy || hub.status !== 'live'} onClick={() => start(true)}>
          Rebuild from empty
        </button>
        {hub.status !== 'live' && <span className="muted" style={{ alignSelf: 'center', fontSize: 12.5 }}>the engine is not connected</span>}
      </div>

      {summary?.sources && (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(230px,1fr))', marginBottom: 16 }}>
          {summary.sources.map((s: any) => (
            <div key={s.id} className="card" style={{ padding: 12 }}>
              <div className="between"><strong>{s.id}</strong><span className="muted" style={{ fontSize: 11 }}>{s.dialect}</span></div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {s.error ? <span style={{ color: 'var(--bad)' }}>{s.error}</span>
                         : `${s.containers} tables · +${s.indexed} indexed · ${s.fields} fields`}
              </div>
            </div>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <pre style={{ background: 'var(--panel, #f6f6f4)', border: '1px solid var(--line, #ddd)', borderRadius: 6,
                      padding: 12, maxHeight: 420, overflow: 'auto', fontSize: 12.5, lineHeight: 1.5 }}>
          {lines.join('\n')}<div ref={endRef} />
        </pre>
      )}
    </>
  )
}

function ProjectDetailPage() {
  const token = useAuth(); const params = useParams<{ orgId: string; projectId: string; '*': string }>()
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
  const base = orgId ? `/org/${orgId}/projects/${projectId}` : `/pro/${projectId}`
  const setView = (v: string) => navigate(`${base}${v && v !== 'overview' ? '/' + v : ''}`)
  const [openGroup, setOpenGroup] = useState<string | null>(null)
  // The org + project NAMES (the sidebar/crumbs/header show real names, not just truncated ids).
  const [meta, setMeta] = useState<{ project?: string; org?: string }>({})
  // Settings view: the Teams bot credential + the Danger zone (delete). Kept OFF the project list — a delete is
  // never one click from a card.
  const [svc, setSvc] = useState<{ projectId: string; channel: string; token: string; wsUrl: string; expiresAt: number } | null>(null)
  const [delProj, setDelProj] = useState(false)
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

  // Nav items; an item with `children` expands INLINE in the sidebar (no second, nested sidebar
  // inside the content pane — that was eating ~280px of the working area).
  type NavItem = { id: string; label: string; icon: React.ReactNode; children?: { id: string; label: string; group?: string }[] }
  const items: NavItem[] = [
    { id: 'overview', label: 'Overview', icon: I.grid },
    { id: 'inspector', label: 'Inspector', icon: I.map, children: SECTIONS.map(s => ({ id: `inspector/${s.id}`, label: s.label, group: s.group })) },
    { id: 'events', label: 'Event log', icon: I.pulse },
    { id: 'subdomains', label: 'Subdomains', icon: I.globe },
    { id: 'agents', label: 'Agents', icon: I.term, children: [
      { id: 'agent', label: 'Connector' },
      { id: 'analyst', label: 'Analyst' },
      { id: 'grounding', label: 'Grounding' },
    ] },
    { id: 'access', label: 'Access', icon: I.grid },
    { id: 'index', label: 'Data index', icon: I.map },
    { id: 'channels', label: 'Channels', icon: I.chat },
    { id: 'settings', label: 'Settings', icon: I.grid },
  ]
  const title = view.startsWith('inspector/')
    ? `Inspector · ${SECTION_LABEL(view.slice('inspector/'.length) as Section)}`
    : items.find(i => i.id === view)?.label
      ?? items.flatMap(i => i.children ?? []).find(c => c.id === view)?.label
      ?? 'Overview'

  const nav = <>
    <div className="grp">{meta.project ?? `Project · ${projectId?.slice(0, 6)}…`}</div>
    {items.map(it => {
      const childActive = !!it.children && (view.startsWith(it.id + '/') || it.children.some(c => c.id === view))
      const expanded = openGroup === it.id || childActive   // auto-expand the group whose child is the active view
      return (
        <div key={it.id}>
          <a className={'nav' + (view === it.id || childActive ? ' on' : '')} style={{ cursor: 'pointer' }}
            onClick={() => {
              if (!it.children) { setView(it.id); return }
              // Toggle the group. Opening it also navigates to its first child, so one click gets you somewhere.
              if (expanded && openGroup === it.id) setOpenGroup(null)
              else { setOpenGroup(it.id); if (!childActive) setView(it.children[0].id) }
            }}>
            {it.icon}{it.label}
            {it.children && <span className={'chev' + (expanded ? ' open' : '')}>{I.chev}</span>}
          </a>
          {it.children && expanded && (() => {
            const out: React.ReactNode[] = []
            let lastGroup: string | undefined
            for (const c of it.children) {
              if (c.group && c.group !== lastGroup) {
                lastGroup = c.group
                out.push(<div key={'grp-' + c.group} style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--faint)', padding: '11px 0 3px 14px' }}>{c.group}</div>)
              }
              out.push(<a key={c.id} className={'subnav' + (view === c.id ? ' on' : '')} onClick={() => setView(c.id)}>{c.label}</a>)
            }
            return out
          })()}
        </div>
      )
    })}
  </>

  return (
    <Shell nav={nav} crumbs={<><Link to="/">Organizations</Link><span>/</span><Link to={`/org/${orgId}`}>{meta.org ?? <code className="mono">{orgId?.slice(0, 8)}…</code>}</Link><span>/</span>{meta.project ?? <code className="mono">{projectId?.slice(0, 8)}…</code>}</>}>
      {/* Compact header — org/project already live in the breadcrumb + sidebar, so the title stays tiny and
          the content gets the space. */}
      <div className="between" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: '.02em', color: 'var(--muted)' }}>{title}</span>
          {!loading && <Pill s={liveState} />}
        </div>
        {loading && <span className="row muted" style={{ fontSize: 12 }}><span className="spin" /> connecting…</span>}
      </div>

      {view === 'overview' && <>
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', marginBottom: 14 }}>
          <div className="tile"><div className="k">Compute</div><div className="v" style={{ fontSize: 15 }}>{provider === 'external' ? 'Local / EC2' : 'Fly machine'}</div></div>
          <div className="tile"><div className="k">State</div><div className="v"><Pill s={liveState} /></div></div>
          <div className="tile"><div className="k">Heartbeat</div><div className="v" style={{ fontSize: 15 }}>{m?.lastHeartbeat ? ago(m.lastHeartbeat) : '—'}</div></div>
          <div className="tile"><div className="k">Connections</div><div className="v">{conns.length}</div></div>
          {provider !== 'external' && m?.idlePhase && <div className="tile"><div className="k">Idle phase</div><div className="v" style={{ fontSize: 15 }}><Pill s={m.idlePhase} /></div></div>}
          {m?.region && <div className="tile"><div className="k">Region</div><div className="v" style={{ fontSize: 15 }}>{m.region}</div></div>}
        </div>
        <div className="card" style={{ marginBottom: 14 }}>
          <strong>Live connections</strong>
          {conns.length === 0
            ? <div className="muted" style={{ fontSize: 13, marginTop: 8 }}>Nobody connected to the hub right now.</div>
            : <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {conns.map((c: any) => (
                  <span key={c.wsId} className="row" style={{ gap: 6, padding: '5px 11px', border: '1px solid var(--line)', borderRadius: 999, fontSize: 13 }}>
                    <span className="dot" style={{ background: 'var(--ok)' }} /><strong>{c.type}</strong><code className="mono">{c.wsId}</code>
                  </span>
                ))}
              </div>}
        </div>
        <div className="card between">
          <div><strong>User app</strong><div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Open this project as an end user</div></div>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn" href={`https://${projectId}.superatom.site/`} target="_blank" rel="noreferrer">Open on superatom.site ↗</a>
            {domains[0] && <a className="btn ghost" href={`https://${domains[0]}.superatom.site`} target="_blank" rel="noreferrer">Open on {domains[0]}.superatom.site ↗</a>}
          </div>
        </div>
      </>}

      {view.startsWith('inspector/') && <Inspector hub={hub} section={view.slice('inspector/'.length) as Section} />}

      {view === 'events' && (
        <div className="card">
          <div className="between" style={{ marginBottom: 6 }}>
            <strong>Event log <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· from the Durable Object</span></strong>
            <span className="row muted" style={{ fontSize: 12 }}><span className="dot" style={{ background: 'var(--ok)' }} /> live</span>
          </div>
          {logs.length === 0 && <div className="empty">No events recorded yet.</div>}
          {logs.map((l: any) => (
            <div key={l.id} className="evt">
              <span className="dot" style={{ background: EVT_COLOR(l.event) }} />
              <code style={{ fontWeight: 700, color: EVT_COLOR(l.event), minWidth: 160 }}>{l.event}</code>
              <span className="muted" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.detail || ''}</span>
              <span className="mono" style={{ whiteSpace: 'nowrap' }}>{new Date(l.created_at * 1000).toLocaleTimeString()}</span>
            </div>
          ))}
        </div>
      )}

      {view === 'subdomains' && (
        <div className="card">
          <strong>Subdomains</strong>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 2, marginBottom: 10 }}>Map a name to this project. Users open <code className="mono">&lt;name&gt;.superatom.site</code>. (The project id also works directly.)</div>
          <div className="row" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 0, flex: 1, maxWidth: 360 }}>
              <input value={sub} onChange={e => checkSub(e.target.value.toLowerCase())} placeholder="acme"
                style={{ flex: 1, padding: '7px 10px', border: '1px solid var(--line)', borderRadius: '6px 0 0 6px', fontFamily: 'inherit' }} />
              <span style={{ padding: '7px 10px', border: '1px solid var(--line)', borderLeft: 'none', borderRadius: '0 6px 6px 0', fontSize: 13, color: 'var(--muted)' }}>.superatom.site</span>
            </div>
            <button className="btn" onClick={claimSub} disabled={!subState?.ok}>Claim</button>
            {subState && <span style={{ fontSize: 12.5, color: subState.ok ? 'var(--ok)' : 'var(--bad)' }}>{subState.msg}</span>}
          </div>
          {domains.length > 0 &&
            <div className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {domains.map(d => (
                <span key={d} className="row" style={{ gap: 8, padding: '5px 11px', border: '1px solid var(--line)', borderRadius: 999, fontSize: 13 }}>
                  <a className="mono" href={`https://${d}.superatom.site`} target="_blank" rel="noreferrer" style={{ color: 'inherit', textDecoration: 'none' }}>{d}.superatom.site ↗</a>
                  <span onClick={() => releaseSub(d)} style={{ cursor: 'pointer', color: 'var(--bad)' }} title="release">×</span>
                </span>
              ))}
            </div>}
        </div>
      )}

      {view === 'settings' && (
        <div style={{ maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card" style={{ padding: 18 }}>
            <strong>Teams bot credential</strong>
            <div className="muted" style={{ fontSize: 12.5, margin: '4px 0 12px' }}>Generate a scoped service token so a Teams bot can act as this project’s runtime. Shown once.</div>
            <button className="btn ghost" onClick={() => genServiceToken('teams')}>Generate Teams token</button>
          </div>
          <div className="card" style={{ padding: 18, borderColor: 'var(--bad)' }}>
            <h3 style={{ margin: '0 0 4px', color: 'var(--bad)' }}>Danger zone</h3>
            <div className="between">
              <div><strong>Delete this project</strong><div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Tears down its engine wiring, machine mapping, and channel credentials.</div></div>
              <button className="btn danger" onClick={() => setDelProj(true)}>Delete project…</button>
            </div>
          </div>
        </div>
      )}

      {svc && (() => {
        const env = `SA_HUB_WS=${svc.wsUrl}\nSA_PROJECT_ID=${svc.projectId}\nSA_ENGINE_TOKEN=${svc.token}`
        const exp = new Date(svc.expiresAt).toLocaleDateString()
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setSvc(null)}>
            <div className="card" style={{ maxWidth: 660, width: '92%', padding: 22 }} onClick={e => e.stopPropagation()}>
              <h3 style={{ marginTop: 0 }}>{svc.channel} bot credential — service token</h3>
              <p className="muted" style={{ marginTop: 4 }}>Paste into the surface’s <code>.env</code>. Authorizes the bot as a <code>runtime</code> for this project only, until {exp}.</p>
              <textarea readOnly value={env} onFocus={e => e.currentTarget.select()} rows={4} style={{ width: '100%', fontFamily: 'monospace', fontSize: 13, padding: 12, borderRadius: 8, resize: 'vertical', whiteSpace: 'pre' }} />
              <div className="row" style={{ gap: 8, marginTop: 12, alignItems: 'center' }}>
                <button className="btn" onClick={() => { navigator.clipboard?.writeText(env) }}>Copy</button>
                <button className="btn ghost" onClick={() => setSvc(null)} style={{ marginLeft: 'auto' }}>Close</button>
              </div>
            </div>
          </div>
        )
      })()}
      {delProj && <ConfirmDelete kind="project" name={meta.project || projectId || ''} onClose={() => setDelProj(false)}
        consequences={[`Delete project “${meta.project || projectId}”`, 'Tear down its engine wiring + machine mapping', 'Revoke its channel / bot credentials', 'Soft-delete — restorable from the org’s project list (Show deleted)']}
        onConfirm={async () => { await api('/projects', { method: 'DELETE', body: JSON.stringify({ id: projectId }) }); navigate(`/org/${orgId}`) }} />}

      {view === 'agent' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="card between">
            <div><strong>Data source</strong><div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>Upload a file the agent can use, or just describe the source in the console below.</div></div>
            <div className="row">
              {error && <span style={{ fontSize: 12, color: 'var(--bad)' }}>{error}</span>}
              <label className="btn ghost" style={{ cursor: 'pointer' }}>
                {uploading ? 'Uploading…' : '+ Upload file'}
                <input type="file" onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }} style={{ display: 'none' }} disabled={uploading} />
              </label>
            </div>
          </div>
          <ConnectorConsole hub={hub} />
        </div>
      )}

      {view === 'analyst' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <AnalystConsole hub={hub} />
        </div>
      )}

      {view === 'grounding' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <GroundingConsole hub={hub} />
        </div>
      )}

      {view === 'index' && <IndexPanel hub={hub} />}
      {view === 'access' && <AccessPanel projectId={projectId!} orgId={orgId ?? status?.orgId ?? null} api={api} token={token} />}
      {view === 'channels' && <ChannelsPanel projectId={projectId!} api={api} />}
    </Shell>
  )
}
