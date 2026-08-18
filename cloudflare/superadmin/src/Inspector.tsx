// ── INSPECTOR — the admin's read-only window into a project's engine ─────────
// The engine runs on a Fly VM with nothing listening, so everything here comes over the hub
// relay (admin → ProjectDO → code-engine) as `inspect:req` / `inspect:res`. See vm/apps/engine/inspect.ts.
//
// This replaces the old "Concept map", which was built for an architecture we no longer have
// (concepts + missing-units + lazy frontier). What actually exists now is a node-store graph with
// four live layers, and this shows each one honestly — including where they DISAGREE (a program on
// disk with no program node means the offline modeler hasn't consolidated it yet):
//
//   semantic model  concepts (a tree) → each bound to one parameterised unit
//   programs        one directory per answered question: program.ts + units/*.ts
//   intent graph    the conversation tree — position is context; each node may carry a program
//   basis space     the evolving typed-pair axis vocabulary the reflex locates questions in
//
// Every node that points at a file is inspectable down to its SOURCE, so you never need to SSH in.

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Hub } from './hub'

export type Section =
  | 'summary' | 'concepts' | 'atoms' | 'grounding' | 'basis' | 'programs' | 'units' | 'runs' | 'intents' | 'answers' | 'files' | 'db' | 'logs'

// Grouped so the 13 views read as a few coherent buckets, not one flat list.
export const SECTIONS: { id: Section; label: string; group?: string }[] = [
  { id: 'summary',  label: 'Summary' },
  { id: 'concepts', label: 'Semantic model', group: 'Knowledge' },
  { id: 'atoms',    label: 'Atoms',          group: 'Knowledge' },
  { id: 'grounding', label: 'Grounding',     group: 'Knowledge' },
  { id: 'basis',    label: 'Basis space',    group: 'Knowledge' },
  { id: 'programs', label: 'Programs',       group: 'Programs' },
  { id: 'units',    label: 'Units',          group: 'Programs' },
  { id: 'runs',     label: 'Runs',           group: 'Programs' },
  { id: 'intents',  label: 'Intent graph',   group: 'Questions' },
  { id: 'answers',  label: 'Questions',      group: 'Questions' },
  { id: 'files',    label: 'Files',          group: 'Storage' },
  { id: 'db',       label: 'Database',       group: 'Storage' },
  { id: 'logs',     label: 'Logs',           group: 'Storage' },
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
.ins .tree-i{display:inline-block;border-left:1px solid var(--line);height:14px;margin-right:8px;vertical-align:-2px}
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
  verified: 'var(--ok)', answered: 'var(--ok)', candidate: 'var(--warn)', blocked: 'var(--bad)',
  error: 'var(--bad)', cannot_answer: 'var(--bad)',
}
function Tag({ t }: { t?: string | null }) {
  if (!t) return null
  const c = STATUS_COLOR[t] ?? 'var(--sub)'
  return <span className="tag" style={{ background: `color-mix(in srgb, ${c} 13%, #fff)`, color: c }}>{t}</span>
}
/** Indentation for the tree views — cheap, and keeps the row a single table cell. */
const Indent = ({ depth }: { depth: number }) =>
  <>{Array.from({ length: depth }, (_, i) => <span key={i} className="tree-i" style={{ marginLeft: i ? 0 : 2 }} />)}</>

