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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Section as Panel, RecordList, Receipt, Status, Empty, Notice, Code, Figures, Kpi, Tabs, Toolbar, Icon, ViewToggle, useView, type StatusState } from '@superatom/ui'
import type { Hub } from './hub'
import { VersionGraph, whoOf, when as publishedWhen, type Line, type DraftNode } from './GraphHistory'

export type Section =
  | 'summary' | 'composition' | 'changes' | 'questions' | 'sessions' | 'grounding' | 'files' | 'db' | 'logs'

// Grouped so the views read as a few coherent buckets, not one flat list.
export const SECTIONS: { id: Section; label: string; group?: string }[] = [
  { id: 'summary',   label: 'Summary' },
  { id: 'composition', label: 'Composition graph', group: 'Knowledge' },
  { id: 'changes',   label: 'Graph changes',    group: 'Knowledge' },
  { id: 'questions', label: 'Questions',        group: 'Knowledge' },
  { id: 'sessions',  label: 'Sessions',         group: 'Knowledge' },
  { id: 'grounding', label: 'Grounding',        group: 'Knowledge' },
  { id: 'files',     label: 'Files',            group: 'Storage' },
  { id: 'db',        label: 'Database',         group: 'Storage' },
  { id: 'logs',      label: 'Logs',             group: 'Storage' },
]
export const SECTION_LABEL = (s: Section) => SECTIONS.find(x => x.id === s)?.label ?? 'Inspector'

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
/** Rows keyed by their position, for lists whose records carry no id. */
const indexed = <T,>(rows: T[]) => rows.map((r, i) => ({ ...(r as any), _key: String(i) }))

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
  // A navigation STACK, not a single focus: opening a call FROM a program pushes on top, so closing the call
  // returns to the program, not all the way out. close() pops ONE level (back).
  const [stack, setStack] = useState<Focus[]>([])
  const focus = stack[stack.length - 1] ?? null
  const open = useCallback((f: Focus) => { if (f) setStack(s => [...s, f]) }, [])
  const close = useCallback(() => setStack(s => s.slice(0, -1)), [])

  // Changing section closes any open detail — otherwise you'd land on a stale panel.
  useEffect(() => { setStack([]) }, [section])

  if (hub.status !== 'live') {
    return hub.status === 'connecting'
      ? <Busy>Connecting to the project hub…</Busy>
      : <Notice state="attention">The hub is disconnected. Retrying.</Notice>
  }

  // A link to a section that no longer exists lands on the summary rather than a blank page.
  const Body = ({
    summary: SummaryView,
    grounding: GroundingView, files: FilesView, db: DbView, logs: LogsView,
    changes: ChangesView, questions: QuestionsView, sessions: SessionsView,
  } as Record<string, (p: ViewProps) => ReactElement>)[section] ?? SummaryView

  return (
    <div className="sa-stack sa-stack--4">
      {hub.waking && <Notice>Starting the engine machine. This takes a few seconds.</Notice>}
      {/* `key` remounts the panel per focus, so no state can survive a program → call switch. */}
      {focus && <DetailPanel key={focusKey(focus)} hub={hub} focus={focus} open={open} close={close} />}
      <Body hub={hub} open={open} />
    </div>
  )
}

type ViewProps = { hub: Hub; open: (f: Focus) => void }

