// ── INSPECTOR — the admin's read-only window into a project's engine ─────────
// The engine runs on a Fly VM with nothing listening, so everything here comes over the hub
// relay (admin → ProjectDO → code-engine) as `inspect:req` / `inspect:res`. See vm/apps/engine/inspect.ts.
//
// A read-only window into the project's stores:
//
//   composition     the composition graph: what each agent knows, how it was composed, who changed it
//   grounding       value→id resolution the grounding agent built
//   index           the fields each data source has, as ./find-schema searches them
//   files · db · logs   the agents' directories, the raw table inventory, the engine's log channel

import { useCallback, useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { Hub } from './hub'

export type Section =
  | 'summary' | 'composition' | 'grounding' | 'index' | 'files' | 'db' | 'logs'

// Grouped so the views read as a few coherent buckets, not one flat list.
export const SECTIONS: { id: Section; label: string; group?: string }[] = [
  { id: 'summary',   label: 'Summary' },
  { id: 'composition', label: 'Composition graph', group: 'Knowledge' },
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
  | { kind: 'file'; path: string }
  | null

const focusKey = (f: NonNullable<Focus>) => `file|${f.path}`

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
    summary: SummaryView,
    grounding: GroundingView, index: IndexView, files: FilesView, db: DbView, logs: LogsView, composition: CompositionView,
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
  const gr = data.grounding ?? {}
  const tiles: [string, number | undefined, string?][] = []
  return (
    <>
      <div className="bar"><div style={{ marginLeft: 'auto' }}><button className="btn sm ghost" onClick={reload}>Refresh</button></div></div>

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

// ── Composition graph (what each agent knows, and who changed it) ─────────────
// An explorer: on the left, a tree of agents with their sections and programs, then the graph's changes, questions and
// sessions; on the right, one pane for whatever is picked — an agent's overview, a node's content and history, an
// agent's whole system prompt, or a list. Read-only: the graph is changed through its CLI, never here.
type CompPick =
  | { kind: 'agent'; name: string }
  | { kind: 'node'; name: string }
  | { kind: 'prompt'; domain: string }
  | { kind: 'changes' } | { kind: 'questions' } | { kind: 'sessions' }

const COMP_CSS = `
.cg{display:grid;grid-template-columns:272px minmax(0,1fr);gap:12px;align-items:start}
.cg>*{min-width:0}
.cg .tree{padding:10px 8px}
.cg .tree .t-sec{font-size:10.5px;font-weight:700;color:var(--faint);text-transform:uppercase;letter-spacing:.05em;padding:10px 8px 4px}
.cg .tree .t-item{display:flex;align-items:center;gap:7px;width:100%;border:0;background:none;text-align:left;cursor:pointer;
 padding:6px 8px;border-radius:7px;font-size:13px;color:var(--ink);min-width:0}
.cg .tree .t-item:hover{background:#f4f5f9}
.cg .tree .t-item.on{background:#eef0ff;color:#3d3aa6;font-weight:600}
.cg .tree .t-item .t-txt{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.cg .tree .t-item .t-n{font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}
.cg .tree .t-child{padding-left:26px;font-size:12.5px;color:var(--sub)}
.cg .tree .t-caret{width:12px;color:var(--faint);font-size:10px;flex-shrink:0}
.cg .pane{padding:16px 18px;min-width:0}
.cg .pane h3{margin:0;font-size:16px}
.cg .pane .sub{color:var(--sub);font-size:12.5px;margin-top:3px}
.cg table{table-layout:fixed;width:100%}
.cg td,.cg th{overflow:hidden;text-overflow:ellipsis}
.cg td .wrap{white-space:normal;word-break:break-word}
.cg code.src{max-height:none;white-space:pre-wrap;word-break:break-word}
.cg .toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}
`
let compCss = false
function useCompCss() { useEffect(() => { if (compCss) return; compCss = true; const el = document.createElement('style'); el.textContent = COMP_CSS; document.head.appendChild(el) }, []) }

const short = (h?: string | null, n = 8) => (h ? String(h).slice(0, n) : '—')
const isoOf = (local: string) => (local ? new Date(local).toISOString() : undefined)
const HashMove = ({ from, to }: { from?: string | null; to?: string | null }) =>
  <span style={{ whiteSpace: 'nowrap' }}><span className="chip">{short(from, 7)}</span> → <span className="chip">{to ? short(to, 7) : 'removed'}</span></span>

function CompositionView({ hub }: ViewProps) {
  useCompCss()
  const { data, err, loading, reload } = useInspect(hub, 'composition', {}, 'composition')
  const [pick, setPick] = useState<CompPick | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  if (data.exists === false) return <div className="card"><div className="empty">This project has no composition graph yet. Import one with <code>composition-graph import knowledge/index.mts</code>.</div></div>
  const domains: any[] = data.domains ?? []
  const current: CompPick = pick ?? (domains[0] ? { kind: 'agent', name: domains[0].name } : { kind: 'changes' })
  const is = (p: CompPick) => JSON.stringify(p) === JSON.stringify(current)
  const questionsCount = domains.reduce((n, d) => n + (d.asked?.length ?? 0), 0)
  return (
    <div className="cg">
      <div className="card tree">
        <div className="bar" style={{ padding: '2px 8px 6px' }}>
          <strong style={{ fontSize: 13.5 }}>Composition graph</strong>
          <button className="btn sm ghost" style={{ marginLeft: 'auto' }} onClick={reload}>Refresh</button>
        </div>
        <div className="t-sec">Agents</div>
        {domains.map(d => {
          const expanded = open[d.name] ?? false
          return (
            <div key={d.name}>
              <button className={`t-item${is({ kind: 'agent', name: d.name }) ? ' on' : ''}`} onClick={() => { setPick({ kind: 'agent', name: d.name }); setOpen(o => ({ ...o, [d.name]: true })) }}>
                <span className="t-caret" onClick={e => { e.stopPropagation(); setOpen(o => ({ ...o, [d.name]: !expanded })) }}>{expanded ? '▾' : '▸'}</span>
                <span className="t-txt">{d.name}</span><span className="t-n">{d.asked?.length ?? 0}</span>
              </button>
              {expanded && <>
                <button className={`t-item t-child${is({ kind: 'prompt', domain: d.name }) ? ' on' : ''}`} onClick={() => setPick({ kind: 'prompt', domain: d.name })}><span className="t-txt">System prompt</span></button>
                {d.parts.map((p: any) => (
                  <button key={p.name} className={`t-item t-child${is({ kind: 'node', name: p.name }) ? ' on' : ''}`} onClick={() => setPick({ kind: 'node', name: p.name })} title={p.name}>
                    <span className="t-txt">{p.title ?? p.name}</span><span className="t-n">{p.lines}</span>
                  </button>))}
                {d.files.map((f: any) => (
                  <button key={f.name} className={`t-item t-child${is({ kind: 'node', name: f.name }) ? ' on' : ''}`} onClick={() => setPick({ kind: 'node', name: f.name })} title={f.name}>
                    <span className="t-txt">{f.file ?? f.name}</span><span className="t-n">program</span>
                  </button>))}
              </>}
            </div>)
        })}
        <div className="t-sec">Graph</div>
        <button className={`t-item${is({ kind: 'changes' }) ? ' on' : ''}`} onClick={() => setPick({ kind: 'changes' })}><span className="t-txt">Changes</span><span className="t-n">{data.changes?.length ?? 0}</span></button>
        <button className={`t-item${is({ kind: 'questions' }) ? ' on' : ''}`} onClick={() => setPick({ kind: 'questions' })}><span className="t-txt">Questions</span><span className="t-n">{questionsCount}</span></button>
        <button className={`t-item${is({ kind: 'sessions' }) ? ' on' : ''}`} onClick={() => setPick({ kind: 'sessions' })}><span className="t-txt">Sessions</span><span className="t-n">{data.sessions?.length ?? 0}</span></button>
      </div>
      <div className="card pane">
        {current.kind === 'agent' && <CompAgent d={domains.find(x => x.name === current.name)} go={setPick} />}
        {current.kind === 'node' && <CompNode hub={hub} name={current.name} />}
        {current.kind === 'prompt' && <CompPrompt hub={hub} domain={current.domain} />}
        {current.kind === 'changes' && <CompChanges changes={data.changes ?? []} go={setPick} />}
        {current.kind === 'questions' && <CompQuestions domains={domains} />}
        {current.kind === 'sessions' && <CompSessions sessions={data.sessions ?? []} />}
      </div>
    </div>
  )
}

function CompAgent({ d, go }: { d: any; go: (p: CompPick) => void }) {
  if (!d) return <div className="empty">This agent is no longer in the graph.</div>
  return (
    <div>
      <div className="bar"><h3>{d.name}</h3><span className="chip">{short(d.hash, 12)}</span>
        <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => go({ kind: 'prompt', domain: d.name })}>System prompt</button></div>
      {d.description && <div className="sub" style={{ fontSize: 13.5, color: 'var(--ink)', marginTop: 8 }}>{d.description}</div>}
      <dl className="kv" style={{ marginTop: 12 }}>
        <dt>Tools</dt><dd>{d.tools?.join(', ') || 'all'}</dd>
        <dt>Screens</dt><dd>{d.capabilities.join(', ')}</dd>
      </dl>
      {d.intents?.length > 0 && <><div className="sect">Phrases it serves</div><div className="axes" style={{ marginTop: 0 }}>{d.intents.map((t: string) => <span key={t} className="chip">{t}</span>)}</div></>}
      <div className="sect">Sections and programs</div>
      <table><colgroup><col /><col style={{ width: 150 }} /><col style={{ width: 110 }} /></colgroup><tbody>
        {d.parts.map((p: any) => (
          <tr key={p.name} onClick={() => go({ kind: 'node', name: p.name })}>
            <td><div className="wrap">{p.title ?? p.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{p.name}</div></td>
            <td className="muted">{p.form} · {p.lines} lines</td><td className="num"><span className="chip">{short(p.hash)}</span></td>
          </tr>))}
        {d.files.map((f: any) => (
          <tr key={f.name} onClick={() => go({ kind: 'node', name: f.name })}>
            <td><div className="wrap">{f.file ?? f.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{f.name}</div></td>
            <td className="muted">program · {bytes(f.bytes)}</td><td className="num"><span className="chip">{short(f.hash)}</span></td>
          </tr>))}
      </tbody></table>
      <div className="sect">Questions it got</div>
      {!d.asked?.length ? <div className="empty">None yet.</div> : <CompAskedTable rows={d.asked} />}
    </div>
  )
}

function CompAskedTable({ rows, withAgent }: { rows: any[]; withAgent?: boolean }) {
  return (
    <table><colgroup><col style={{ width: 92 }} /><col />{withAgent && <col style={{ width: 150 }} />}<col style={{ width: 96 }} /></colgroup>
      <thead><tr><th>When</th><th>Question</th>{withAgent && <th>Agent</th>}<th>How</th></tr></thead>
      <tbody>{rows.map((q: any, i: number) => (
        <tr key={i} style={{ cursor: 'default' }}>
          <td className="muted">{when(q.at)}</td>
          <td><div className="wrap">{q.question}</div>{q.decided?.length > 0 && <div className="muted" style={{ fontSize: 11.5 }}>decided by: {q.decided.join(', ')}</div>}</td>
          {withAgent && <td className="wrap">{q.agent}</td>}
          <td><span className="tag" style={{ background: q.how === 'routed' ? '#eef0ff' : '#f2f3f5', color: q.how === 'routed' ? '#4340a0' : 'var(--sub)' }}>{q.how === 'routed' ? 'routed' : 'in its chat'}</span></td>
        </tr>))}</tbody>
    </table>)
}

function CompQuestions({ domains }: { domains: any[] }) {
  const rows = domains.flatMap(d => (d.asked ?? []).map((q: any) => ({ ...q, agent: d.name }))).sort((a, b) => b.at - a.at)
  return (<div><h3>Questions</h3><div className="sub">Every question, the agent it went to, and whether its words routed it or it was asked in a chat already given an agent.</div>
    <div style={{ marginTop: 12 }}>{rows.length ? <CompAskedTable rows={rows} withAgent /> : <div className="empty">None yet.</div>}</div></div>)
}

function CompChanges({ changes, go }: { changes: any[]; go: (p: CompPick) => void }) {
  return (<div><h3>Changes</h3><div className="sub">Every edit to the graph: which node, from which version to which, by whom, why and from what.</div>
    <table style={{ marginTop: 12 }}><colgroup><col style={{ width: 92 }} /><col style={{ width: '32%' }} /><col style={{ width: 170 }} /><col /></colgroup>
      <thead><tr><th>When</th><th>Node</th><th>Version</th><th>By · why · from</th></tr></thead>
      <tbody>{changes.map(c => (
        <tr key={c.id} onClick={() => go({ kind: 'node', name: c.name })}>
          <td className="muted">{when(c.at)}</td>
          <td><div className="wrap">{c.name}</div><div className="muted" style={{ fontSize: 11.5 }}>{c.kind}</div></td>
          <td><HashMove from={c.fromHash} to={c.toHash} /></td>
          <td><div className="wrap"><strong style={{ fontWeight: 600 }}>{c.by}</strong>{c.reason ? ` · ${c.reason}` : ''}{c.from ? <span className="muted"> · from {c.from}</span> : null}</div></td>
        </tr>))}</tbody>
    </table></div>)
}

function CompSessions({ sessions }: { sessions: any[] }) {
  return (<div><h3>Sessions</h3><div className="sub">Each chat made from the graph, the agent it is, and which of its pieces have changed in the graph since it was made.</div>
    {!sessions.length ? <div className="empty">No chat has been given an agent yet.</div> :
      <table style={{ marginTop: 12 }}><colgroup><col style={{ width: 100 }} /><col style={{ width: 180 }} /><col style={{ width: 92 }} /><col /></colgroup>
        <thead><tr><th>Chat</th><th>Agent</th><th>Made</th><th>Changed since</th></tr></thead>
        <tbody>{sessions.map(x => (
          <tr key={x.id} style={{ cursor: 'default' }}>
            <td><span className="chip">{String(x.id).slice(0, 8)}</span></td><td className="wrap">{x.domain}</td>
            <td className="muted">{x.at ? when(Date.parse(x.at)) : '—'}</td>
            <td><div className="wrap">{!x.used ? <span className="muted">made before versions were noted</span> : x.moved.length ? <span style={{ color: 'var(--bad)' }}>{x.moved.join(', ')}</span> : <span style={{ color: 'var(--ok)' }}>nothing</span>}</div></td>
          </tr>))}</tbody>
      </table>}
  </div>)
}

function AsOf({ value, set }: { value: string; set: (v: string) => void }) {
  return (<div className="toolbar"><span className="muted" style={{ fontSize: 12.5 }}>As of</span>
    <input className="input" type="datetime-local" value={value} onChange={e => set(e.target.value)} style={{ fontSize: 13, padding: '4px 8px', width: 'auto' }} />
    {value ? <button className="btn sm ghost" onClick={() => set('')}>Now</button> : <span className="muted" style={{ fontSize: 12 }}>now</span>}</div>)
}

function CompNode({ hub, name }: { hub: Hub; name: string }) {
  const [asOf, setAsOf] = useState('')
  const { data, err, loading, reload } = useInspect(hub, 'compositionNode', { name, asOf: isoOf(asOf) }, `cnode|${name}|${asOf}`)
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const n = data.node, body = n?.body
  const text = !body ? '' : n.kind === 'file' ? String(body.text ?? '')
    : body.form === 'text' ? String(body.text ?? '')
    : body.form === 'worked' ? (body.items ?? []).map((e: any) => `## ${e.question}\n${(e.steps ?? []).map((st: string, i: number) => `${i + 1}. ${st}`).join('\n')}`).join('\n\n')
    : (body.items ?? []).map((l: string, i: number) => body.form === 'numbered' ? `${i + 1}. ${l}` : `- ${l}`).join('\n')
  const history: any[] = (data.history ?? []).slice().reverse()
  return (
    <div>
      <div className="bar"><h3 style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{body?.title ?? body?.name ?? name}</h3>{n && <span className="chip">{short(n.hash, 12)}</span>}</div>
      <div className="sub">{name}{n ? ` · ${n.kind}${body?.form ? ` · ${body.form}` : ''}` : ''} · named by {(data.usedBy ?? []).join(', ') || 'nothing'}</div>
      <AsOf value={asOf} set={setAsOf} />
      {!n ? <div className="empty">{asOf ? 'This node did not exist at that moment.' : 'This node has been removed.'}</div> : <code className="src">{text}</code>}
      <div className="sect">History</div>
      <table><colgroup><col style={{ width: 150 }} /><col style={{ width: 170 }} /><col style={{ width: 90 }} /><col /></colgroup>
        <thead><tr><th>When</th><th>Version</th><th>By</th><th>Why · from</th></tr></thead>
        <tbody>{history.map(c => (
          <tr key={c.id} style={{ cursor: 'default' }}>
            <td className="muted">{new Date(c.at).toLocaleString()}</td><td><HashMove from={c.fromHash} to={c.toHash} /></td>
            <td>{c.by}</td><td><div className="wrap">{c.reason ?? '—'}{c.from ? <span className="muted"> · from {c.from}</span> : null}</div></td>
          </tr>))}</tbody>
      </table>
    </div>
  )
}

function CompPrompt({ hub, domain }: { hub: Hub; domain: string }) {
  const [asOf, setAsOf] = useState('')
  const { data, err, loading, reload } = useInspect(hub, 'compositionCompose', { domain, asOf: isoOf(asOf) }, `ccompose|${domain}|${asOf}`)
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const used = Object.entries(data.used ?? {}) as [string, string][]
  return (
    <div>
      <div className="bar"><h3>{domain} · system prompt</h3></div>
      <div className="sub">What this agent is given, {bytes(data.bytes)}{data.tools ? `, plus the usage of: ${data.tools.join(', ')}` : ''}.</div>
      <AsOf value={asOf} set={setAsOf} />
      <code className="src">{data.text}</code>
      <div className="sect">Composed from</div>
      <table><colgroup><col /><col style={{ width: 120 }} /></colgroup><tbody>{used.map(([n, h]) => <tr key={n} style={{ cursor: 'default' }}><td className="wrap">{n}</td><td className="num"><span className="chip">{short(h, 10)}</span></td></tr>)}</tbody></table>
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

  const args = { path: focus.path }
  const { data, err, loading } = useInspect(hub, focus.kind, args, focusKey(focus))

  return (
    <div className="ins-over" onClick={close}>
      <div className="ins-panel" onClick={e => e.stopPropagation()}>
        {err && <><div className="ph"><strong>Error</strong><span className="x" onClick={close}>×</span></div><div className="pb"><Err msg={err} /></div></>}
        {!data && !err && <><div className="ph"><strong>Loading…</strong><span className="x" onClick={close}>×</span></div><div className="pb"><Loading on={loading} /></div></>}
        {data && focus.kind === 'file' && <FileDetail file={data} close={close} />}
      </div>
    </div>
  )
}

const Json = ({ v, max }: { v: unknown; max?: string }) =>
  <pre className="json" style={max ? { maxHeight: max } : undefined}>{JSON.stringify(v, null, 2)}</pre>
const Muted = ({ children }: { children: ReactNode }) =>
  <span className="muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>{children}</span>

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
