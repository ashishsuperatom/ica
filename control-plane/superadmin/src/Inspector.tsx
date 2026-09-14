// ── INSPECTOR — the admin's read-only window into a project's engine ─────────
// The engine runs on a Fly VM with nothing listening, so everything here comes over the hub
// relay (admin → ProjectDO → code-engine) as `inspect:req` / `inspect:res`. See vm/apps/engine/inspect.ts.
//
// A read-only window into the program graph (graph.sqlite) and the stores around it:
//
//   programs        every program a name points at: contract, body, relation shape, version history
//   calls           memory — every call, with its request, decisions, checks, caveats, queries and output
//   data sessions   each session's steps: the message, the state it led to, and the call that answered it
//   grounding       value→id resolution the grounding agent built
//   index           the fields each data source has, as ./find-schema searches them
//   files · db · logs   the agents' directories, the raw table inventory, the engine's log channel
//
// Everything links through: a program to its recent calls, a call to its children, a session step to its call.

import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { Hub } from './hub'

export type Section =
  | 'summary' | 'programs' | 'calls' | 'sessions' | 'grounding' | 'index' | 'files' | 'db' | 'logs'

// Grouped so the views read as a few coherent buckets, not one flat list.
export const SECTIONS: { id: Section; label: string; group?: string }[] = [
  { id: 'summary',   label: 'Summary' },
  { id: 'programs',  label: 'Programs',         group: 'Graph' },
  { id: 'calls',     label: 'Calls',            group: 'Graph' },
  { id: 'sessions',  label: 'Data sessions',    group: 'Graph' },
  { id: 'grounding', label: 'Grounding',        group: 'Knowledge' },
  { id: 'index',     label: 'Datasource index', group: 'Knowledge' },
  { id: 'files',     label: 'Files',            group: 'Storage' },
  { id: 'db',        label: 'Database',         group: 'Storage' },
  { id: 'logs',      label: 'Logs',             group: 'Storage' },
]
export const SECTION_LABEL = (s: Section) => SECTIONS.find(x => x.id === s)?.label ?? 'Inspector'

// ── styles (injected once) ───────────────────────────────────────────────────
const CSS = `
.ins{display:flex;flex-direction:column;gap:12px;min-height:0}
.ins .bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ins .search{flex:1;min-width:180px;max-width:420px}
.ins table{width:100%;border-collapse:collapse;font-size:13px}
.ins thead th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--faint);
 font-weight:600;padding:0 10px 7px;border-bottom:1px solid var(--line);white-space:nowrap}
.ins tbody td{padding:8px 10px;border-bottom:1px solid var(--line2);vertical-align:top}
.ins tbody tr{cursor:pointer}
.ins tbody tr:hover{background:#f8f9fc}
.ins tbody tr.on{background:#f0f1ff}
.ins .trunc{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ins .clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--sub)}
.ins .chip{display:inline-block;font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:var(--line2);
 color:var(--ink);border-radius:5px;padding:2px 7px;white-space:nowrap}
.ins .chip.link{cursor:pointer;color:var(--purple)}
.ins .chip.link:hover{background:#e7e9ff}
.ins .tag{display:inline-block;font-size:10.5px;font-weight:700;border-radius:999px;padding:2px 8px;white-space:nowrap}
.ins .num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.ins .kv{display:grid;grid-template-columns:150px 1fr;gap:5px 14px;font-size:13px}
.ins .kv dt{color:var(--sub)}
.ins .kv dd{margin:0;word-break:break-word}
.ins .facet{border:1px solid var(--line);border-radius:9px;padding:11px 13px;background:#fff}
.ins .axes{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}
.ins .sect{font-size:10.5px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;margin:16px 0 7px}
.ins .sect:first-child{margin-top:0}
/* slide-over detail — overlays instead of permanently stealing width from the table */
.ins-over{position:fixed;inset:0;background:rgba(26,31,54,.34);z-index:900;display:flex;justify-content:flex-end}
.ins-panel{background:#fff;width:min(920px,82vw);height:100vh;display:flex;flex-direction:column;
 box-shadow:-8px 0 28px rgba(26,31,54,.16);animation:slidein .16s ease-out}
@keyframes slidein{from{transform:translateX(24px);opacity:.6}to{transform:none;opacity:1}}
.ins-panel .ph{display:flex;align-items:flex-start;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)}
.ins-panel .pb{flex:1;overflow:auto;padding:16px 18px 40px}
.ins-panel .x{margin-left:auto;cursor:pointer;color:var(--faint);font-size:20px;line-height:1;padding:0 4px}
.ins-panel .x:hover{color:var(--ink)}
.ins code.src{display:block;background:#0d1117;color:#c9d1d9;border-radius:8px;padding:12px 14px;overflow:auto;
 font-size:12px;line-height:1.55;white-space:pre;max-height:62vh}
.ins pre.json{background:#f6f8fb;border:1px solid var(--line);border-radius:8px;padding:11px 13px;overflow:auto;
 font-size:12px;line-height:1.5;max-height:46vh;margin:0}
`
let injected = false
function useCss() {
  useEffect(() => {
    if (injected) return
    injected = true
    const el = document.createElement('style'); el.textContent = CSS; document.head.appendChild(el)
  }, [])
}