// ── Summary ──────────────────────────────────────────────────────────────────
function SummaryView({ hub }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'overview', {}, 'overview')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const agents = Object.entries(data.runtime?.agents ?? {}).map(([name, a]: [string, any]) => ({ name, ...a }))
  const gr = data.grounding ?? {}
  const sources: any[] = data.sources ?? []
  return (
    <div className="sa-stack sa-stack--4">
      <Toolbar end={<Refresh onClick={reload} />} />
      <div className="sa-two-col">
        <Panel icon="lucide:bot" title="Agents" note={`${agents.length}`}>
          <RecordList rows={agents} keyOf={a => a.name} empty="No agents are running." columns={[
            { key: 'name', label: 'Agent', render: a => <>{a.name}{typeof a.sessions === 'number' && <div className="sa-note">{a.sessions} session{a.sessions === 1 ? '' : 's'} open</div>}</> },
            { key: 'model', label: 'Model', render: a => <Code>{a.harness}{a.provider ? ` · ${a.provider}` : ''}:{a.model}</Code> },
            { key: 'busy', label: 'State', align: 'end', render: a => <Status state={a.busy ? 'running' : 'neutral'}>{a.busy ? 'busy' : 'idle'}</Status> },
          ]} />
        </Panel>
        <Panel icon="lucide:plug" title="Data sources" note={data.sourcesError ? undefined : `${sources.length}`}>
          {data.sourcesError
            ? <div className="sa-section__body"><Notice state="critical">The datasource manager is unreachable: {data.sourcesError}</Notice></div>
            : <RecordList rows={sources} keyOf={s => s.id} empty="No sources registered." columns={[
                { key: 'id', label: 'Source' },
                { key: 'kind', label: 'Kind', render: s => <Code>{s.kind ?? '—'}{s.dialect ? ` · ${s.dialect}` : ''}</Code> },
                { key: 'index', label: 'Indexed', align: 'end', render: s => {
                  const ix = (data.index ?? []).find((i: any) => i.source === s.id)
                  return ix ? `${ix.containers} tables · ${ix.fields} fields` : <span className="sa-faint">not indexed</span>
                } },
              ]} />}
        </Panel>
        <Panel icon="lucide:map-pin" title="Grounding">
          {gr.exists
            ? <Receipt items={[
                ['Entity types', Number(gr.entityTypes).toLocaleString()], ['Values', Number(gr.values).toLocaleString()],
                ['Hierarchies', Number(gr.hierarchies).toLocaleString()], ['Patterns', Number(gr.patterns).toLocaleString()],
              ]} />
            : <Empty>Not built yet. Run the Grounding agent to build it.</Empty>}
        </Panel>
        <Panel icon="lucide:database" title="Databases">
          <RecordList rows={data.databases ?? []} keyOf={d => d.name} empty="No databases." columns={[
            { key: 'name', label: 'Database' },
            { key: 'tables', label: 'Tables', align: 'end', render: d => d.exists ? d.tables.length : <Status state="critical">missing</Status> },
            { key: 'bytes', label: 'Size', align: 'end', render: d => d.exists ? bytes(d.bytes) : '—' },
          ]} />
        </Panel>
        <Panel icon="lucide:hard-drive" title="Paths on the machine" className="sa-two-col__span">
          <Receipt items={[
            ['Workspace', <Code key="w">{data.roots.workspace}</Code>],
            ['Sessions', <Code key="s">{data.roots.sessions}</Code>],
            ['Databases', <Code key="d">{data.roots.db}</Code>],
            ['Data sources', <Code key="u">{data.roots.datasourceUrl}</Code>],
            ['Uptime', data.runtime?.uptimeMs ? `${Math.floor(data.runtime.uptimeMs / 60000)} min` : '—'],
          ]} />
        </Panel>
      </div>
    </div>
  )
}

// ── Composition graph (what each agent knows, and who changed it) ─────────────
// An explorer: a tab per agent, then the graph's changes, questions and sessions; within a tab, a node's content and
// history or an agent's whole system prompt opens in place, with a way back. Read-only: the graph is changed through
// its CLI, never here.
type CompPick =
  | { kind: 'node'; name: string }
  | { kind: 'prompt'; domain: string }

const short = (h?: string | null, n = 8) => (h ? String(h).slice(0, n) : '—')
const isoOf = (local: string) => (local ? new Date(local).toISOString() : undefined)
const HashMove = ({ from, to }: { from?: string | null; to?: string | null }) =>
  <span className="sa-row sa-row--tight"><Code>{short(from, 7)}</Code><Icon icon="lucide:arrow-right" /><Code>{to ? short(to, 7) : 'removed'}</Code></span>

