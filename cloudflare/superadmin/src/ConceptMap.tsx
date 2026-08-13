import { useEffect, useRef, useState, useMemo } from 'react'

// Per-project concept/unit/program map. Connects to the project's hub (where code-engine
// is — always superatom.site, even when the admin SPA is served locally), authenticates as
// the superadmin 'admin' role, and does the introspect req/res through the DO relay. The DO
// stores nothing; code-engine answers from its SQLite graph.

const HUB = 'wss://superatom.site'

type ConceptView = {
  id: string; label: string; summary: string; requires: string[]
  missingUnits: string[]; lazy: boolean; programs: string[]; needs: string | null
}
type ProjectMap = {
  concepts: ConceptView[]
  units: { name: string; summary: string; file: string }[]
  programs: { file: string; tier: string }[]
}

// Stripe-ish tokens.
const C = {
  purple: '#635bff', ink: '#1a1f36', sub: '#697386', line: '#e3e8ee', bg: '#f6f8fa',
  green: '#0e7c46', greenBg: '#d7f4e3', amber: '#9a6700', amberBg: '#fdf1d6', chip: '#eef1f6',
}

export type Hub = {
  status: 'connecting' | 'live' | 'down'
  map: ProjectMap | null
  err: string
  logs: string[]
  refresh: () => void
  requestLogs: () => void
  send: (msg: any) => void                          // send a raw frame through the ONE shared project socket
  subscribe: (fn: (m: any) => void) => () => void   // receive every (unwrapped) message; returns an unsubscribe
}

// One persistent hub connection per PROJECT — lives in ProjectDetailPage so it survives
// switching between sidebar views (Concept map / Event log). Previously the WS lived inside
// ConceptMap, so changing views unmounted it and forced a reconnect.
export function useProjectHub(projectId: string | undefined, token: string | null): Hub {
  const [status, setStatus] = useState<Hub['status']>('connecting')
  const [map, setMap] = useState<ProjectMap | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [err, setErr] = useState<string>('')
  const wsRef = useRef<WebSocket | null>(null)
  const subscribers = useRef(new Set<(m: any) => void>())

  const ask = (t: string) => wsRef.current?.readyState === 1 &&
    wsRef.current.send(JSON.stringify({ to: { type: 'code-engine' }, payload: { t, reqId: Math.random().toString(36).slice(2) } }))

  useEffect(() => {
    if (!token || !projectId) return
    let closed = false
    function connect() {
      const ws = new WebSocket(`${HUB}/_ws/${projectId}?token=${encodeURIComponent(token!)}`)
      wsRef.current = ws
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token, role: 'admin' }))
      ws.onclose = () => { setStatus('down'); if (!closed) setTimeout(connect, 3000) }
      ws.onerror = () => ws.close()
      ws.onmessage = (e) => {
        const raw = JSON.parse(e.data); const m = raw.payload ?? raw
        if (m?.t === 'welcome') { setStatus('live'); ask('introspect:req') }
        else if (m?.t === 'introspect:res') { m.error ? setErr(m.error) : setMap(m.map) }
        else if (m?.t === 'logs:res') { setLogs(m.lines ?? []) }
        else if (m?.t === 'error') setErr(m.message ?? m.reason ?? 'hub error')
        subscribers.current.forEach(fn => { try { fn(m) } catch { /* one bad subscriber can't break the hub */ } })
      }
    }
    connect()
    // Keepalive so the non-hibernating DO stays warm and the idle admin WS isn't dropped.
    const ka = setInterval(() => { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify({ type: 'heartbeat' })) }, 12000)
    return () => { closed = true; clearInterval(ka); wsRef.current?.close() }
  }, [token, projectId])

  return {
    status, map, err, logs,
    refresh: () => ask('introspect:req'), requestLogs: () => ask('logs:req'),
    send: (msg: any) => { if (wsRef.current?.readyState === 1) wsRef.current.send(JSON.stringify(msg)) },
    subscribe: (fn: (m: any) => void) => { subscribers.current.add(fn); return () => { subscribers.current.delete(fn) } },
  }
}

