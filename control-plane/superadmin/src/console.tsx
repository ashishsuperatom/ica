// The admin console's shared pieces: how a page reaches the API (useAuth, useApi with its browser cache), the page
// frame (Shell), a state word as a Status (Pill), the console's dialog, a copyable env block and the guard before a delete.
import { useLocation, useNavigate } from 'react-router-dom'
import { useState, useEffect, useCallback, useMemo, createContext, useSyncExternalStore } from 'react'
import { cached as cacheRead, keep as cacheKeep, forget as cacheForget, changed as cacheChanged, revision as cacheRevision, subscribe as cacheSubscribe } from './cache'
import { loadToken, mintToken, dropToken, claimReauthOnce, tokenValid } from '../../shared/session-token'
import { useSession } from '@clerk/react'
import { Section as SectionCard, Notice, Code, Form, Field, Status, type StatusState, type Accent } from '@superatom/ui'
import '@superatom/ui/design.css'

// a machine's or a thing's state word → the state it is in
export const STATE_OF: Record<string, StatusState> = {
  started: 'ok', running: 'ok', active: 'ok', online: 'ok',
  starting: 'attention', created: 'attention', creating: 'attention', pending: 'attention',
  suspended: 'attention', stopping: 'attention', stopped: 'neutral',
  destroyed: 'critical', destroying: 'critical',
}
export function Pill({ s }: { s?: string }) {
  return <Status state={STATE_OF[s ?? ''] ?? 'neutral'}>{s ?? 'unknown'}</Status>
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

export function useAuth() {
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
export const LIVE = /\/(status|logs|attention)(\?|$)/
export function useApi(token: string | null, orgId?: string | null) {
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
export const ShellMode = createContext<'page' | 'block'>('block')

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="admin-block">
      <div className="content"><div className="sa-stack sa-stack--4">{children}</div></div>
    </div>
  )
}

// ── A dialog over the page ───────────────────────────────────────────────────
// The design system has no dialog yet: this is the one place that draws the scrim, and everything inside is a Section.
export function Dialog({ icon, accent, title, subtitle, onClose, footer, children }: {
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
export function EnvBlock({ text }: { text: string }) {
  return (
    <div className="sa-stack sa-stack--3" tabIndex={0} aria-label="Values to copy" onFocus={(e) => window.getSelection()?.selectAllChildren(e.currentTarget)}>
      {text.split('\n').map((l) => <Code key={l}>{l}</Code>)}
    </div>
  )
}

/** "Show deleted" — a filter on a list, in its section's head. */
export function ShowDeleted({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return <label className="sa-row sa-row--tight sa-muted"><input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /> Show deleted</label>
}

// ── Destructive-action guard ─────────────────────────────────────────────────
// A delete is NEVER one click from a list. This modal spells out the consequences and only arms the
// Delete button once the user has typed the exact resource name — so deletion is always deliberate.
export function ConfirmDelete({ kind, name, consequences, onConfirm, onClose }: {
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

export function Moved({ to }: { to: (path: string, q: URLSearchParams) => string }) {
  const loc = useLocation(); const nav = useNavigate()
  useEffect(() => { nav(to(loc.pathname, new URLSearchParams(loc.search)), { replace: true }) }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  return null
}