// ── helpers ──────────────────────────────────────────────────────────────────
const bytes = (n?: number | null) => n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`
const when = (ms?: number | null) => {
  if (!ms) return '—'
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return new Date(ms).toLocaleDateString()
}
const STATUS_COLOR: Record<string, string> = {
  ok: 'var(--ok)', current: 'var(--ok)', held: 'var(--ok)', failed: 'var(--bad)', error: 'var(--bad)', superseded: 'var(--sub)',
}
function Tag({ t }: { t?: string | null }) {
  if (!t) return null
  const c = STATUS_COLOR[t] ?? 'var(--sub)'
  return <span className="tag" style={{ background: `color-mix(in srgb, ${c} 13%, #fff)`, color: c }}>{t}</span>
}
const count = (o?: Record<string, unknown> | null) => Object.keys(o ?? {}).length
const ms = (n?: number | null) => n == null ? '—' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`
/** A call's request in one line — what was asked of the program. */
const oneLine = (v: unknown) => v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v)

/**
 * One inspector round-trip, with loading/error state and a manual reload. Re-runs when `key` changes.
 *
 * The payload is STAMPED with the key it was fetched for, and we hand back data only when that stamp
 * still matches the key being asked for now. Without this, a caller that switches `view` while staying
 * mounted (the detail slide-over: program → call) briefly renders the PREVIOUS view's payload through
 * the new view's component — which is a crash, not a flicker, since the shapes differ.
 *
 * Stamping (rather than clearing on change) keeps a manual reload flicker-free: same key ⇒ the old
 * payload stays on screen until the new one lands.
 */
function useInspect(hub: Hub, view: string, args: Record<string, unknown>, key: string) {
  const [res, setRes] = useState<{ key: string; data: any }>({ key: '', data: null })
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)
  const live = hub.status === 'live'
  useEffect(() => {
    if (!live) return
    let dead = false
    setLoading(true); setErr('')
    hub.request(view, args)
      .then(r => { if (dead) return; r.error ? setErr(r.error) : setRes({ key, data: r }) })
      .catch(e => { if (!dead) setErr(e.message) })
      .finally(() => { if (!dead) setLoading(false) })
    return () => { dead = true }
    // `key` is the caller's explicit dependency string — `args` is a fresh object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, view, key, nonce])
  return { data: res.key === key ? res.data : null, err, loading, reload: useCallback(() => setNonce(n => n + 1), []) }
}

// What the slide-over is currently showing.
type Focus =
  | { kind: 'program'; name?: string; hash?: string }
  | { kind: 'call'; id: string }
  | { kind: 'session'; id: string }
  | { kind: 'file'; path: string }
  | null

const focusKey = (f: NonNullable<Focus>) =>
  f.kind === 'program' ? `program|${f.hash ?? f.name}` : f.kind === 'file' ? `file|${f.path}` : `${f.kind}|${f.id}`

// ── the shell ────────────────────────────────────────────────────────────────
export function Inspector({ hub, section }: { hub: Hub; section: Section }) {
  useCss()
  // A navigation STACK, not a single focus: opening a call FROM a program pushes on top, so closing the call
  // returns to the program, not all the way out. close() pops ONE level (back).
  const [stack, setStack] = useState<Focus[]>([])
  const focus = stack[stack.length - 1] ?? null
  const open = useCallback((f: Focus) => { if (f) setStack(s => [...s, f]) }, [])
  const close = useCallback(() => setStack(s => s.slice(0, -1)), [])

  // Changing section closes any open detail — otherwise you'd land on a stale panel.
  useEffect(() => { setStack([]) }, [section])

  if (hub.status !== 'live') {
    return <div className="card"><div className="empty">
      {hub.status === 'connecting' ? <span className="row" style={{ justifyContent: 'center' }}><span className="spin" />&nbsp;Connecting to the project hub…</span>
        : 'Hub disconnected — retrying.'}
    </div></div>
  }

  // A link to a section that no longer exists lands on the summary rather than a blank page.
  const Body = ({
    summary: SummaryView, programs: ProgramsView, calls: CallsView, sessions: SessionsView,
    grounding: GroundingView, index: IndexView, files: FilesView, db: DbView, logs: LogsView,
  } as Record<string, (p: ViewProps) => ReactElement>)[section] ?? SummaryView

  return (
    <div className="ins">
      {hub.waking && <div className="card" style={{ padding: '9px 13px', fontSize: 13 }}><span className="spin" /> Starting the engine machine — this takes a few seconds.</div>}
      <Body hub={hub} open={open} />
      {/* `key` remounts the panel per focus, so no state can survive a program → call switch. */}
      {focus && <DetailPanel key={focusKey(focus)} hub={hub} focus={focus} open={open} close={close} />}
    </div>
  )
}

type ViewProps = { hub: Hub; open: (f: Focus) => void }

// ── Summary ──────────────────────────────────────────────────────────────────
function SummaryView({ hub }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'overview', {}, 'overview')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const agents: Record<string, any> = data.runtime?.agents ?? {}
  const g = data.graph
  const gr = data.grounding ?? {}
  const tiles: [string, number | undefined, string?][] = g ? [
    ['Programs', g.programs], ['Names', g.names], ['Calls', g.calls, g.failedCalls ? `${g.failedCalls} failed` : undefined],
    ['Observations', g.observations], ['Data sessions', g.sessions], ['Steps', g.steps],
  ] : []
  return (
    <>
      <div className="bar"><div style={{ marginLeft: 'auto' }}><button className="btn sm ghost" onClick={reload}>Refresh</button></div></div>

      {data.graphError && <Err msg={`graph unavailable — ${data.graphError}`} />}
      {!!tiles.length && <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(132px,1fr))' }}>
        {tiles.map(([k, v, note]) => (
          <div className="tile" key={k}>
            <div className="k">{k}</div>
            <div className="v">{v ?? 0}{note && <span className="muted" style={{ fontSize: 13, fontWeight: 400, color: 'var(--bad)' }}> · {note}</span>}</div>
          </div>
        ))}
      </div>}

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <div className="card">
          <div className="sect">Agents</div>
          <table><tbody>
            {Object.entries(agents).map(([name, a]: any) => (
              <tr key={name} style={{ cursor: 'default' }}>
                <td style={{ fontWeight: 600, width: 92 }}>{name}</td>
                <td><span className="chip">{a.harness}{a.provider ? ` · ${a.provider}` : ''}:{a.model}</span></td>
                <td className="num muted">{a.busy ? 'busy' : 'idle'}</td>
              </tr>
            ))}
          </tbody></table>
          <div className="sect">Grounding</div>
          {gr.exists
            ? <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                <span className="chip">{gr.entityTypes} entity types</span><span className="chip">{Number(gr.values).toLocaleString()} values</span>
                <span className="chip">{gr.hierarchies} hierarchies</span><span className="chip">{gr.patterns} patterns</span>
              </div>
            : <div className="muted" style={{ fontSize: 13 }}>Not built yet.</div>}
          <div className="sect">Databases</div>
          <table><tbody>
            {(data.databases ?? []).map((d: any) => (
              <tr key={d.name} style={{ cursor: 'default' }}>
                <td style={{ fontWeight: 600 }}>{d.name}</td>
                <td className="num muted">{d.exists ? `${d.tables.length} tables · ${bytes(d.bytes)}` : 'missing'}</td>
              </tr>
            ))}
          </tbody></table>
        </div>

        <div className="card">
          <div className="sect">Data sources</div>
          {data.sourcesError
            ? <div className="muted" style={{ fontSize: 13 }}>datasource-manager unreachable — {data.sourcesError}</div>
            : data.sources.length === 0
              ? <div className="muted" style={{ fontSize: 13 }}>No sources registered.</div>
              : <table><tbody>{data.sources.map((s: any) => {
                  const ix = (data.index ?? []).find((i: any) => i.source === s.id)
                  return (
                    <tr key={s.id} style={{ cursor: 'default' }}>
                      <td style={{ fontWeight: 600 }}>{s.id}</td>
                      <td><span className="chip">{s.kind ?? '—'}{s.dialect ? ` · ${s.dialect}` : ''}</span></td>
                      <td className="num muted">{ix ? `${ix.containers} tables · ${ix.fields} fields` : 'not indexed'}</td>
                    </tr>
                  )
                })}</tbody></table>}
          <div className="sect">Paths on the machine</div>
          <dl className="kv">
            <dt>workspace</dt><dd><code className="mono">{data.roots.workspace}</code></dd>
            <dt>sessions</dt><dd><code className="mono">{data.roots.sessions}</code></dd>
            <dt>databases</dt><dd><code className="mono">{data.roots.db}</code></dd>
            <dt>datasources</dt><dd><code className="mono">{data.roots.datasourceUrl}</code></dd>
            <dt>uptime</dt><dd>{data.runtime?.uptimeMs ? `${Math.floor(data.runtime.uptimeMs / 60000)} min` : '—'}</dd>
          </dl>
        </div>
      </div>
    </>
  )
}

// ── Programs ─────────────────────────────────────────────────────────────────
function ProgramsView({ hub, open }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'programs', {}, 'programs')
  const [q, setQ] = useState('')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const all: any[] = data.programs ?? []
  const list = q ? all.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(q.toLowerCase())) : all
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Programs</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{all.length} named · what the agents' ./catalog sees</span>
        <input className="input search" placeholder="Filter…" value={q} onChange={e => setQ(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 240 }} />
        <button className="btn sm ghost" onClick={reload}>Refresh</button>
      </div>
      {!list.length && <div className="empty">{all.length ? 'Nothing matches that filter.' : 'No programs defined yet.'}</div>}
      {!!list.length && <table>
        <thead><tr><th>Program</th><th>Kind</th><th>Returns</th><th className="num">Measures</th><th className="num">Dimensions</th><th className="num">Versions</th><th>Defined by</th></tr></thead>
        <tbody>
          {list.map(p => (
            <tr key={p.name} onClick={() => open({ kind: 'program', name: p.name })}>
              <td style={{ minWidth: 220 }}>
                <strong>{p.name}</strong>
                {p.description && <span className="clamp" style={{ fontSize: 12.5, marginTop: 2 }}>{p.description}</span>}
              </td>
              <td><span className="chip">{p.kind}</span></td>
              <td><span className="chip">{p.returns}</span></td>
              <td className="num">{p.relation ? count(p.relation.measures) : <span className="muted">—</span>}</td>
              <td className="num">{p.relation ? count(p.relation.dimensions) : <span className="muted">—</span>}</td>
              <td className="num muted">{p.versions}</td>
              <td className="muted" style={{ fontSize: 12.5 }}>{p.definedBy ?? '—'} <span style={{ opacity: .7 }}>{when(p.definedAt)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>}
    </div>
  )
}

/** A table of slim calls — shared by the Calls view, a program's recent calls and a call's children. */
function CallTable({ calls, open, showName = true }: { calls: any[]; open: (f: Focus) => void; showName?: boolean }) {
  return (
    <table>
      <thead><tr><th style={{ width: 110 }}>When</th>{showName && <th>Program</th>}<th>Request</th><th className="num">ms</th><th className="num">Checks</th><th className="num">Queries</th><th>Result</th></tr></thead>
      <tbody>
        {calls.map((c: any) => (
          <tr key={c.id} onClick={() => open({ kind: 'call', id: c.id })}>
            <td className="num muted" style={{ fontSize: 12 }}>{when(c.at)}</td>
            {showName && <td><strong>{c.name}</strong>{c.parentId && <span className="chip" style={{ marginLeft: 6 }}>nested</span>}</td>}
            <td style={{ maxWidth: 320 }}><span className="trunc mono" style={{ fontSize: 11.5 }}>{oneLine(c.request)}</span></td>
            <td className="num muted">{c.ms ?? '—'}</td>
            <td className="num" style={{ color: c.failedVerifications ? 'var(--bad)' : undefined }} title={`${c.decisions} decisions · ${c.caveats} caveats`}>
              {c.verifications ? `${c.verifications - c.failedVerifications}/${c.verifications}` : <span className="muted">—</span>}
            </td>
            <td className="num muted">{c.queries}</td>
            <td>{c.error ? <span title={c.error}><Tag t="failed" /></span> : <Tag t="ok" />}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Calls (memory) ───────────────────────────────────────────────────────────
function CallsView({ hub, open }: ViewProps) {
  const [name, setName] = useState('')
  const [failed, setFailed] = useState(false)
  const [nested, setNested] = useState(false)
  const [page, setPage] = useState(0)
  const LIMIT = 100
  useEffect(() => setPage(0), [name, failed, nested])
  const { data, err, loading, reload } = useInspect(hub, 'calls', { name: name || undefined, failed, nested, limit: LIMIT, offset: page * LIMIT },
    `calls|${name}|${failed}|${nested}|${page}`)
  const programs = useInspect(hub, 'programs', {}, 'calls-programs')
  const names: string[] = (programs.data?.programs ?? []).map((p: any) => p.name)
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Calls</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{data ? `${data.total} ${failed ? 'failed' : ''}` : ''} · newest first</span>
        <label className="row muted" style={{ fontSize: 12.5, cursor: 'pointer', marginLeft: 'auto' }}>
          <input type="checkbox" checked={failed} onChange={e => setFailed(e.target.checked)} /> failed only
        </label>
        <label className="row muted" style={{ fontSize: 12.5, cursor: 'pointer' }}>
          <input type="checkbox" checked={nested} onChange={e => setNested(e.target.checked)} /> include nested
        </label>
        <button className="btn sm ghost" onClick={reload}>Refresh</button>
      </div>
      {!!names.length && <div className="axes" style={{ margin: '0 0 12px' }}>
        <span className={`chip${name ? ' link' : ''}`} onClick={() => setName('')}>all programs</span>
        {names.map(n => <span key={n} className={`chip${n === name ? '' : ' link'}`} style={n === name ? { background: '#e7e9ff' } : undefined}
          onClick={() => setName(n === name ? '' : n)}>{n}</span>)}
      </div>}
      {err && <Err msg={err} retry={reload} />}
      {!data && !err && <Loading on={loading} />}
      {data && !data.calls.length && <div className="empty">No calls{name || failed ? ' match these filters' : ' yet'}.</div>}
      {data && !!data.calls.length && <>
        <CallTable calls={data.calls} open={open} />
        {data.total > LIMIT && (
          <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
            <button className="btn sm ghost" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
            <span className="muted" style={{ fontSize: 12.5 }}>{page * LIMIT + 1}–{Math.min((page + 1) * LIMIT, data.total)} of {data.total}</span>
            <button className="btn sm ghost" disabled={(page + 1) * LIMIT >= data.total} onClick={() => setPage(p => p + 1)}>Next</button>
          </div>
        )}
      </>}
    </div>
  )
}

// ── Data sessions ────────────────────────────────────────────────────────────
function SessionsView({ hub, open }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'sessions', {}, 'sessions')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const list: any[] = data.sessions ?? []
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Data sessions</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{list.length} · each step is a message and the state it led to</span>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
      </div>
      {!list.length && <div className="empty">No data sessions yet.</div>}
      {!!list.length && <table>
        <thead><tr><th>Session</th><th>Who</th><th className="num">Steps</th><th className="num">Current</th><th className="num">Created</th><th className="num">Active</th></tr></thead>
        <tbody>
          {list.map(se => (
            <tr key={se.id} onClick={() => open({ kind: 'session', id: se.id })}>
              <td style={{ minWidth: 240 }}><strong>{se.title ?? 'Untitled'}</strong><code className="mono" style={{ display: 'block', fontSize: 11 }}>{se.id}</code></td>
              <td style={{ maxWidth: 200 }}><span className="trunc mono" style={{ fontSize: 11 }}>{se.who ? JSON.stringify(se.who) : '—'}</span></td>
              <td className="num">{se.steps}</td>
              <td className="num muted">{se.currentStep ?? '—'}</td>
              <td className="num muted">{when(se.createdAt)}</td>
              <td className="num muted">{when(se.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>}
    </div>
  )
}

// ── Datasource index ─────────────────────────────────────────────────────────
function IndexView({ hub }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'index', {}, 'index')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const list: any[] = data.sources ?? []
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Datasource index</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>what ./find-schema can find, per source</span>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
      </div>
      {!list.length && <div className="empty">Nothing indexed yet.</div>}
      {!!list.length && <table>
        <thead><tr><th>Source</th><th className="num">Tables</th><th className="num">Fields</th><th className="num">Disabled</th></tr></thead>
        <tbody>
          {list.map(s => (
            <tr key={s.source} style={{ cursor: 'default' }}>
              <td><strong>{s.source}</strong></td>
              <td className="num">{Number(s.containers).toLocaleString()}</td>
              <td className="num">{Number(s.fields).toLocaleString()}</td>
              <td className="num" style={{ color: s.disabled ? 'var(--bad)' : 'var(--sub)' }}>{s.disabled || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>}
    </div>
  )
}

// ── Logs (the engine's central log/error channel) ────────────────────────────
function LogsView({ hub }: ViewProps) {
  const [level, setLevel] = useState('')
  const { data, err, loading, reload } = useInspect(hub, 'logs', { level: level || undefined, limit: 400 }, `logs|${level}`)
  if (err) return <Err msg={err} retry={reload} />
  const entries: any[] = data?.entries ?? []
  const counts = data?.counts ?? { info: 0, warn: 0, error: 0 }
  const color = (l: string) => l === 'error' ? '#b02a37' : l === 'warn' ? '#8a5a00' : '#4340a0'
  const bg = (l: string) => l === 'error' ? '#fdeaea' : l === 'warn' ? '#fff3d6' : '#eef0ff'
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Logs</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>central error channel · <span style={{ color: color('error') }}>{counts.error} errors</span> · <span style={{ color: color('warn') }}>{counts.warn} warnings</span></span>
        <select className="input" value={level} onChange={e => setLevel(e.target.value)} style={{ fontSize: 13, padding: '5px 9px', marginLeft: 'auto' }}>
          <option value="">all levels</option>
          <option value="error">errors</option>
          <option value="warn">warnings</option>
          <option value="info">info</option>
        </select>
        <button className="btn sm ghost" onClick={reload}>Refresh</button>
      </div>
      {!data && <Loading on={loading} />}
      {data && !entries.length && <div className="empty">No {level || ''} log entries — the engine is quiet.</div>}
      {data && !!entries.length && <table>
        <thead><tr><th style={{ width: 150 }}>When</th><th style={{ width: 70 }}>Level</th><th style={{ width: 110 }}>Scope</th><th>Message</th></tr></thead>
        <tbody>
          {entries.map((e: any, i: number) => (
            <tr key={i} style={{ cursor: 'default' }}>
              <td className="num muted" style={{ fontSize: 12 }}>{new Date(e.at).toLocaleTimeString()} <span style={{ opacity: .6 }}>{when(e.at)}</span></td>
              <td><span className="tag" style={{ background: bg(e.level), color: color(e.level) }}>{e.level}</span></td>
              <td><span className="chip">{e.scope}</span></td>
              <td>{e.msg}{e.detail && <div className="mono" style={{ fontSize: 11, marginTop: 2, color: 'var(--sub)' }}>{e.detail}</div>}</td>
            </tr>
          ))}
        </tbody>
      </table>}
    </div>
  )
}

// ── Grounding (value→id resolution indexes) ──────────────────────────────────
function GroundingView({ hub }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'grounding', {}, 'grounding')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const entityTypes: any[] = data.entityTypes ?? []
  const hierarchies: any[] = data.hierarchies ?? []
  const patterns: any[] = data.patterns ?? []
  const totalValues = entityTypes.reduce((s, t) => s + Number(t.values ?? 0), 0)
  return (
    <>
      <div className="bar">
        <strong>Grounding</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {data.exists ? `${entityTypes.length} entity types · ${totalValues.toLocaleString()} indexed values · ${hierarchies.length} hierarchies · ${patterns.length} patterns` : 'value→id resolution built by the Grounding agent'}
        </span>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
      </div>

      {!data.exists && <div className="card"><div className="empty">No grounding indexes yet — run the <strong>Grounding</strong> agent to build them from this project’s data.</div></div>}

      {data.exists && <>
        {/* Entity types — resolvable names, with value-spelling + distinct-entity counts */}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
          {entityTypes.map((t: any) => (
            <div className="tile" key={t.type}>
              <div className="k">{t.type}</div>
              <div className="v">{Number(t.entities).toLocaleString()}</div>
              <div className="muted" style={{ fontSize: 11.5 }}>{Number(t.values).toLocaleString()} spellings</div>
            </div>
          ))}
        </div>

        {/* Hierarchies — how one level resolves to another; live = resolved against the source (never copied) */}
        <div className="card" style={{ padding: '14px 16px' }}>
          <div className="sect" style={{ marginTop: 0 }}>Hierarchies</div>
          {!hierarchies.length && <div className="empty">No hierarchies grounded.</div>}
          {!!hierarchies.length && <table>
            <thead><tr><th>Name</th><th>Relation</th><th>Mode</th><th>Join key / spec</th></tr></thead>
            <tbody>
              {hierarchies.map((h: any) => (
                <tr key={h.name} style={{ cursor: 'default' }}>
                  <td><strong>{h.name}</strong>{h.oneToMany && <span className="chip" style={{ marginLeft: 6 }}>1:many</span>}</td>
                  <td><span className="chip">{h.parentType}</span> <span className="muted">→</span> <span className="chip">{h.childType}</span></td>
                  <td><span className="tag" style={{ background: h.live ? '#e6f6ec' : '#fdeaea', color: h.live ? '#1a7f43' : '#b02a37' }}>{h.live ? 'live' : 'copied'}</span> <span className="muted" style={{ fontSize: 11.5 }}>{h.resolver}</span></td>
                  <td style={{ maxWidth: 380 }}><span className="trunc mono" style={{ fontSize: 11 }}>{JSON.stringify(h.spec)}{h.source ? ` @${h.source}` : ''}</span></td>
                </tr>
              ))}
            </tbody>
          </table>}
        </div>

        {/* Value patterns — type a bare id by its shape */}
        {!!patterns.length && <div className="card" style={{ padding: '14px 16px' }}>
          <div className="sect" style={{ marginTop: 0 }}>Value patterns</div>
          <table>
            <thead><tr><th>Name</th><th>Types as</th><th>Location</th><th>Regex</th><th className="num">Confidence</th></tr></thead>
            <tbody>
              {patterns.map((p: any) => (
                <tr key={p.name} style={{ cursor: 'default' }}>
                  <td><strong>{p.name}</strong></td>
                  <td><span className="chip">{p.entityType}</span></td>
                  <td style={{ maxWidth: 220 }}><span className="trunc mono" style={{ fontSize: 11 }}>{p.location}</span></td>
                  <td style={{ maxWidth: 240 }}><span className="trunc mono" style={{ fontSize: 11 }}>{p.regex}</span></td>
                  <td className="num muted">{p.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      </>}
    </>
  )
}

// ── Files (browse the engine's workspace) ────────────────────────────────────
function FilesView({ hub, open }: ViewProps) {
  const [path, setPath] = useState('')
  const { data, err, loading, reload } = useInspect(hub, 'dir', { path }, `dir|${path}`)
  const crumbs = useMemo(() => {
    const parts = path ? path.split('/') : []
    return [{ label: 'workspace', path: '' }, ...parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join('/') }))]
  }, [path])
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
          {crumbs.map((c, i) => (
            <span key={c.path} className="row" style={{ gap: 5 }}>
              {i > 0 && <span className="muted">/</span>}
              <span onClick={() => setPath(c.path)} style={{ cursor: 'pointer', color: i === crumbs.length - 1 ? 'var(--ink)' : 'var(--purple)', fontWeight: i === crumbs.length - 1 ? 600 : 500 }}>{c.label}</span>
            </span>
          ))}
        </div>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
      </div>
      {err && <Err msg={err} retry={reload} />}
      {!data && !err && <Loading on={loading} />}
      {data && <table>
        <thead><tr><th>Name</th><th className="num">Size</th><th className="num">Modified</th></tr></thead>
        <tbody>
          {path && <tr onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}><td colSpan={3} className="muted">↰ up</td></tr>}
          {(data.entries ?? []).map((e: any) => (
            <tr key={e.path} onClick={() => e.dir ? setPath(e.path) : open({ kind: 'file', path: e.path })}>
              <td>{e.dir ? '📁 ' : ''}<strong style={{ fontWeight: e.dir ? 600 : 500 }}>{e.name}</strong></td>
              <td className="num muted">{e.dir ? '—' : bytes(e.bytes)}</td>
              <td className="num muted">{when(e.modified)}</td>
            </tr>
          ))}
          {!(data.entries ?? []).length && <tr style={{ cursor: 'default' }}><td colSpan={3}><div className="empty">Empty directory.</div></td></tr>}
        </tbody>
      </table>}
    </div>
  )
}

// ── Database (raw table inventory) ───────────────────────────────────────────
function DbView({ hub }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'db', {}, 'db')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
      {(data.databases ?? []).map((d: any) => (
        <div className="card" key={d.name}>
          <div className="between"><strong>{d.name}</strong><span className="muted" style={{ fontSize: 12 }}>{d.exists ? bytes(d.bytes) : 'missing'}</span></div>
          <code className="mono" style={{ display: 'block', margin: '3px 0 9px', wordBreak: 'break-all' }}>{d.path}</code>
          <table><tbody>
            {d.tables.map((t: any) => (
              <tr key={t.name} style={{ cursor: 'default' }}><td>{t.name}</td><td className="num muted">{t.rows ?? '—'} rows</td></tr>
            ))}
          </tbody></table>
        </div>
      ))}
    </div>
  )
}

// ── the slide-over detail ────────────────────────────────────────────────────
function DetailPanel({ hub, focus, open, close }: { hub: Hub; focus: NonNullable<Focus>; open: (f: Focus) => void; close: () => void }) {
  // Esc closes — this panel overlays the whole page, so it needs a keyboard exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const args = focus.kind === 'program' ? (focus.hash ? { hash: focus.hash } : { name: focus.name })
    : focus.kind === 'file' ? { path: focus.path } : { id: focus.id }
  const { data, err, loading } = useInspect(hub, focus.kind, args, focusKey(focus))

  return (
    <div className="ins-over" onClick={close}>
      <div className="ins-panel" onClick={e => e.stopPropagation()}>
        {err && <><div className="ph"><strong>Error</strong><span className="x" onClick={close}>×</span></div><div className="pb"><Err msg={err} /></div></>}
        {!data && !err && <><div className="ph"><strong>Loading…</strong><span className="x" onClick={close}>×</span></div><div className="pb"><Loading on={loading} /></div></>}
        {data && focus.kind === 'program' && <ProgramDetail program={data.program} open={open} close={close} />}
        {data && focus.kind === 'call' && <CallDetail call={data.call} nested={data.children ?? []} open={open} close={close} />}
        {data && focus.kind === 'session' && <SessionDetail session={data.session} open={open} close={close} />}
        {data && focus.kind === 'file' && <FileDetail file={data} close={close} />}
      </div>
    </div>
  )
}

const Json = ({ v, max }: { v: unknown; max?: string }) =>
  <pre className="json" style={max ? { maxHeight: max } : undefined}>{JSON.stringify(v, null, 2)}</pre>
const Muted = ({ children }: { children: ReactNode }) =>
  <span className="muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{children}</span>

function ProgramDetail({ program: p, open, close }: { program: any; open: (f: Focus) => void; close: () => void }) {
  const shape = p.contract?.shape
  const measures = Object.entries(shape?.measures ?? {}) as [string, any][]
  const dimensions = Object.entries(shape?.dimensions ?? {}) as [string, any][]
  return (
    <>
      <div className="ph">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <span className="chip">{p.contract?.kind}</span><span className="chip">{p.contract?.returns}</span>
            <strong style={{ fontSize: 15 }}>{p.name}</strong><Tag t={p.current ? 'current' : 'superseded'} />
          </div>
          <code className="mono" style={{ display: 'block', marginTop: 3 }}>{p.hash}</code>
        </div>
        <span className="x" onClick={close}>×</span>
      </div>
      <div className="pb">
        {p.contract?.description && <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--sub)' }}>{p.contract.description}</p>}
        <dl className="kv">
          <dt>defined</dt><dd>{p.definedBy ?? '—'} · {p.definedAt ? new Date(p.definedAt).toLocaleString() : '—'}</dd>
          <dt>calls</dt><dd>{p.calls}</dd>
        </dl>

        {(measures.length > 0 || dimensions.length > 0) && <>
          <div className="sect">Relation shape</div>
          <table><thead><tr><th>Column</th><th>Role</th><th>Detail</th><th>Description</th></tr></thead><tbody>
            {measures.map(([m, v]) => (
              <tr key={`m${m}`} style={{ cursor: 'default' }}>
                <td><strong>{m}</strong></td><td><span className="chip">measure</span></td>
                <td className="mono" style={{ fontSize: 11.5 }}>{[v.unit, v.kind, v.how].filter(Boolean).join(' · ')}</td>
                <td className="muted" style={{ fontSize: 12.5 }}>{v.description ?? ''}</td>
              </tr>
            ))}
            {dimensions.map(([d, v]) => (
              <tr key={`d${d}`} style={{ cursor: 'default' }}>
                <td><strong>{d}</strong></td><td><span className="chip">dimension</span></td>
                <td className="mono" style={{ fontSize: 11.5 }}>{[v.entity, v.history, v.labelled ? 'labelled' : null].filter(Boolean).join(' · ')}</td>
                <td className="muted" style={{ fontSize: 12.5 }}>{v.description ?? ''}</td>
              </tr>
            ))}
          </tbody></table>
        </>}

        <div className="sect">Body <Muted>— {String(p.body ?? '').split('\n').length} lines, {bytes(String(p.body ?? '').length)}</Muted></div>
        <Code text={p.body} full />

        <div className="sect">Contract</div>
        <Json v={p.contract} />

        {!!p.history?.length && <>
          <div className="sect">Version history</div>
          <table><thead><tr><th>Version</th><th>From</th><th>To</th><th>By</th><th>Reason</th></tr></thead><tbody>
            {p.history.map((h: any) => (
              <tr key={`${h.hash}${h.from}`} onClick={() => h.hash !== p.hash && open({ kind: 'program', hash: h.hash })} style={h.hash === p.hash ? { cursor: 'default', background: '#f0f1ff' } : undefined}>
                <td><code className="mono" style={{ fontSize: 11 }}>{String(h.hash).slice(0, 12)}</code></td>
                <td className="muted" style={{ fontSize: 12 }}>{new Date(h.from).toLocaleString()}</td>
                <td className="muted" style={{ fontSize: 12 }}>{h.to ? new Date(h.to).toLocaleString() : 'now'}</td>
                <td>{h.by}</td>
                <td className="muted" style={{ fontSize: 12.5 }}>{h.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody></table>
        </>}

        <div className="sect">Recent calls <Muted>— {p.recentCalls?.length ?? 0} of {p.calls}</Muted></div>
        {p.recentCalls?.length ? <CallTable calls={p.recentCalls} open={open} showName={false} /> : <div className="muted" style={{ fontSize: 13 }}>Never called.</div>}
      </div>
    </>
  )
}

function CallDetail({ call: c, nested, open, close }: { call: any; nested: any[]; open: (f: Focus) => void; close: () => void }) {
  return (
    <>
      <div className="ph">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <strong style={{ fontSize: 15 }}>{c.name}</strong><Tag t={c.error ? 'failed' : 'ok'} />
            <span className="muted" style={{ fontSize: 12.5 }}>{ms(c.ms)} · {when(c.at)}</span>
          </div>
          <code className="mono" style={{ display: 'block', marginTop: 3 }}>{c.id}</code>
        </div>
        <span className="x" onClick={close}>×</span>
      </div>
      <div className="pb">
        <dl className="kv">
          <dt>program</dt><dd><span className="chip link" onClick={() => open({ kind: 'program', hash: c.hash })}>{c.name} · {String(c.hash).slice(0, 12)}</span></dd>
          {c.parentId && <><dt>called by</dt><dd><span className="chip link" onClick={() => open({ kind: 'call', id: c.parentId })}>{c.parentId}</span></dd></>}
          <dt>at</dt><dd>{new Date(c.at).toLocaleString()} · today = {c.today ?? '—'}</dd>
          <dt>who</dt><dd><code className="mono">{c.who ? JSON.stringify(c.who) : '—'}</code></dd>
        </dl>

        {c.error && <><div className="sect">Error</div><div className="card" style={{ borderColor: '#f3d0dc', background: '#fdeaee', color: 'var(--bad)', fontSize: 13, whiteSpace: 'pre-wrap' }}>{c.error}</div></>}

        <div className="sect">Request</div>
        <Json v={c.request} />

        {!!c.decisions?.length && <>
          <div className="sect">Decisions</div>
          <table><tbody>
            {c.decisions.map((d: any, i: number) => (
              <tr key={i} style={{ cursor: 'default' }}>
                <td style={{ width: 200 }}><strong>{d.label}</strong></td>
                <td><span className="chip">{oneLine(d.took)}</span>{d.boundary != null && <span className="muted" style={{ fontSize: 12 }}> · boundary {oneLine(d.boundary)}</span>}
                  {d.reason && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{d.reason}</div>}</td>
              </tr>
            ))}
          </tbody></table>
        </>}

        {!!c.verifications?.length && <>
          <div className="sect">Verifications</div>
          <ul style={{ margin: '4px 0 12px', paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
            {c.verifications.map((v: any, i: number) => (
              <li key={i} style={{ color: v.held ? 'var(--sub)' : '#b02a37' }}>
                {v.held ? '✓' : '✗'} {v.label}{v.detail ? <span className="muted"> — {oneLine(v.detail)}</span> : null}
              </li>
            ))}
          </ul>
        </>}

        {!!c.caveats?.length && <>
          <div className="sect">Caveats</div>
          <ul style={{ margin: '4px 0 12px', paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: '#8a5a00' }}>
            {c.caveats.map((t: string, i: number) => <li key={i}>{t}</li>)}
          </ul>
        </>}

        {!!c.queries?.length && <>
          <div className="sect">Queries <Muted>— {c.queries.length}</Muted></div>
          {c.queries.map((q: any, i: number) => (
            <div key={i} style={{ marginBottom: 12 }}>
              <div className="row" style={{ gap: 8, marginBottom: 5, fontSize: 12.5 }}>
                <span className="chip">{q.source}</span>
                <span className="muted">{q.rows ?? '—'} rows · {ms(q.ms)}</span>
                {q.params != null && count(q.params) > 0 && <span className="trunc mono muted" style={{ fontSize: 11, maxWidth: 420 }}>{JSON.stringify(q.params)}</span>}
              </div>
              {q.sql ? <Code text={q.sql} /> : <span className="muted" style={{ fontSize: 12.5 }}>SQL not kept for this call</span>}
            </div>
          ))}
        </>}

        <div className="sect">Output</div>
        <details><summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--purple)' }}>Show output</summary>
          <div style={{ marginTop: 8 }}><Json v={c.output} max="60vh" /></div></details>

        {!!nested.length && <>
          <div className="sect">Calls it made <Muted>— {nested.length}</Muted></div>
          <CallTable calls={nested} open={open} />
        </>}
      </div>
    </>
  )
}

function SessionDetail({ session: se, open, close }: { session: any; open: (f: Focus) => void; close: () => void }) {
  return (
    <>
      <div className="ph">
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 15 }}>{se.title ?? 'Untitled session'}</strong>
          <code className="mono" style={{ display: 'block', marginTop: 3 }}>{se.id}</code>
        </div>
        <span className="x" onClick={close}>×</span>
      </div>
      <div className="pb">
        <dl className="kv">
          <dt>who</dt><dd><code className="mono">{se.who ? JSON.stringify(se.who) : '—'}</code></dd>
          <dt>current step</dt><dd>{se.currentStep ?? '—'}</dd>
        </dl>
        {!se.steps?.length && <div className="empty">No steps yet.</div>}
        {(se.steps ?? []).map((t: any) => (
          <div key={t.id} className="facet" style={{ marginTop: 12, borderColor: t.id === se.currentStep ? 'var(--purple)' : undefined }}>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
              <strong>Step {t.id}</strong>
              {t.parent != null && <span className="muted" style={{ fontSize: 12 }}>after {t.parent}</span>}
              {t.program && <span className="chip">{t.program}</span>}
              <span className="muted" style={{ fontSize: 12 }}>{ms(t.ms)} · {when(t.at)}</span>
              {t.callId && <span className="chip link" style={{ marginLeft: 'auto' }} onClick={() => open({ kind: 'call', id: t.callId })}>call ↗</span>}
            </div>
            {(t.error || t.callError) && <div style={{ color: 'var(--bad)', fontSize: 13, marginTop: 8, whiteSpace: 'pre-wrap' }}>{t.error ?? t.callError}</div>}
            <div className="sect">Message</div>
            <Json v={t.message} max="30vh" />
            {!!t.narration?.length && <>
              <div className="sect">Narration</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>{t.narration.map((n: string, i: number) => <li key={i}>{n}</li>)}</ul>
            </>}
            {!!t.caveats?.length && <>
              <div className="sect">Caveats</div>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6, color: '#8a5a00' }}>{t.caveats.map((c: string, i: number) => <li key={i}>{c}</li>)}</ul>
            </>}
            <div className="sect">State <Muted>— {String(t.stateHash ?? '').slice(0, 12)}</Muted></div>
            <details><summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--purple)' }}>Show state</summary>
              <div style={{ marginTop: 8 }}><Json v={t.state} max="46vh" /></div></details>
          </div>
        ))}
      </div>
    </>
  )
}

function FileDetail({ file, close }: { file: any; close: () => void }) {
  return (
    <>
      <div className="ph">
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 15 }}>{file.path?.split('/').pop() ?? 'File'}</strong>
          <code className="mono" style={{ display: 'block', marginTop: 3, wordBreak: 'break-all' }}>{file.path}</code>
        </div>
        <span className="x" onClick={close}>×</span>
      </div>
      <div className="pb">
        <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>{bytes(file.bytes)} · modified {when(file.modified)}</div>
        {file.error ? <div className="empty">{file.error}</div> : <Code text={file.text} full />}
      </div>
    </>
  )
}

// ── small shared pieces ──────────────────────────────────────────────────────
function Code({ text, full }: { text: string; full?: boolean }) {
  const lines = (text ?? '').split('\n')
  const width = String(lines.length).length
  return (
    <code className="src" style={full ? { maxHeight: '76vh' } : undefined}>
      {lines.map((l, i) => (
        <div key={i}><span style={{ color: '#4d5560', userSelect: 'none' }}>{String(i + 1).padStart(width, ' ')}  </span>{l}</div>
      ))}
    </code>
  )
}
const Loading = ({ on }: { on: boolean }) =>
  <div className="empty">{on ? <span className="row" style={{ justifyContent: 'center' }}><span className="spin" />&nbsp;Asking the engine…</span> : 'No data.'}</div>
const Err = ({ msg, retry }: { msg: string; retry?: () => void }) => (
  <div className="card" style={{ borderColor: '#f3d0dc', background: '#fdeaee', color: 'var(--bad)', fontSize: 13 }}>
    <div className="between"><span>⚠ {msg}</span>{retry && <button className="btn sm ghost" onClick={retry}>Retry</button>}</div>
  </div>
)
