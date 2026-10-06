import { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react'
import { sender, receiver } from '../../../clients/transport'
import { parcelStore, apiOfHub } from '../../../clients/parcels'
import { useSession, useClerk, SignIn } from '@clerk/react'
import { loadToken, mintToken, dropToken, claimReauthOnce, tokenValid } from '../../shared/session-token'
const Workspace = lazy(() => import('./Workspace'))
import type { WorkAgent } from './Workspace'

// Cloud mode: VITE_HUB_URL set (e.g. wss://superatom.site). The page is served at
// /u behind the worker; it logs in via Clerk, exchanges for our JWT, and connects to
// the hub at wss://<hub>/_ws/<projectId>?token=… with envelope-wrapped messages.
// Local dev: VITE_HUB_URL unset → talk straight to the code-engine, no auth/envelope.
// On *.superatom.site the worker injects window.__HUB_URL__ / __PROJECT_ID__ into the
// HTML (subdomain → projectId, resolved server-side). Those win; otherwise fall back to
// the build-time VITE_HUB_URL (superatom.site path) and ?project=.
const INJECTED_HUB = (globalThis as any).__HUB_URL__ as string | undefined
const HUB   = INJECTED_HUB ?? (import.meta.env.VITE_HUB_URL as string | undefined)
const CLOUD = !!HUB
const VM_WS  = import.meta.env.VITE_VM_WS  ?? 'ws://localhost:5050'
const VM_HTTP = VM_WS.replace('ws://', 'http://').replace('wss://', 'https://')

// Cloud auth gate — only rendered inside <ClerkProvider> (main.tsx). Logs in, exchanges
// the Clerk session for our JWT, reads the project from ?project=, then renders <App>.
export function CloudGate() {
  const { isSignedIn, session } = useSession()
  const { signOut } = useClerk()
  const [token, setToken] = useState<string | null>(loadToken)
  const projectId = (globalThis as any).__PROJECT_ID__ ?? new URLSearchParams(location.search).get('project') ?? ''
  useEffect(() => {
    if (tokenValid(token) || !session) return
    session.getToken().then((ct: string | null) => mintToken(ct).then((t) => { if (t) setToken(t) }))
  }, [session, token])

  // ── The session cookie ──────────────────────────────────────────────────────
  // This app authenticates every call with a header, which is fine while its own JS is running. A plain
  // NAVIGATION carries no header — nothing of ours has run yet — so anything served as a page rather than
  // fetched by this app cannot be authorised at all. That is what a dashboard is.
  //
  // Handing the same token to the browser as a cookie closes it. Done on every load, not only when the token
  // is first minted: the cookie expires on its own schedule and a token kept in localStorage would otherwise
  // never renew it.
  //
  // `?next=` is how a gated page sends someone here to sign in. Once the cookie exists, go back to it.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    fetch('/api/auth/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      .then((r) => {
        if (cancelled || !r.ok) return
        const next = new URLSearchParams(location.search).get('next')
        // Only a path on this site — never an absolute URL, which would be an open redirect.
        if (!next || !next.startsWith('/') || next.startsWith('//')) return
        // ONCE. Being signed in is not the same as being allowed: someone with no access to this project would
        // otherwise bounce between the gated page and here for ever, each side doing exactly its job. One
        // attempt, then the gate's own 401 is left to speak.
        const tried = `sa-next:${next}`
        if (sessionStorage.getItem(tried)) return
        sessionStorage.setItem(tried, '1')
        location.replace(next)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  if (!isSignedIn) return <div style={{ maxWidth: 420, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui' }}><h2>Superatom</h2><SignIn /></div>
  if (!projectId) return <div style={{ maxWidth: 480, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui', color: '#8a8276' }}>No project selected. Open this app with <code>?project=&lt;id&gt;</code>.</div>
  if (!token)     return <div style={{ maxWidth: 420, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui', color: '#8a8276' }}>Signing in…</div>
  return <App token={token} projectId={projectId} onSignOut={() => { dropToken(); void signOut() }} />
}

/** An agent as `session:agents` describes it, read defensively (the engine's words are not trusted to be well formed). */
const agentOf = (a: any): WorkAgent => ({
  id: a.id, name: String(a.name ?? a.id), isDefault: !!a.isDefault,
  look: {
    icon: typeof a.look?.icon === 'string' ? a.look.icon : undefined,
    accent: typeof a.look?.accent === 'string' ? a.look.accent : undefined,
    says: typeof a.look?.says === 'string' ? a.look.says : undefined,
    main: typeof a.look?.main?.label === 'string' ? { label: a.look.main.label, says: typeof a.look.main.says === 'string' ? a.look.main.says : undefined } : undefined,
  },
  starts: Array.isArray(a.starts) ? a.starts.filter((x: any) => x && typeof x.key === 'string' && typeof x.label === 'string').map((x: any) => ({ key: x.key, label: x.label, says: String(x.says ?? '') })) : [],
})

/** The workspace's address: /w (home), /w/<session>, /w/s/<agent>[/<start>]. Earlier addresses land in it. */
function readPath(): string {
  const p = location.pathname.replace(/\/+$/, '')
  if (/^\/w(\/|$)/.test(p)) return p.replace(/^\/w\/?/, '')
  const chat = /^\/c\/([\w-]+)/.exec(p)
  const agent = /^\/s\/([\w-]+(?:\/[\w-]+)?)/.exec(p)
  const page = ['/connections', '/agents', '/activity'].includes(p) ? `?page=${p.slice(1)}` : ''
  const path = chat ? chat[1] : agent ? `s/${agent[1]}` : ''
  history.replaceState(null, '', `/w${path ? `/${path}` : ''}${page || location.search}`)
  return path
}

/** The user UI: one socket (to the person's UserDO in the cloud, to the engine locally) and the workspace on it. */
export function App({ token, projectId = 'default', onSignOut }: { token?: string | null; projectId?: string; onSignOut?: () => void } = {}) {
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState('')
  const [path, setPath] = useState(readPath)
  const [agents, setAgents] = useState<WorkAgent[]>([])
  const [scopes, setScopes] = useState<string[]>([])
  const [caps, setCaps] = useState<string[]>([])
  const [proj, setProj] = useState<{ id?: string; name?: string } | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const wireIn = useRef<ReturnType<typeof receiver> | null>(null)
  // A request is answered by the reply that carries its reqId; frames reporting progress on it keep it waiting.
  const waiting = useRef(new Map<string, (m: any) => void>())
  const progress = useRef(new Map<string, (m: any) => void>())
  // Requests made before the socket is ready (open, and welcomed where there is a hub) wait for it.
  const queued = useRef<any[]>([])
  const ready = useRef(false)
  // Everything else the wire brings (activity, an agent's log) goes to whoever listens.
  const live = useRef(new Set<(m: any) => void>())

  const send = useCallback((payload: any) => {
    const ws = wsRef.current
    if (ws?.readyState !== 1 || !ready.current) { queued.current.push(payload); return }
    void sender({ send: (frame) => ws.send(JSON.stringify(CLOUD ? { to: { type: 'code-engine' }, payload: frame } : frame)) }).send(payload)
  }, [])
  const flush = () => { ready.current = true; for (const p of queued.current.splice(0)) send(p) }
  const request = useCallback((payload: Record<string, unknown>, onProgress?: (m: any) => void) => new Promise<any>((resolve) => {
    const reqId = `ui-${Math.random().toString(36).slice(2, 10)}`
    waiting.current.set(reqId, (m) => { progress.current.delete(reqId); resolve(m) })
    if (onProgress) progress.current.set(reqId, onProgress)
    // Words take an agent minutes; a control or a read, seconds.
    setTimeout(() => { if (waiting.current.delete(reqId)) { progress.current.delete(reqId); resolve({ t: 'error', reason: 'no answer in time' }) } }, payload.kind === 'language' ? 1_800_000 : 120_000)
    send({ ...payload, reqId })
  }), [send])
  const subscribeLive = useCallback((fn: (m: any) => void) => { live.current.add(fn); return () => { live.current.delete(fn) } }, [])
  const go = useCallback((p: string) => { history.pushState(null, '', `/w${p ? `/${p}` : ''}`); setPath(p) }, [])
  useEffect(() => {
    const onPop = () => setPath(readPath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (CLOUD && !token) return
    let closed = false
    const welcomed = () => { flush(); send({ t: 'session:agents' }) }
    function connect() {
      const ws = new WebSocket(CLOUD ? `${HUB}/_ws/${projectId}?token=${encodeURIComponent(token!)}` : VM_WS)
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true); setStatus('')
        if (CLOUD) ws.send(JSON.stringify({ type: 'hello', token, role: 'runtime' }))
        else welcomed()
      }
      // Why it closed, said: the hub closes with 4001 (bad or expired token) and 4003 (no access), neither worth retrying.
      ws.onclose = (e) => {
        ready.current = false
        wireIn.current?.reset()
        setConnected(false)
        console.warn(`[ws] closed ${e.code}${e.reason ? ` — ${e.reason}` : ''}`)
        if (e.code === 4001) { dropToken(); setStatus('Session expired — signing in again…'); if (claimReauthOnce()) location.reload(); return }
        if (e.code === 4003) { setStatus('This account does not have access to this project.'); return }
        if (!closed) setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
      // Large messages (parts, parcels) are the transport's business: frames in, whole messages out.
      const inbound = receiver({ deliver: (whole) => onWire(whole), parcels: CLOUD ? parcelStore({ api: apiOfHub(HUB!), projectId }) : undefined })
      wireIn.current = inbound
      ws.onmessage = (e) => {
        const raw = JSON.parse(e.data)
        const frame = CLOUD ? raw.payload : raw
        if (frame) void inbound.receive(frame)
      }
      const onWire = (msg: any) => {
        if (!msg || msg.t === 'tick') return
        if (msg.reqId && (msg.t === 'narration' || msg.t === 'app:said:part') && progress.current.has(msg.reqId)) { progress.current.get(msg.reqId)!(msg); return }
        if (msg.reqId && waiting.current.has(msg.reqId)) { const w = waiting.current.get(msg.reqId)!; waiting.current.delete(msg.reqId); w(msg); return }
        if (msg.t === 'session:agents') { setAgents(Array.isArray(msg.agents) ? msg.agents.filter((a: any) => a && typeof a.id === 'string').map(agentOf) : []); return }
        if (msg.t === 'welcome') {
          if (msg.project) { setProj(msg.project); if (msg.project.name) document.title = msg.project.name }
          if (Array.isArray(msg.scopes)) setScopes(msg.scopes)
          if (Array.isArray(msg.caps)) setCaps(msg.caps)
          welcomed()
          return
        }
        if (msg.t === 'machine:waking') { setStatus('Starting the engine…'); return }
        for (const fn of live.current) fn(msg)
      }
    }
    connect()
    return () => { closed = true; wsRef.current?.close() }
  }, [token, projectId])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Suspense fallback={<div style={{ padding: 24, color: '#7a746c' }}>Opening…</div>}>
      <Workspace request={request} send={send} subscribeLive={subscribeLive} scopes={scopes} caps={caps} projectId={projectId} token={token} projectName={proj?.name || 'Superatom'}
        connected={connected} status={status} agents={agents} path={path} go={go} onSignOut={onSignOut} />
    </Suspense>
  )
}