// Defined once, outside any render: a component made inside a render is a new kind each time the page refreshes (every
// few seconds), so React would remount it and ask the engine again.
const ChangesView = (p: ViewProps) => <CompositionPart {...p} part="changes" />
const QuestionsView = (p: ViewProps) => <CompositionPart {...p} part="questions" />
/** Sessions made from the graph, with what moved since: from the engine, which holds the sessions' folders. */
const SessionsView = ({ hub }: ViewProps) => {
  const { data, err, loading, reload } = useInspect(hub, 'graphSessions', {}, 'graphSessions')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  return <div className="sa-stack sa-stack--4"><div className="sa-row"><div className="sa-grow" /><Refresh onClick={reload} /></div><CompSessions sessions={data.sessions ?? []} /></div>
}

/** The graph's history, its questions and its sessions — each a place of its own (the graph itself is its own page). */
function CompositionPart({ hub, part }: ViewProps & { part: 'changes' | 'questions' }) {
  const { data, err, loading, reload } = useInspect(hub, 'composition', {}, 'composition')
  const [pick, setPick] = useState<CompPick | null>(null)
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  if (data.exists === false) return <Notice>This project has no composition graph yet. Import the project's knowledge with <Code>sacli graph import knowledge/index.mts</Code>.</Notice>
  const domains: any[] = data.domains ?? []
  if (pick) return (
    <div className="sa-stack sa-stack--4">
      <div><button className="sa-btn sa-btn--link" onClick={() => setPick(null)}><Icon icon="lucide:chevron-left" className="sa-btn__icon" />Back</button></div>
      {pick.kind === 'node' && <CompNode hub={hub} name={pick.name} />}
      {pick.kind === 'prompt' && <CompPrompt hub={hub} domain={pick.domain} />}
    </div>
  )
  return (
    <div className="sa-stack sa-stack--4">
      <div className="sa-row"><div className="sa-grow" /><Refresh onClick={reload} /></div>
      {part === 'changes' && <CompChanges hub={hub} changes={data.changes ?? []} people={data.people ?? {}} go={setPick} />}
      {part === 'questions' && <CompQuestions domains={domains} />}
    </div>
  )
}

function CompAgent({ d, go }: { d: any; go: (p: CompPick) => void }) {
  if (!d) return <Empty>This agent is no longer in the graph.</Empty>
  const nodes = [
    ...(d.concepts ?? d.parts ?? []).map((p: any) => ({ name: p.name, label: p.title ?? p.name, what: `${p.form} · ${p.lines} lines`, hash: p.hash })),
    ...d.files.map((f: any) => ({ name: f.name, label: f.file ?? f.name, what: `program · ${bytes(f.bytes)}`, hash: f.hash })),
  ]
  return (
    <div className="sa-stack sa-stack--4">
      <Panel icon="lucide:bot" title={d.name} note={short(d.hash, 12)}
        actions={<button className="sa-btn" onClick={() => go({ kind: 'prompt', domain: d.name })}><Icon icon="lucide:scroll-text" className="sa-btn__icon" />System prompt</button>}>
        <Receipt items={[
          ...(d.description ? [['What it is', d.description] as [string, ReactNode]] : []),
          ['Tools', d.tools?.join(', ') || 'all'],
          ['Screens', d.capabilities.join(', ') || '—'],
          ...(d.intents?.length ? [['Phrases it serves', <span key="i" className="sa-words">{d.intents.map((t: string) => <span key={t} className="sa-word" title={t}>{t}</span>)}</span>] as [string, ReactNode]] : []),
        ]} />
      </Panel>
      <Panel icon="lucide:boxes" title="Concepts and programs" note={`${nodes.length}`}>
        <RecordList rows={nodes} keyOf={n => n.name} onRow={n => go({ kind: 'node', name: n.name })} empty="Nothing composed yet." columns={[
          { key: 'label', label: 'Node', wrap: true, render: n => <><div>{n.label}</div><div className="sa-note">{n.name}</div></> },
          { key: 'what', label: 'Form' },
          { key: 'hash', label: 'Version', align: 'end', render: n => <Code>{short(n.hash)}</Code> },
        ]} />
      </Panel>
      <Panel icon="lucide:message-circle-question" title="Questions it got" note={`${d.asked?.length ?? 0}`}>
        <CompAskedTable rows={d.asked ?? []} />
      </Panel>
    </div>
  )
}