export function ConceptMap({ hub }: { hub: Hub }) {
  const { status, map, err, refresh } = hub
  const [sel, setSel] = useState<string | null>(null)

  const concept = useMemo(() => map?.concepts.find(c => c.id === sel) ?? null, [map, sel])
  // Associated concepts = those sharing a required unit (the DAG link).
  const associated = useMemo(() => {
    if (!map || !concept) return []
    const mine = new Set(concept.requires)
    return map.concepts.filter(c => c.id !== concept.id && c.requires.some(u => mine.has(u)))
  }, [map, concept])

  const badge = (c: ConceptView) => c.lazy
    ? { t: 'frontier', bg: C.amberBg, fg: C.amber }
    : c.missingUnits.length || c.programs.length === 0
      ? { t: c.missingUnits.length ? 'no unit' : 'no program', bg: C.amberBg, fg: C.amber }
      : { t: 'built', bg: C.greenBg, fg: C.green }

  return (
    <div style={s.wrap}>
      <div style={s.head}>
        <div>
          <div style={s.title}>Concept map</div>
          <div style={s.subtle}>Live from code-engine’s SQLite graph</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ ...s.dot, background: status === 'live' ? C.green : status === 'down' ? '#d4365b' : '#c7ccd6' }} />
          <span style={s.subtle}>{status}</span>
          <button style={s.btn} onClick={refresh} disabled={status !== 'live'}>Refresh</button>
        </div>
      </div>

      {err && <div style={s.err}>⚠ {err}</div>}

      <div style={s.cols}>
        <div style={s.sidebar}>
          <div style={s.sideHdr}>Concepts {map ? `(${map.concepts.length})` : ''}</div>
          {!map && <div style={s.subtle}>Loading…</div>}
          {map?.concepts.map(c => {
            const b = badge(c); const active = c.id === sel
            return (
              <div key={c.id} onClick={() => setSel(c.id)}
                style={{ ...s.row, ...(active ? s.rowActive : {}) }}>
                <div style={{ fontWeight: 600, color: active ? C.purple : C.ink }}>{c.label}</div>
                <span style={{ ...s.pill, background: b.bg, color: b.fg }}>{b.t}</span>
              </div>
            )
          })}
        </div>

        <div style={s.detail}>
          {!concept && <div style={s.empty}>Select a concept to see its units, program, and linked concepts.</div>}
          {concept && (
            <>
              <div style={s.dTitle}>{concept.label}</div>
              <div style={s.dSummary}>{concept.summary}</div>

              <Section label="Required units">
                {concept.requires.length === 0 && <span style={s.subtle}>none</span>}
                {concept.requires.map(u => (
                  <span key={u} style={{ ...s.chip, ...(concept.missingUnits.includes(u) ? { color: C.amber, background: C.amberBg } : {}) }}>
                    {u}{concept.missingUnits.includes(u) ? ' (missing)' : ''}
                  </span>
                ))}
              </Section>

              <Section label="Program">
                {concept.programs.length > 0
                  ? concept.programs.map(p => <span key={p} style={s.chip}>{p}</span>)
                  : <div style={{ ...s.needs }}>{concept.needs ?? 'not built yet'}</div>}
              </Section>

              <Section label="Linked concepts (share a unit)">
                {associated.length === 0 && <span style={s.subtle}>none</span>}
                {associated.map(a => (
                  <span key={a.id} style={{ ...s.chip, cursor: 'pointer', color: C.purple }} onClick={() => setSel(a.id)}>{a.label}</span>
                ))}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 18 }}>
      <div style={s.secLabel}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>{children}</div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  wrap: { border: `1px solid ${C.line}`, borderRadius: 12, background: '#fff', overflow: 'hidden' },
  head: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: `1px solid ${C.line}` },
  title: { fontSize: 15, fontWeight: 700, color: C.ink },
  subtle: { fontSize: 12, color: C.sub },
  dot: { width: 8, height: 8, borderRadius: 8, display: 'inline-block' },
  btn: { fontSize: 12, fontWeight: 600, color: C.purple, background: '#fff', border: `1px solid ${C.line}`, borderRadius: 7, padding: '5px 10px', cursor: 'pointer' },
  err: { margin: 14, padding: '8px 12px', background: '#fdeaee', color: '#b3093c', borderRadius: 8, fontSize: 13 },
  cols: { display: 'grid', gridTemplateColumns: '280px 1fr', minHeight: "calc(100vh - 250px)" },
  sidebar: { borderRight: `1px solid ${C.line}`, padding: 10, background: C.bg, overflowY: 'auto', maxHeight: "calc(100vh - 250px)" },
  sideHdr: { fontSize: 11, fontWeight: 700, color: C.sub, textTransform: 'uppercase', letterSpacing: '.04em', padding: '6px 8px' },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '9px 10px', borderRadius: 8, cursor: 'pointer', marginBottom: 2 },
  rowActive: { background: '#fff', boxShadow: `inset 0 0 0 1px ${C.line}` },
  pill: { fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 20, whiteSpace: 'nowrap' },
  detail: { padding: '18px 22px', overflowY: 'auto', maxHeight: "calc(100vh - 250px)" },
  empty: { color: C.sub, fontSize: 13, paddingTop: 40, textAlign: 'center' },
  dTitle: { fontSize: 18, fontWeight: 700, color: C.ink },
  dSummary: { fontSize: 13.5, color: C.sub, marginTop: 4, lineHeight: 1.5 },
  secLabel: { fontSize: 11, fontWeight: 700, color: C.sub, textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 },
  chip: { fontSize: 12.5, fontWeight: 500, color: C.ink, background: C.chip, borderRadius: 7, padding: '5px 10px', fontFamily: 'ui-monospace, monospace' },
  needs: { fontSize: 13, color: C.amber, background: C.amberBg, borderRadius: 8, padding: '10px 12px', lineHeight: 1.5 },
}