/**
 * One inspector round-trip, with loading/error state and a manual reload. Re-runs when `key` changes.
 *
 * The payload is STAMPED with the key it was fetched for, and we hand back data only when that stamp
 * still matches the key being asked for now. Without this, a caller that switches `view` while staying
 * mounted (the detail slide-over: program → file) briefly renders the PREVIOUS view's payload through
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
  | { kind: 'node'; id: string }
  | { kind: 'file'; path: string }
  | { kind: 'answer'; qid: string }
  | { kind: 'program'; dir: string }
  | null

// ── the shell ────────────────────────────────────────────────────────────────
export function Inspector({ hub, section }: { hub: Hub; section: Section }) {
  useCss()
  const [focus, setFocus] = useState<Focus>(null)
  const open = useCallback((f: Focus) => setFocus(f), [])

  // Changing section closes any open detail — otherwise you'd land on a stale panel.
  useEffect(() => { setFocus(null) }, [section])

  if (hub.status !== 'live') {
    return <div className="card"><div className="empty">
      {hub.status === 'connecting' ? <span className="row" style={{ justifyContent: 'center' }}><span className="spin" />&nbsp;Connecting to the project hub…</span>
        : 'Hub disconnected — retrying.'}
    </div></div>
  }

  const Body = {
    summary: SummaryView, concepts: ConceptsView, atoms: AtomsView, grounding: GroundingView, programs: ProgramsView, units: UnitsView,
    runs: RunsView, intents: IntentsView, basis: BasisView, answers: AnswersView, files: FilesView, db: DbView, logs: LogsView,
  }[section]

  return (
    <div className="ins">
      {hub.waking && <div className="card" style={{ padding: '9px 13px', fontSize: 13 }}><span className="spin" /> Starting the engine machine — this takes a few seconds.</div>}
      <Body hub={hub} open={open} />
      {/* `key` remounts the panel per focus, so no state can survive a program → file switch. */}
      {focus && <DetailPanel key={`${focus.kind}:${(focus as any).id ?? (focus as any).path ?? (focus as any).qid ?? (focus as any).dir}`}
        hub={hub} focus={focus} open={open} close={() => setFocus(null)} />}
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
  return (
    <>
      <div className="bar"><div style={{ marginLeft: 'auto' }}><button className="btn sm ghost" onClick={reload}>Refresh</button></div></div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(132px,1fr))' }}>
        {data.kinds.map((k: any) => (
          <div className="tile" key={k.kind}><div className="k">{k.kind}s</div><div className="v">{k.n}</div></div>
        ))}
        <div className="tile"><div className="k">Questions</div><div className="v">{data.questions.answered}<span className="muted" style={{ fontSize: 13, fontWeight: 400 }}> / {data.questions.total}</span></div></div>
        <div className="tile"><div className="k">To consolidate</div><div className="v">{data.consolidation.pending}</div></div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
        <div className="card">
          <div className="sect">Agents</div>
          <table><tbody>
            {Object.entries(agents).map(([name, a]: any) => (
              <tr key={name} style={{ cursor: 'default' }}>
                <td style={{ fontWeight: 600, width: 92 }}>{name}</td>
                <td><span className="chip">{a.harness}:{a.model}</span></td>
                <td className="num muted">{a.consolidating ? 'consolidating' : a.busy ? 'busy' : 'idle'}</td>
              </tr>
            ))}
          </tbody></table>
          <div className="sect">Edges</div>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {data.edges.map((e: any) => <span key={e.type} className="chip">{e.type} · {e.n}</span>)}
            {!data.edges.length && <span className="muted" style={{ fontSize: 13 }}>none yet</span>}
          </div>
        </div>

        <div className="card">
          <div className="sect">Data sources</div>
          {data.sourcesError
            ? <div className="muted" style={{ fontSize: 13 }}>datasource-manager unreachable — {data.sourcesError}</div>
            : data.sources.length === 0
              ? <div className="muted" style={{ fontSize: 13 }}>No sources registered.</div>
              : <table><tbody>{data.sources.map((s: any) => (
                  <tr key={s.id} style={{ cursor: 'default' }}>
                    <td style={{ fontWeight: 600 }}>{s.id}</td>
                    <td><span className="chip">{s.kind ?? '—'}{s.dialect ? ` · ${s.dialect}` : ''}</span></td>
                  </tr>
                ))}</tbody></table>}
          <div className="sect">Paths on the machine</div>
          <dl className="kv">
            <dt>workspace</dt><dd><code className="mono">{data.roots.workspace}</code></dd>
            <dt>data</dt><dd><code className="mono">{data.roots.dataRoot}</code></dd>
            <dt>datasources</dt><dd><code className="mono">{data.roots.datasourceUrl}</code></dd>
            <dt>uptime</dt><dd>{data.runtime?.uptimeMs ? `${Math.floor(data.runtime.uptimeMs / 60000)} min` : '—'}</dd>
          </dl>
        </div>
      </div>
    </>
  )
}