function CompAskedTable({ rows, withAgent }: { rows: any[]; withAgent?: boolean }) {
  return (
    <RecordList rows={indexed(rows)} keyOf={q => q._key} empty="None yet." columns={[
      { key: 'at', label: 'When', render: q => <span className="sa-muted">{when(q.at)}</span> },
      { key: 'question', label: 'Question', wrap: true, render: q => <>{q.question}{q.decided?.length > 0 && <div className="sa-note">decided by: {q.decided.join(', ')}</div>}</> },
      ...(withAgent ? [{ key: 'agent', label: 'Agent' }] : []),
      { key: 'how', label: 'How', render: q => <Status state={q.how === 'routed' ? 'running' : 'neutral'}>{q.how === 'routed' ? 'routed' : 'in its chat'}</Status> },
    ]} />
  )
}

function CompQuestions({ domains }: { domains: any[] }) {
  const rows = domains.flatMap(d => (d.asked ?? []).map((q: any) => ({ ...q, agent: d.name }))).sort((a, b) => b.at - a.at)
  return (
    <Panel icon="lucide:message-circle-question" title="Questions" subtitle="Every question, the agent it went to, and whether its words routed it or it was asked in a chat already given an agent.">
      <CompAskedTable rows={rows} withAgent />
    </Panel>
  )
}

function CompChanges({ hub, changes, people, go }: { hub: Hub; changes: any[]; people: Record<string, string>; go: (p: CompPick) => void }) {
  const [view, setView] = useView<'list' | 'graph'>('graph-changes', ['list', 'graph'], 'list')
  return (
    <Panel icon="lucide:git-commit-horizontal" title="Changes" subtitle="Every edit to the graph: which node, from which version to which, by whom, why and from what."
      actions={<ViewToggle name="graph-changes" label="Show the changes as" value={view} onChange={setView} options={[{ value: 'list', icon: 'lucide:list', label: 'List' }, { value: 'graph', icon: 'lucide:git-branch', label: 'Graph' }]} />}>
      {view === 'graph' ? <ChangesGraph hub={hub} go={go} /> : <RecordList rows={changes} keyOf={c => String(c.id)} onRow={c => go({ kind: 'node', name: c.name })} empty="No changes yet." columns={[
        { key: 'at', label: 'When', render: c => <span className="sa-muted">{when(c.at)}</span> },
        { key: 'name', label: 'Node', wrap: true, render: c => <><div>{c.name}</div><div className="sa-note">{c.kind}</div></> },
        { key: 'version', label: 'Version', render: c => <HashMove from={c.fromHash} to={c.toHash} /> },
        { key: 'by', label: 'By · why · from', wrap: true, render: c => <><strong>{whoOf(c.by, people)}</strong>{c.reason ? ` · ${c.reason}` : ''}{c.from ? <span className="sa-muted"> · from {c.from}</span> : null}</> },
      ]} />}
    </Panel>
  )
}