// ── Semantic model (concept tree) ────────────────────────────────────────────
function ConceptsView({ hub, open }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'concepts', {}, 'concepts')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const tree: any[] = data.tree ?? []
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Concepts</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{tree.length} under the model root · each bound to one parameterised unit</span>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
      </div>
      {!tree.length && <div className="empty">The semantic model is empty — the offline modeler builds it from finished analyses.</div>}
      {!!tree.length && <table>
        <thead><tr><th>Concept</th><th>Status</th><th>Grain</th><th>Unit</th><th className="num">Params</th><th className="num">Rules</th></tr></thead>
        <tbody>
          {tree.map(c => (
            <tr key={c.id} onClick={() => open({ kind: 'node', id: c.id })}>
              <td style={{ minWidth: 200 }}>
                <Indent depth={c.depth - 1} />
                <strong>{c.label}</strong>
                {c.summary && <span className="clamp" style={{ fontSize: 12.5, marginTop: 2 }}>{c.summary}</span>}
              </td>
              <td><Tag t={c.status} />{c.form === 'composite' && <span className="chip" style={{ marginLeft: 5 }}>composite</span>}</td>
              <td style={{ maxWidth: 280 }}><span className="clamp" style={{ fontSize: 12.5 }}>{c.grain ?? '—'}</span></td>
              <td>{c.unit ? <span className="chip link" onClick={e => { e.stopPropagation(); open({ kind: 'node', id: c.unit }) }}>{c.unit.replace(/^unit:/, '')}</span> : <span className="muted">—</span>}</td>
              <td className="num">{c.parameters?.length ?? 0}</td>
              <td className="num">{c.rules?.length ?? 0}</td>
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

// ── Runs (deterministic per-program run audit) ───────────────────────────────
function RunsView({ hub }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'runs', { limit: 300 }, 'runs')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const stats: any[] = data.stats ?? []
  const runs: any[] = data.runs ?? []
  return (
    <>
      <div className="bar">
        <strong>Runs</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{runs.length} recent executions · empty runs flag programs failing on new inputs</span>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
      </div>
      {!runs.length && <div className="card"><div className="empty">No program runs recorded yet.</div></div>}
      {!!stats.length && <div className="card" style={{ padding: '14px 16px' }}>
        <div className="sect" style={{ marginTop: 0 }}>Per program</div>
        <table>
          <thead><tr><th>Program</th><th className="num">Runs</th><th className="num">Empty</th><th className="num">Last</th></tr></thead>
          <tbody>
            {stats.map((s: any) => (
              <tr key={s.programDir} style={{ cursor: 'default' }}>
                <td><span className="mono" style={{ fontSize: 12 }}>{s.programDir.replace(/^programs\//, '')}</span></td>
                <td className="num">{s.runs}</td>
                <td className="num" style={{ color: s.empties ? 'var(--bad)' : 'var(--sub)' }}>{s.empties || 0}</td>
                <td className="num muted">{when(s.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      {!!runs.length && <div className="card" style={{ padding: '14px 16px' }}>
        <div className="sect" style={{ marginTop: 0 }}>Recent runs</div>
        <table>
          <thead><tr><th style={{ width: 130 }}>When</th><th>Program</th><th>Question</th><th className="num">ms</th><th>Result</th></tr></thead>
          <tbody>
            {runs.map((r: any) => (
              <tr key={r.id} style={{ cursor: 'default' }}>
                <td className="num muted" style={{ fontSize: 12 }}>{when(r.at)}</td>
                <td><span className="mono" style={{ fontSize: 11 }}>{r.programDir.replace(/^programs\//, '')}</span></td>
                <td style={{ maxWidth: 300 }}><span className="trunc" style={{ fontSize: 12.5 }}>{r.question ?? '—'}</span></td>
                <td className="num muted">{r.ms ?? '—'}</td>
                <td>{r.empty ? <span className="tag" style={{ background: '#fdeaea', color: '#b02a37' }}>empty</span> : <span className="tag" style={{ background: '#e6f6ec', color: '#1a7f43' }}>{r.status ?? 'ok'}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
    </>
  )
}

// ── Semantic atoms (learned where/how/quality facts) ─────────────────────────
const ATOM_KINDS = ['where-to-find', 'how-to-compute', 'how-to-join', 'resolution-method', 'data-quality']
function AtomsView({ hub }: ViewProps) {
  const [q, setQ] = useState(''); const [debounced, setDebounced] = useState('')
  const [kind, setKind] = useState('')
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t) }, [q])
  const { data, err, loading, reload } = useInspect(hub, 'atoms', { q: debounced, atomKind: kind || undefined }, `atoms|${debounced}|${kind}`)
  if (err) return <Err msg={err} retry={reload} />
  const list: any[] = data?.atoms ?? []
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Semantic atoms</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{data ? `${data.total} facts` : ''} · learned from real analyses (versioned on contradiction)</span>
        <select className="input" value={kind} onChange={e => setKind(e.target.value)} style={{ fontSize: 13, padding: '5px 9px', marginLeft: 'auto' }}>
          <option value="">all kinds</option>
          {ATOM_KINDS.map(k => <option key={k} value={k}>{k}{data?.byKind?.[k] ? ` (${data.byKind[k]})` : ''}</option>)}
        </select>
        <input className="input search" placeholder="Search atoms…" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 240 }} />
        <button className="btn sm ghost" onClick={reload}>Refresh</button>
      </div>
      {!data && <Loading on={loading} />}
      {data && !list.length && <div className="empty">No atoms{debounced || kind ? ' match' : ' yet'} — the modeler crystallizes them from finished analyses, and the analyst records data-quality facts it discovers.</div>}
      {data && !!list.length && <table>
        <thead><tr><th>Subject</th><th>Kind</th><th>Where / how</th><th className="num">Coverage</th><th className="num">Conf.</th><th>Evidence</th></tr></thead>
        <tbody>
          {list.map((a: any) => (
            <tr key={a.id} style={{ cursor: 'default' }}>
              <td><strong>{a.subject}</strong></td>
              <td><span className="tag" style={{ background: a.atomKind === 'data-quality' ? '#fff3d6' : '#eef0ff', color: a.atomKind === 'data-quality' ? '#8a5a00' : '#4340a0' }}>{a.atomKind}</span></td>
              <td style={{ maxWidth: 320 }}><span className="trunc mono" style={{ fontSize: 11 }}>{a.location || a.method || '—'}</span></td>
              <td className="num muted">{a.coverage != null ? `${Math.round(a.coverage * 100)}%` : '—'}</td>
              <td className="num muted">{a.confidence != null ? a.confidence : '—'}</td>
              <td style={{ maxWidth: 260 }}><span className="clamp" style={{ fontSize: 12 }}>{a.evidence || a.note || '—'}</span></td>
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

// ── Programs ─────────────────────────────────────────────────────────────────
function ProgramsView({ hub, open }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'programs', {}, 'programs')
  const [q, setQ] = useState('')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const all: any[] = data.programs ?? []
  const list = q ? all.filter(p => (p.slug + JSON.stringify(p.intents)).toLowerCase().includes(q.toLowerCase())) : all
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Programs</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{all.length} on the machine · one directory per answered question</span>
        <input className="input search" placeholder="Filter…" value={q} onChange={e => setQ(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 240 }} />
        <button className="btn sm ghost" onClick={reload}>Refresh</button>
      </div>
      {!list.length && <div className="empty">{all.length ? 'Nothing matches that filter.' : 'No programs built yet.'}</div>}
      {!!list.length && <table>
        <thead><tr><th>Program</th><th>Questions it answers</th><th className="num">Runs</th><th className="num">Files</th><th>Consolidated</th><th className="num">Changed</th></tr></thead>
        <tbody>
          {list.map(p => (
            <tr key={p.dir} onClick={() => open({ kind: 'program', dir: p.dir })}>
              <td style={{ minWidth: 180 }}>
                <strong>{p.slug}</strong>
                {!p.runnable && <span className="chip" style={{ marginLeft: 6, color: 'var(--bad)' }}>{p.missingOnDisk ? 'missing on disk' : 'no program.ts'}</span>}
              </td>
              <td style={{ maxWidth: 460 }}>
                {p.intents.length
                  ? p.intents.map((i: any) => <div key={i.id} className="trunc" style={{ fontSize: 12.5 }}>{i.question}</div>)
                  : <span className="muted">— not referenced by any intent</span>}
              </td>
              <td className="num muted">{p.runs ?? 0}{p.empties ? <span style={{ color: 'var(--bad)' }} title="runs that returned nothing"> · {p.empties} empty</span> : ''}</td>
              <td className="num">{p.files.length}</td>
              {/* A program node exists only once the offline modeler (System 4) has studied it. */}
              <td>{p.node ? <Tag t="verified" /> : <span className="muted" style={{ fontSize: 12.5 }}>pending</span>}</td>
              <td className="num muted">{when(p.modified)}</td>
            </tr>
          ))}
        </tbody>
      </table>}
    </div>
  )
}

// ── Units ────────────────────────────────────────────────────────────────────
function UnitsView({ hub, open }: ViewProps) {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t) }, [q])
  const { data, err, loading, reload } = useInspect(hub, 'nodes', { kind: 'unit', q: debounced, limit: 300 }, `unit|${debounced}`)
  if (err) return <Err msg={err} retry={reload} />
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Units</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{data ? `${data.total} in the graph` : ''} · the immutable computation layer</span>
        <input className="input search" placeholder="Search units…" value={q} onChange={e => setQ(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 280 }} />
        <button className="btn sm ghost" onClick={reload}>Refresh</button>
      </div>
      {!data && <Loading on={loading} />}
      {data && !data.nodes.length && <div className="empty">No units{debounced ? ' match that search' : ' yet'}.</div>}
      {data && !!data.nodes.length && <table>
        <thead><tr><th style={{ width: 210 }}>Unit</th><th>What it computes</th><th>Source</th></tr></thead>
        <tbody>
          {data.nodes.map((n: any) => (
            <tr key={n.id} onClick={() => open({ kind: 'node', id: n.id })}>
              <td><strong>{n.label}</strong></td>
              <td><span className="clamp">{n.summary ?? '—'}</span></td>
              <td style={{ maxWidth: 230 }}><span className="trunc mono" style={{ fontSize: 11 }}>{n.file ?? '—'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>}
    </div>
  )
}

// ── Intent graph ─────────────────────────────────────────────────────────────
function IntentsView({ hub, open }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'intents', {}, 'intents')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const list: any[] = data.intents ?? []
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Intent graph</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{list.length} nodes · indentation is the follow-up thread (position IS context)</span>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
      </div>
      {!list.length && <div className="empty">No questions asked yet.</div>}
      {!!list.length && <table>
        <thead><tr><th>Question</th><th>Category</th><th>Program</th><th>Params</th></tr></thead>
        <tbody>
          {list.map(n => (
            <tr key={n.id} onClick={() => open({ kind: 'node', id: n.id })}>
              <td style={{ minWidth: 280 }}>
                <Indent depth={n.depth} />
                <span style={{ fontWeight: n.depth ? 500 : 600 }}>{n.question}</span>
                {n.orphan && <span className="chip" style={{ marginLeft: 6 }}>orphan</span>}
              </td>
              <td><span className="chip">{n.category ?? '—'}</span></td>
              <td>{n.program
                ? <span className="chip link" onClick={e => { e.stopPropagation(); open({ kind: 'program', dir: n.program }) }}>{String(n.program).replace(/^programs\//, '')}</span>
                : <span className="muted" style={{ fontSize: 12.5 }}>none</span>}</td>
              <td style={{ maxWidth: 220 }}><span className="trunc mono" style={{ fontSize: 11 }}>{Object.keys(n.params ?? {}).length ? JSON.stringify(n.params) : '—'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>}
    </div>
  )
}

// ── Basis space ──────────────────────────────────────────────────────────────
function BasisView({ hub, open }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'basis', {}, 'basis')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const facets: any[] = data.facets ?? []
  return (
    <>
      <div className="bar">
        <strong>Basis space</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{facets.length} facets · axes the reflex locates questions on. Bold = actually used by an intent.</span>
        <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
      </div>
      {!facets.length && <div className="card"><div className="empty">The basis space is empty — it is seeded at engine boot and grows as questions are asked.</div></div>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))' }}>
        {facets.map(f => (
          <div className="facet" key={f.type}>
            <div className="between">
              <strong style={{ fontSize: 13.5 }}>{f.type}</strong>
              <span className="muted" style={{ fontSize: 11.5 }}>{f.plane ?? 'discovered'} · {f.axes.length} axes · {f.used} uses</span>
            </div>
            <div className="axes">
              {f.axes.map((a: any) => (
                <span key={a.id} className="chip link" onClick={() => open({ kind: 'node', id: a.id })}
                  style={{ fontWeight: a.used ? 700 : 400, opacity: a.used ? 1 : .62 }}
                  title={a.seed ? 'seeded vocabulary' : 'discovered from a question'}>
                  {a.token}{a.used ? ` · ${a.used}` : ''}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ── Questions (answers.sqlite) ───────────────────────────────────────────────
function AnswersView({ hub, open }: ViewProps) {
  const [q, setQ] = useState(''); const [debounced, setDebounced] = useState('')
  const [page, setPage] = useState(0)
  const LIMIT = 50
  useEffect(() => { const t = setTimeout(() => { setDebounced(q); setPage(0) }, 250); return () => clearTimeout(t) }, [q])
  const { data, err, loading, reload } = useInspect(hub, 'answers', { q: debounced, limit: LIMIT, offset: page * LIMIT }, `ans|${debounced}|${page}`)
  if (err) return <Err msg={err} retry={reload} />
  return (
    <div className="card" style={{ padding: '14px 16px' }}>
      <div className="bar" style={{ marginBottom: 10 }}>
        <strong>Questions</strong>
        <span className="muted" style={{ fontSize: 12.5 }}>{data ? `${data.total} asked` : ''} · engine-owned history</span>
        <input className="input search" placeholder="Search questions…" value={q} onChange={e => setQ(e.target.value)} style={{ marginLeft: 'auto', maxWidth: 280 }} />
        <button className="btn sm ghost" onClick={reload}>Refresh</button>
      </div>
      {!data && <Loading on={loading} />}
      {data && !data.answers.length && <div className="empty">No questions{debounced ? ' match that search' : ' yet'}.</div>}
      {data && !!data.answers.length && <>
        <table>
          <thead><tr><th>Question</th><th>Category</th><th>Status</th><th>Program</th><th className="num">Asked</th></tr></thead>
          <tbody>
            {data.answers.map((a: any) => (
              <tr key={a.qid} onClick={() => open({ kind: 'answer', qid: a.qid })}>
                <td style={{ minWidth: 300 }}><span className="trunc">{a.question}</span></td>
                <td><span className="chip">{a.category ?? '—'}</span></td>
                <td><Tag t={a.status} /></td>
                <td>{a.programDir
                  ? <span className="chip link" onClick={e => { e.stopPropagation(); open({ kind: 'program', dir: a.programDir }) }}>{a.programDir.replace(/^programs\//, '')}</span>
                  : <span className="muted" style={{ fontSize: 12.5 }}>—</span>}</td>
                <td className="num muted">{when(a.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

// ── Database (raw tables + a generic node browser) ───────────────────────────
function DbView({ hub, open }: ViewProps) {
  const { data, err, reload } = useInspect(hub, 'db', {}, 'db')
  const [kind, setKind] = useState('')
  const [q, setQ] = useState(''); const [debounced, setDebounced] = useState('')
  const [retired, setRetired] = useState(false)
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t) }, [q])
  const nodes = useInspect(hub, 'nodes', { kind: kind || undefined, q: debounced, includeRetired: retired, limit: 200 }, `db|${kind}|${debounced}|${retired}`)
  const kinds = useInspect(hub, 'overview', {}, 'db-kinds')

  return (
    <>
      {err ? <Err msg={err} retry={reload} /> : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(320px,1fr))' }}>
          {(data?.databases ?? []).map((d: any) => (
            <div className="card" key={d.name}>
              <div className="between"><strong>{d.name}</strong><span className="muted" style={{ fontSize: 12 }}>{bytes(d.bytes)}</span></div>
              <code className="mono" style={{ display: 'block', margin: '3px 0 9px', wordBreak: 'break-all' }}>{d.path}</code>
              <table><tbody>
                {d.tables.map((t: any) => (
                  <tr key={t.name} style={{ cursor: 'default' }}><td>{t.name}</td><td className="num muted">{t.rows ?? '—'} rows</td></tr>
                ))}
              </tbody></table>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: '14px 16px' }}>
        <div className="bar" style={{ marginBottom: 10 }}>
          <strong>Nodes</strong>
          <select className="input" value={kind} onChange={e => setKind(e.target.value)} style={{ fontSize: 13, padding: '5px 9px' }}>
            <option value="">all kinds</option>
            {(kinds.data?.kinds ?? []).map((k: any) => <option key={k.kind} value={k.kind}>{k.kind} ({k.n})</option>)}
          </select>
          <input className="input search" placeholder="Search id, label, summary, props…" value={q} onChange={e => setQ(e.target.value)} />
          <label className="row muted" style={{ fontSize: 12.5, cursor: 'pointer', marginLeft: 'auto' }}>
            <input type="checkbox" checked={retired} onChange={e => setRetired(e.target.checked)} /> include retired
          </label>
        </div>
        {nodes.err && <Err msg={nodes.err} retry={nodes.reload} />}
        {!nodes.data && !nodes.err && <Loading on={nodes.loading} />}
        {nodes.data && <>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>Showing {nodes.data.nodes.length} of {nodes.data.total}</div>
          <table>
            <thead><tr><th style={{ width: 90 }}>Kind</th><th style={{ width: 200 }}>Label</th><th>Summary</th><th>File</th></tr></thead>
            <tbody>
              {nodes.data.nodes.map((n: any) => (
                <tr key={n.id} onClick={() => open({ kind: 'node', id: n.id })}>
                  <td><span className="chip">{n.kind}</span></td>
                  <td><strong style={{ opacity: n.retired ? .5 : 1 }}>{n.label}</strong>{n.retired && <span className="chip" style={{ marginLeft: 5 }}>retired</span>}</td>
                  <td><span className="clamp">{n.summary ?? '—'}</span></td>
                  <td style={{ maxWidth: 200 }}><span className="trunc mono" style={{ fontSize: 11 }}>{n.file ?? '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>}
      </div>
    </>
  )
}

// ── the slide-over detail ────────────────────────────────────────────────────
function DetailPanel({ hub, focus, open, close }: { hub: Hub; focus: Focus; open: (f: Focus) => void; close: () => void }) {
  // Esc closes — this panel overlays the whole page, so it needs a keyboard exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const req = focus!.kind === 'node' ? { view: 'node', args: { id: (focus as any).id }, key: `node|${(focus as any).id}` }
    : focus!.kind === 'file' ? { view: 'file', args: { path: (focus as any).path }, key: `file|${(focus as any).path}` }
    : focus!.kind === 'answer' ? { view: 'answer', args: { qid: (focus as any).qid }, key: `ans|${(focus as any).qid}` }
    : { view: 'programs', args: {}, key: 'programs' }

  const { data, err, loading } = useInspect(hub, req.view, req.args, req.key)

  return (
    <div className="ins-over" onClick={close}>
      <div className="ins-panel" onClick={e => e.stopPropagation()}>
        {err && <><div className="ph"><strong>Error</strong><span className="x" onClick={close}>×</span></div><div className="pb"><Err msg={err} /></div></>}
        {!data && !err && <><div className="ph"><strong>Loading…</strong><span className="x" onClick={close}>×</span></div><div className="pb"><Loading on={loading} /></div></>}
        {data && focus!.kind === 'node' && <NodeDetail node={data.node} open={open} close={close} />}
        {data && focus!.kind === 'file' && <FileDetail file={data} close={close} />}
        {data && focus!.kind === 'answer' && <AnswerDetail answer={data.answer} open={open} close={close} />}
        {data && focus!.kind === 'program' && <ProgramDetail dir={(focus as any).dir} programs={data.programs ?? []} open={open} close={close} />}
      </div>
    </div>
  )
}

function NodeDetail({ node, open, close }: { node: any; open: (f: Focus) => void; close: () => void }) {
  const propEntries = Object.entries(node.props ?? {}) as [string, any][]
  // rawAnalysis is the agent's raw terminal exploration — megabytes of ANSI noise. Shown last, collapsed.
  const raw = node.props?.rawAnalysis
  return (
    <>
      <div className="ph">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}><span className="chip">{node.kind}</span><strong style={{ fontSize: 15 }}>{node.label}</strong><Tag t={node.status} /></div>
          <code className="mono" style={{ display: 'block', marginTop: 3 }}>{node.id}</code>
        </div>
        <span className="x" onClick={close}>×</span>
      </div>
      <div className="pb">
        {node.summary && <p style={{ margin: '0 0 14px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--sub)' }}>{node.summary}</p>}

        {(node.out.length > 0 || node.in.length > 0) && <>
          <div className="sect">Edges</div>
          <table><tbody>
            {node.out.map((e: any, i: number) => (
              <tr key={`o${i}`} onClick={() => open({ kind: 'node', id: e.id })}>
                <td style={{ width: 96 }}><span className="chip">{e.type} →</span></td>
                <td><strong>{e.label}</strong> <span className="muted mono" style={{ fontSize: 11 }}>{e.id}</span>
                  {!!Object.keys(e.props).length && <div className="mono" style={{ fontSize: 11, marginTop: 2 }}>{JSON.stringify(e.props)}</div>}</td>
              </tr>
            ))}
            {node.in.map((e: any, i: number) => (
              <tr key={`i${i}`} onClick={() => open({ kind: 'node', id: e.id })}>
                <td style={{ width: 96 }}><span className="chip">← {e.type}</span></td>
                <td><strong>{e.label}</strong> <span className="muted mono" style={{ fontSize: 11 }}>{e.id}</span></td>
              </tr>
            ))}
          </tbody></table>
        </>}

        {propEntries.length > 0 && <>
          <div className="sect">Properties</div>
          <dl className="kv">
            {propEntries.filter(([k]) => k !== 'rawAnalysis').map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd>{typeof v === 'string' ? v
                  : Array.isArray(v) || typeof v === 'object' ? <pre className="json">{JSON.stringify(v, null, 2)}</pre>
                  : String(v)}</dd>
              </div>
            ))}
          </dl>
        </>}

        {node.source && <>
          <div className="sect">Source · <code className="mono">{node.source.path}</code> {node.source.bytes != null && <span className="muted">({bytes(node.source.bytes)})</span>}</div>
          {node.source.error ? <div className="muted" style={{ fontSize: 13 }}>{node.source.error}</div> : <Code text={node.source.text} />}
        </>}

        {raw && <>
          <div className="sect">Raw analysis <span className="muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>— the agent's exploration that built this ({bytes(raw.length)})</span></div>
          <details><summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--purple)' }}>Show raw terminal output</summary>
            <code className="src" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{raw}</code></details>
        </>}
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

function AnswerDetail({ answer, open, close }: { answer: any; open: (f: Focus) => void; close: () => void }) {
  return (
    <>
      <div className="ph">
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 15 }}>{answer.question}</strong>
          <code className="mono" style={{ display: 'block', marginTop: 3 }}>{answer.qid}</code>
        </div>
        <span className="x" onClick={close}>×</span>
      </div>
      <div className="pb">
        <dl className="kv">
          <dt>status</dt><dd><Tag t={answer.status} /></dd>
          <dt>category</dt><dd>{answer.category ?? '—'}</dd>
          <dt>asked</dt><dd>{new Date(answer.createdAt).toLocaleString()}</dd>
          <dt>session</dt><dd><code className="mono">{answer.sessionId || '—'}</code></dd>
          <dt>program</dt><dd>{answer.programDir
            ? <span className="chip link" onClick={() => open({ kind: 'program', dir: answer.programDir })}>{answer.programDir}</span>
            : '—'}</dd>
          <dt>params</dt><dd><code className="mono">{answer.params ? JSON.stringify(answer.params) : '—'}</code></dd>
        </dl>
        <div className="sect">Answer</div>
        <pre className="json" style={{ maxHeight: '55vh' }}>{JSON.stringify(answer.answer, null, 2)}</pre>
      </div>
    </>
  )
}

function ProgramDetail({ dir, programs, open, close }: { dir: string; programs: any[]; open: (f: Focus) => void; close: () => void }) {
  const p = programs.find(x => x.dir === dir)
  if (!p) return <><div className="ph"><strong>{dir}</strong><span className="x" onClick={close}>×</span></div>
    <div className="pb"><div className="empty">That program is no longer on the machine.</div></div></>
  return (
    <>
      <div className="ph">
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 15 }}>{p.slug}</strong>
          <code className="mono" style={{ display: 'block', marginTop: 3 }}>{p.dir}</code>
        </div>
        <span className="x" onClick={close}>×</span>
      </div>
      <div className="pb">
        <dl className="kv">
          <dt>runnable</dt><dd>{p.runnable ? 'yes — program.ts present' : 'no program.ts on disk'}</dd>
          <dt>consolidated</dt><dd>{p.node ? <>yes — <span className="chip link" onClick={() => open({ kind: 'node', id: p.node.id })}>{p.node.id}</span></> : 'not yet — the offline modeler has not studied it'}</dd>
          <dt>changed</dt><dd>{when(p.modified)}</dd>
        </dl>

        {!!p.intents.length && <>
          <div className="sect">Questions it answers</div>
          <table><tbody>
            {p.intents.map((i: any) => (
              <tr key={i.id} onClick={() => open({ kind: 'node', id: i.id })}>
                <td>{i.question}<div className="mono" style={{ fontSize: 11, marginTop: 2 }}>{JSON.stringify(i.params)}</div></td>
                <td className="num"><span className="chip">{i.category ?? '—'}</span></td>
              </tr>
            ))}
          </tbody></table>
        </>}

        <div className="sect">Files</div>
        <table><tbody>
          {p.files.map((f: any) => (
            <tr key={f.path} onClick={() => open({ kind: 'file', path: f.path })}>
              <td><span className="mono" style={{ fontSize: 12 }}>{f.path.replace(p.dir + '/', '')}</span></td>
              <td className="num muted">{bytes(f.bytes)}</td>
              <td className="num muted">{when(f.modified)}</td>
            </tr>
          ))}
        </tbody></table>
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