/** The changes as the graph's versions: each published version on its line, the draft above; one picked shows what it touched. */
function ChangesGraph({ hub, go }: { hub: Hub; go: (p: CompPick) => void }) {
  const [data, setData] = useState<{ versions: Line[]; published: string | null; draft: DraftNode[]; people: Record<string, string> } | null>(null)
  const [err, setErr] = useState('')
  const [picked, setPicked] = useState<Line | 'draft' | null>(null)
  useEffect(() => { void hub.call({ t: 'graph:versions' }).then((r) => { if (r?.t === 'graph:reply') setData({ versions: r.versions ?? [], published: r.published ?? null, draft: r.draft ?? [], people: r.people ?? {} }); else setErr(r?.reason ?? 'The versions did not come') }).catch((e) => setErr(String(e?.message ?? e))) }, [hub])   // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <Notice state="critical">{err}</Notice>
  if (!data) return <Loading on />
  const names = picked === 'draft' ? data.draft.map((d) => d.name) : picked ? picked.names : []
  const who = (by: string) => whoOf(by, data.people)
  return (
    <div className="sa-section__body sa-stack sa-stack--4">
      <VersionGraph versions={data.versions} published={data.published} draft={data.draft} people={data.people} current={picked === 'draft' ? null : picked?.name ?? '\u0000none'}
        onPick={(v) => setPicked(v === null ? (picked === 'draft' ? null : 'draft') : picked !== 'draft' && picked?.name === v.name ? null : v)} />
      {picked && (
        <div className="sa-verdetail">
          <Receipt items={picked === 'draft'
            ? [['Version', 'The draft — not yet published'], ['Nodes that differ', String(data.draft.length)]]
            : [['Version', picked.name], ['What it is', picked.message], ['Published', `${publishedWhen(picked.at)} · ${who(picked.by)}`], ['Changes', String(picked.count)]]} />
          <h4 className="sa-label">Nodes it changed{picked !== 'draft' && picked.count > picked.names.length ? ` — the first ${picked.names.length}` : ''}</h4>
          <ul className="sa-verdetail__nodes">{names.map((n) => <li key={n}><button onClick={() => go({ kind: 'node', name: n })} title={n}>{n}</button></li>)}</ul>
        </div>
      )}
    </div>
  )
}

function CompSessions({ sessions }: { sessions: any[] }) {
  return (
    <Panel icon="lucide:messages-square" title="Sessions" subtitle="Each chat made from the graph, the agent it is, and which of its pieces have changed in the graph since it was made.">
      <RecordList rows={sessions} keyOf={x => String(x.id)} empty="No chat has been given an agent yet." columns={[
        { key: 'id', label: 'Chat', render: x => <Code>{String(x.id).slice(0, 8)}</Code> },
        { key: 'domain', label: 'Agent' },
        { key: 'at', label: 'Made', render: x => <span className="sa-muted">{x.at ? when(Date.parse(x.at)) : '—'}</span> },
        { key: 'moved', label: 'Changed since', wrap: true, render: x => !x.used ? <span className="sa-muted">made before versions were noted</span>
          : x.moved.length ? <><Status state="attention">{x.moved.length} changed</Status> {x.moved.join(', ')}</> : <Status state="ok">nothing</Status> },
      ]} />
    </Panel>
  )
}

function AsOf({ value, set }: { value: string; set: (v: string) => void }) {
  return (
    <Toolbar>
      <span className="sa-label">As of</span>
      <input className="sa-input sa-input--sm" type="datetime-local" aria-label="As of" value={value} onChange={e => set(e.target.value)} />
      {value ? <button className="sa-btn sa-btn--link" onClick={() => set('')}>Now</button> : <span className="sa-faint">now</span>}
    </Toolbar>
  )
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
    <div className="sa-stack sa-stack--4">
      <Panel icon={n?.kind === 'file' ? 'lucide:file-code' : 'lucide:file-text'} title={body?.title ?? body?.name ?? name} note={n ? short(n.hash, 12) : undefined}
        subtitle={`${name}${n ? ` · ${n.kind}${body?.form ? ` · ${body.form}` : ''}` : ''} · named by ${(data.usedBy ?? []).join(', ') || 'nothing'}`}>
        <div className="sa-section__body"><AsOf value={asOf} set={setAsOf} /></div>
        {!n ? <Empty>{asOf ? 'This node did not exist at that moment.' : 'This node has been removed.'}</Empty>
          : n.kind === 'file' ? <div className="sa-section__body"><SourceView text={text} /></div>
          : <div className="sa-section__text">{text}</div>}
      </Panel>
      <Panel icon="lucide:history" title="History" note={`${history.length}`}>
        <RecordList rows={history} keyOf={c => String(c.id)} empty="No history recorded." columns={[
          { key: 'at', label: 'When', render: c => <span className="sa-muted">{new Date(c.at).toLocaleString()}</span> },
          { key: 'version', label: 'Version', render: c => <HashMove from={c.fromHash} to={c.toHash} /> },
          { key: 'by', label: 'By' },
          { key: 'reason', label: 'Why · from', wrap: true, render: c => <>{c.reason ?? '—'}{c.from ? <span className="sa-muted"> · from {c.from}</span> : null}</> },
        ]} />
      </Panel>
    </div>
  )
}

function CompPrompt({ hub, domain }: { hub: Hub; domain: string }) {
  const [asOf, setAsOf] = useState('')
  const { data, err, loading, reload } = useInspect(hub, 'compositionCompose', { domain, asOf: isoOf(asOf) }, `ccompose|${domain}|${asOf}`)
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const used = (Object.entries(data.used ?? {}) as [string, string][]).map(([name, hash]) => ({ name, hash }))
  return (
    <div className="sa-stack sa-stack--4">
      <Panel icon="lucide:scroll-text" title={`${domain} · system prompt`}
        subtitle={`What this agent is given, ${bytes(data.bytes)}${data.tools ? `, plus the usage of: ${data.tools.join(', ')}` : ''}.`}>
        <div className="sa-section__body"><AsOf value={asOf} set={setAsOf} /></div>
        <div className="sa-section__text">{data.text}</div>
      </Panel>
      <Panel icon="lucide:layers" title="Composed from" note={`${used.length}`}>
        <RecordList rows={used} keyOf={u => u.name} columns={[
          { key: 'name', label: 'Node', wrap: true },
          { key: 'hash', label: 'Version', align: 'end', render: u => <Code>{short(u.hash, 10)}</Code> },
        ]} />
      </Panel>
    </div>
  )
}

// ── Logs (the engine's central log/error channel) ────────────────────────────
const LEVEL_STATE: Record<string, StatusState> = { error: 'critical', warn: 'attention', info: 'neutral' }

function LogsView({ hub }: ViewProps) {
  const [level, setLevel] = useState('')
  const { data, err, loading, reload } = useInspect(hub, 'logs', { level: level || undefined, limit: 400 }, `logs|${level}`)
  if (err) return <Err msg={err} retry={reload} />
  const entries: any[] = data?.entries ?? []
  const counts = data?.counts ?? { info: 0, warn: 0, error: 0 }
  return (
    <Panel icon="lucide:scroll-text" title="Logs" subtitle={`The engine's central error channel · ${counts.error} errors · ${counts.warn} warnings`}
      actions={<>
        <select className="sa-input sa-input--sm" aria-label="Level" value={level} onChange={e => setLevel(e.target.value)}>
          <option value="">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
        </select>
        <Refresh onClick={reload} />
      </>}>
      {!data ? <Loading on={loading} /> : (
        <RecordList rows={indexed(entries)} keyOf={e => e._key} empty={`No ${level || ''} log entries. The engine is quiet.`} columns={[
          { key: 'at', label: 'When', render: e => <>{new Date(e.at).toLocaleTimeString()} <span className="sa-faint">{when(e.at)}</span></> },
          { key: 'level', label: 'Level', render: e => <Status state={LEVEL_STATE[e.level] ?? 'neutral'}>{e.level}</Status> },
          { key: 'scope', label: 'Scope', render: e => <Code>{e.scope}</Code> },
          { key: 'msg', label: 'Message', wrap: true, render: e => <>{e.msg}{e.detail && <div className="sa-note"><Code>{e.detail}</Code></div>}</> },
        ]} />
      )}
    </Panel>
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
  if (!data.exists) return (
    <Panel icon="lucide:map-pin" title="Grounding" subtitle="Value→id resolution, built by the Grounding agent" actions={<Refresh onClick={reload} />}>
      <Empty>No grounding indexes yet. Run the Grounding agent to build them from this project’s data.</Empty>
    </Panel>
  )
  return (
    <div className="sa-stack sa-stack--4">
      <Toolbar end={<Refresh onClick={reload} />}>
        <span className="sa-muted">{`${entityTypes.length} entity types · ${totalValues.toLocaleString()} indexed values · ${hierarchies.length} hierarchies · ${patterns.length} patterns`}</span>
      </Toolbar>

      {/* Entity types — resolvable names, with value-spelling + distinct-entity counts */}
      {!!entityTypes.length && <Figures>
        {entityTypes.map((t: any) => <Kpi key={t.type} label={t.type} value={Number(t.entities).toLocaleString()} foot={`${Number(t.values).toLocaleString()} spellings`} />)}
      </Figures>}

      {/* Hierarchies — how one level resolves to another; live = resolved against the source (never copied) */}
      <Panel icon="lucide:network" title="Hierarchies" note={`${hierarchies.length}`}>
        <RecordList rows={hierarchies} keyOf={h => h.name} empty="No hierarchies grounded." columns={[
          { key: 'name', label: 'Name', render: h => <span className="sa-row sa-row--tight"><strong>{h.name}</strong>{h.oneToMany && <span className="sa-word">1:many</span>}</span> },
          { key: 'relation', label: 'Relation', render: h => <span className="sa-row sa-row--tight"><Code>{h.parentType}</Code><Icon icon="lucide:arrow-right" /><Code>{h.childType}</Code></span> },
          { key: 'mode', label: 'Mode', render: h => <span className="sa-row sa-row--tight"><Status state={h.live ? 'ok' : 'critical'}>{h.live ? 'live' : 'copied'}</Status><span className="sa-note">{h.resolver}</span></span> },
          { key: 'spec', label: 'Join key / spec', render: h => { const s = `${JSON.stringify(h.spec)}${h.source ? ` @${h.source}` : ''}`; return <Code title={s}>{s}</Code> } },
        ]} />
      </Panel>

      {/* Value patterns — type a bare id by its shape */}
      {!!patterns.length && <Panel icon="lucide:regex" title="Value patterns" note={`${patterns.length}`}>
        <RecordList rows={patterns} keyOf={p => p.name} columns={[
          { key: 'name', label: 'Name', render: p => <strong>{p.name}</strong> },
          { key: 'entityType', label: 'Types as', render: p => <Code>{p.entityType}</Code> },
          { key: 'location', label: 'Location', render: p => <Code title={p.location}>{p.location}</Code> },
          { key: 'regex', label: 'Regex', render: p => <Code title={p.regex}>{p.regex}</Code> },
          { key: 'confidence', label: 'Confidence', align: 'end' },
        ]} />
      </Panel>}
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
  const entries: any[] = data?.entries ?? []
  const rows = [...(path ? [{ path: '..', name: 'Up one level', up: true }] : []), ...entries]
  return (
    <Panel icon="lucide:folder-open" title="Files" subtitle={path || 'workspace'} actions={<Refresh onClick={reload} />}>
      <div className="sa-section__body">
        <nav className="sa-row sa-row--wrap sa-row--tight" aria-label="Path">
          {crumbs.map((c, i) => (
            <span key={c.path} className="sa-row sa-row--tight">
              {i > 0 && <span className="sa-faint">/</span>}
              {i === crumbs.length - 1 ? <strong>{c.label}</strong> : <button className="sa-btn sa-btn--link" onClick={() => setPath(c.path)}>{c.label}</button>}
            </span>
          ))}
        </nav>
      </div>
      {err && <div className="sa-section__body"><Err msg={err} retry={reload} /></div>}
      {!data && !err && <Loading on={loading} />}
      {data && <RecordList rows={rows} keyOf={e => e.path} empty="Empty directory."
        onRow={e => e.up ? setPath(path.split('/').slice(0, -1).join('/')) : e.dir ? setPath(e.path) : open({ kind: 'file', path: e.path })}
        columns={[
          { key: 'name', label: 'Name', render: e => <span className="sa-row sa-row--tight"><Icon icon={e.up ? 'lucide:corner-left-up' : e.dir ? 'lucide:folder' : 'lucide:file'} />{e.dir ? <strong>{e.name}</strong> : e.up ? <span className="sa-muted">{e.name}</span> : e.name}</span> },
          { key: 'bytes', label: 'Size', align: 'end', render: e => e.dir || e.up ? '—' : bytes(e.bytes) },
          { key: 'modified', label: 'Modified', align: 'end', render: e => e.up ? '—' : when(e.modified) },
        ]} />}
      {data && path && !entries.length && <Empty>Empty directory.</Empty>}
    </Panel>
  )
}

// ── Database (raw table inventory) ───────────────────────────────────────────
function DbView({ hub }: ViewProps) {
  const { data, err, loading, reload } = useInspect(hub, 'db', {}, 'db')
  if (err) return <Err msg={err} retry={reload} />
  if (!data) return <Loading on={loading} />
  const dbs: any[] = data.databases ?? []
  if (!dbs.length) return <Empty>No databases.</Empty>
  return (
    <div className="sa-two-col">
      {dbs.map((d: any) => (
        <Panel key={d.name} icon="lucide:database" title={d.name} note={d.exists ? bytes(d.bytes) : 'missing'}>
          <div className="sa-section__body"><Code>{d.path}</Code></div>
          <RecordList rows={d.tables} keyOf={t => t.name} empty="No tables." columns={[
            { key: 'name', label: 'Table' },
            { key: 'rows', label: 'Rows', align: 'end', render: t => t.rows == null ? '—' : Number(t.rows).toLocaleString() },
          ]} />
        </Panel>
      ))}
    </div>
  )
}

// ── the detail (a file, opened from the list) ────────────────────────────────
function DetailPanel({ hub, focus, close }: { hub: Hub; focus: NonNullable<Focus>; open: (f: Focus) => void; close: () => void }) {
  // Esc closes — the detail stands above the list, so it needs a keyboard exit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])
  // It opens above the list it was picked from: bring it into view.
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => { ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [])

  const args = { path: focus.path }
  const { data, err, loading } = useInspect(hub, focus.kind, args, focusKey(focus))
  const closer = <button className="sa-icon-btn" aria-label="Close" title="Close (Esc)" onClick={close}><Icon icon="lucide:x" /></button>

  return (
    <div ref={ref}>
      {err && <Panel icon="lucide:file-x" title="It could not be read" actions={closer}><div className="sa-section__body"><Err msg={err} /></div></Panel>}
      {!data && !err && <Panel icon="lucide:file" title={focus.path.split('/').pop() ?? 'File'} actions={closer}><Loading on={loading} /></Panel>}
      {data && focus.kind === 'file' && <FileDetail file={data} closer={closer} />}
    </div>
  )
}

function FileDetail({ file, closer }: { file: any; closer: ReactNode }) {
  return (
    <Panel icon="lucide:file-code" title={file.path?.split('/').pop() ?? 'File'} subtitle={file.path} note={`${bytes(file.bytes)} · modified ${when(file.modified)}`} actions={closer}>
      {file.error ? <div className="sa-section__body"><Notice state="critical">{file.error}</Notice></div> : <div className="sa-section__body"><SourceView text={file.text} numbered /></div>}
    </Panel>
  )
}

// ── small shared pieces ──────────────────────────────────────────────────────
/** A file or program read exactly: monospace, its own scroll, with line numbers when asked. */
function SourceView({ text, numbered }: { text: string; numbered?: boolean }) {
  const lines = (text ?? '').split('\n')
  const width = String(lines.length).length
  return (
    <div className="sa-prose sa-section__scroll--tall sa-scroll">
      <pre>{numbered
        ? lines.map((l, i) => <div key={i}><span className="sa-faint" aria-hidden>{String(i + 1).padStart(width, ' ')}  </span>{l}</div>)
        : text}</pre>
    </div>
  )
}
const Refresh = ({ onClick }: { onClick: () => void }) =>
  <button className="sa-icon-btn" aria-label="Refresh" title="Refresh" onClick={onClick}><Icon icon="lucide:refresh-cw" /></button>
const Busy = ({ children }: { children: ReactNode }) =>
  <p className="sa-empty"><span className="sa-spinner" /><span>{children}</span></p>
const Loading = ({ on }: { on: boolean }) =>
  on ? <Busy>Asking the engine…</Busy> : <Empty>No data.</Empty>
const Err = ({ msg, retry }: { msg: string; retry?: () => void }) =>
  <Notice state="critical" action={retry && <button className="sa-btn" onClick={retry}>Retry</button>}>{msg}</Notice>
