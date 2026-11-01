// THE INTENT GRAPH, as a page (docs/intent-graph.md) — drawn as the composition graph is: columns walked left to right.
// Every intent people asked (one list — no hierarchy is canonical), then what was asked next after the one selected, then
// what after that; beside them, what is selected: what it is, how it was first asked, who answers there, the project's
// way of answering it (approved, else the most represented — unverified) and every person's variant, its ways out, the
// answers given at it and its versions. A curator approves a variant here; who runs the project changes a node here.
// Beside it, the agents intent nodes are answered by: Superatom's own and the project's, and making one.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Section } from '../ui/Section'
import { Notice, Receipt, RecordList, Status, Code, Form, Field } from './index'
import { Columns, ColumnsSearch, type ColumnSpec, type ColumnItem } from './Columns'
import { Icon } from '../ui/Icon'
import { dateTime } from '../../lib/when'

/** What these views read and change, from what the platform keeps (the project's HTTP client, control-plane/shared/api,
 *  gives it): each call resolves with the platform's JSON — `{ error }` when refused. */
export interface IntentsApi { graph(): Promise<any>; node(id: string): Promise<any> }
/** Given only to someone who runs the project: a node changed. */
export interface IntentsAdminApi { write(id: string, body: unknown, why: string): Promise<any> }
/** Given only to a curator (project.curate): one person's variant approved as the project's way. */
export interface IntentsCuratorApi { approve(id: string, owner: string, version: number, why: string): Promise<any> }
export interface SessionAgentsApi { list(): Promise<any> }
/** Given only to someone who runs the project (the platform checks it on every call). */
export interface SessionAgentsAdminApi { save(spec: unknown): Promise<any>; remove(name: string): Promise<any> }

interface IndexNode { id: string; title: string; intent: string; canonical: string; concepts: string[]; agent: string | null; needs: string | null; system: string | null; stale: string | null; passages: number; by: string; at: string }
interface Edge { from: string; to: string; owner: string; tag: 'asked' | 'suggested'; count: number; label: string; check?: string | null; last: string }
interface Variant { owner: string; version: number; concepts: string[]; process: string; show: string; paths: { when: string; how: string }[]; by: string; at: string; why: string; deprecated?: boolean }
interface Passage { session: string; question: string; answer: string; who: string; agent: string; at: string; how: string }
interface NodeRead {
  node: IndexNode & { asked: string; version: number; params: { kind: string; value: string }[] }
  variants: Variant[]; approved: { owner: string; version: number; by: string; at: string } | null
  global: { variant: Variant | null; verified: boolean; agreeing: number; kinds: number }
  edges: Edge[]; versions: { version: number; by: string; why: string; at: string }[]; passages: Passage[]
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const whose = (owner: string) => owner.replace(/^user:/, '')

/** `admin`: given when the reader runs the project (nodes changed); `curator`: when they approve the project's way. */
export function IntentGraphView({ intents, admin, curator }: { intents: IntentsApi; admin?: IntentsAdminApi; curator?: IntentsCuratorApi }) {
  const [graph, setGraph] = useState<{ nodes: IndexNode[]; edges: Edge[] } | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)        // column 1
  const [next, setNext] = useState<string | null>(null)      // column 2
  const [then, setThen] = useState<string | null>(null)      // column 3
  const [focus, setFocus] = useState<string | null>(null)
  const load = useCallback(() => intents.graph().then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); setGraph({ nodes: r.nodes ?? [], edges: r.edges ?? [] }) } }).catch((e: any) => setErr(String(e?.message ?? e))), [intents])
  useEffect(() => { void load() }, [load])
  const by = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])

  if (err) return <Notice state="critical">{err}</Notice>
  const cols: [string, string, string][] = [['intents', 'Intents', 'lucide:message-square-text'], ['next', 'Next intents', 'lucide:arrow-right'], ['then', 'Then', 'lucide:arrow-right-to-line']]
  if (!graph) return (
    <div className="sa-graphpage">
      <ColumnsSearch value="" onChange={() => {}} placeholder="Search intents — titles, what they ask, how they were asked" />
      <Columns keep="intent-graph" columns={cols.map(([key, title, icon]) => ({ key, title, icon, items: [], onSelect: () => {}, loading: true }))}
        detail={<div className="sa-graphpage__hint"><Icon icon="lucide:loader" /><p>Reading the intent graph…</p></div>} />
    </div>
  )

  const needle = q.trim().toLowerCase()
  const hit = (n: IndexNode) => !needle || `${n.title} ${n.intent} ${n.canonical}`.toLowerCase().includes(needle)
  const item = (n: IndexNode, line?: string): ColumnItem => ({ key: n.id, title: n.title, line: line ?? [plural(n.passages, 'answer'), n.agent ? `the ${n.agent} agent` : ''].filter(Boolean).join(' · '),
    ...(n.stale ? { badge: { label: 'Stale', tone: 'warn' as const } } : n.system ? { badge: { label: 'Platform' } } : {}) })
  /** The ways out of a node, one row per next node: how often it was asked next, and whether an agent suggested it. */
  const after = (id: string | null): ColumnItem[] => {
    if (!id) return []
    const to = new Map<string, { asked: number; suggested: boolean }>()
    for (const e of graph.edges.filter((x) => x.from === id)) { const t = to.get(e.to) ?? { asked: 0, suggested: false }; if (e.tag === 'asked') t.asked += e.count; else t.suggested = true; to.set(e.to, t) }
    return [...to.entries()].sort((a, b) => b[1].asked - a[1].asked).flatMap(([k, t]) => { const n = by.get(k); return n ? [item(n, [t.asked ? `asked next ${t.asked}×` : '', t.suggested ? 'suggested' : ''].filter(Boolean).join(' · '))] : [] })
  }
  const columns: ColumnSpec[] = [
    { key: 'intents', title: 'Intents', icon: 'lucide:message-square-text', items: graph.nodes.filter(hit).map((n) => item(n)), selected: sel, focused: focus === sel,
      onSelect: (k) => { const again = sel === k; setSel(again ? null : k); setNext(null); setThen(null); setFocus(again ? null : k) }, empty: needle ? 'No intent matches.' : 'Every question asked here becomes an intent.' },
    { key: 'next', title: 'Next intents', icon: 'lucide:arrow-right', caption: sel ? `After ${by.get(sel)?.title ?? sel}` : undefined, items: after(sel), selected: next, focused: !!next && focus === next,
      onSelect: (k) => { setNext(k); setThen(null); setFocus(k) }, empty: sel ? 'Nothing asked after it yet.' : 'Select an intent to see what was asked after it.' },
    { key: 'then', title: 'Then', icon: 'lucide:arrow-right-to-line', caption: next ? `After ${by.get(next)?.title ?? next}` : undefined, items: after(next), selected: then, focused: !!then && focus === then,
      onSelect: (k) => { setThen(k); setFocus(k) }, empty: next ? 'Nothing asked after it yet.' : 'Select a next intent.' },
  ]
  const goTo = (id: string) => { setSel(id); setNext(null); setThen(null); setFocus(id) }
  return (
    <div className="sa-graphpage">
      <ColumnsSearch value={q} onChange={setQ} placeholder="Search intents — titles, what they ask, how they were asked" />
      <Columns keep="intent-graph" columns={columns} detail={focus
        ? <IntentDetail key={focus} id={focus} intents={intents} admin={admin} curator={curator} by={by} goTo={goTo} reload={load} />
        : <div className="sa-graphpage__hint"><Icon icon="lucide:mouse-pointer-click" /><p>Select an intent to see how it is answered — the project's way and each person's — and walk what was asked after it.</p>
            <Receipt items={[['Intents', String(graph.nodes.length)], ['Ways between them', String(new Set(graph.edges.map((e) => `${e.from}>${e.to}`)).size)], ['Answers', String(graph.nodes.reduce((a, n) => a + n.passages, 0))]]} /></div>} />
    </div>
  )
}

function VariantText({ v }: { v: Variant }) {
  return (
    <div className="sa-stack sa-stack--2">
      {v.process && <p className="sa-graphpage__text">{v.process}</p>}
      {v.paths.length > 0 && <ul className="sa-graphpage__order">{v.paths.map((p, i) => <li key={i}><span><strong>When {p.when}:</strong> {p.how}</span></li>)}</ul>}
      {v.show && <p className="sa-note">Shown: {v.show}</p>}
      {v.concepts.length > 0 && <div className="sa-words">{v.concepts.map((c) => <span key={c} className="sa-word"><Code>{c}</Code></span>)}</div>}
    </div>
  )
}

function IntentDetail({ id, intents, admin, curator, by, goTo, reload }: { id: string; intents: IntentsApi; admin?: IntentsAdminApi; curator?: IntentsCuratorApi; by: Map<string, IndexNode>; goTo: (id: string) => void; reload: () => Promise<void> }) {
  const [d, setD] = useState<NodeRead | null>(null)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<{ title: string; intent: string; agent: string; needs: string } | null>(null)
  const read = useCallback(() => intents.node(id).then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); setD(r) } }).catch((e: any) => setErr(String(e?.message ?? e))), [intents, id])
  useEffect(() => { void read() }, [read])
  const act = (p: Promise<any>, then?: () => void) => p.then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); then?.(); void read(); void reload() } }).catch((e: any) => setErr(String(e?.message ?? e)))
  if (!d) return <div className="sa-graphpage__detail">{err ? <Notice state="critical">{err}</Notice> : <span className="sa-faint">Reading…</span>}</div>
  const n = d.node, g = d.global
  const isApproved = (v: Variant) => d.approved?.owner === v.owner && d.approved?.version === v.version
  const live = d.variants.filter((v) => !v.deprecated)
  const latest = live.filter((v, i) => live.findIndex((x) => x.owner === v.owner) === i)
  return (
    <div className="sa-graphpage__detail">
      {err && <Notice state="critical">{err}</Notice>}
      <div className="sa-graphpage__head"><Icon icon="lucide:message-square-text" /><div><h2>{n.title}</h2><p className="sa-muted">{n.intent}</p></div>
        {admin && !editing && <button className="sa-btn sa-btn--link" onClick={() => setEditing({ title: n.title, intent: n.intent, agent: n.agent ?? '', needs: n.needs ?? '' })}><Icon icon="lucide:pencil" className="sa-btn__icon" />Change</button>}</div>
      {n.stale && <Notice state="attention">Stale — {n.stale}. Something its answers stand on changed since; look at it again.</Notice>}
      {editing && admin && (
        <Form onSubmit={() => void act(admin.write(id, { title: editing.title, intent: editing.intent, agent: editing.agent.trim() || null, needs: editing.needs.trim() || null }, 'changed in the console'), () => setEditing(null))}
          actions={<><button type="button" className="sa-btn" onClick={() => setEditing(null)}>Cancel</button><button className="sa-btn sa-btn--primary">Save</button></>}>
          <Field label="Title"><input className="sa-input" value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
          <Field label="What it asks for"><textarea className="sa-input" rows={3} value={editing.intent} onChange={(e) => setEditing({ ...editing, intent: e.target.value })} /></Field>
          <Field label="Answered by" help="An agent's name (builder, connector, one the project made); empty: the session's composer and analyst"><input className="sa-input" value={editing.agent} onChange={(e) => setEditing({ ...editing, agent: e.target.value })} /></Field>
          <Field label="Who may be answered here" help="A capability (project.develop …); empty: everyone in the project"><input className="sa-input" value={editing.needs} onChange={(e) => setEditing({ ...editing, needs: e.target.value })} /></Field>
        </Form>
      )}
      <Receipt items={[
        ['First asked', n.asked],
        ['Matched as', <Code key="c">{n.canonical}</Code>],
        ['Answered by', n.agent ? `the ${n.agent} agent` : 'the session\'s composer — the analyst when it is new to it'],
        ['Who may be answered here', n.needs ? <Code key="n">{n.needs}</Code> : 'everyone in the project'],
        ['Answers', String(n.passages)],
        ['Made', `${dateTime(n.at)} by ${n.by}`],
      ]} />
      <div className="sa-graphpage__block">
        <h3>The project's way</h3>
        {g.variant
          ? <><p className="sa-note">{g.verified ? (d.approved ? `Approved by ${d.approved.by} — ${whose(g.variant.owner)}'s way.` : 'Everyone answers it the same way.') : `Not approved yet: the most represented of ${plural(g.kinds, 'way')} (${plural(g.agreeing, 'person')}). A person with no way of their own starts from it.`}</p><VariantText v={g.variant} /></>
          : <p className="sa-note">Nothing learnt about answering it yet: what each person's conversations teach is kept when they move on from it.</p>}
      </div>
      <div className="sa-graphpage__block">
        <h3>Each person's way <span className="sa-col__count">{latest.length}</span></h3>
        {!latest.length ? <p className="sa-note">None yet.</p> : latest.map((v) => (
          <Section key={v.owner} icon="lucide:user" title={whose(v.owner)} subtitle={`version ${v.version} · ${dateTime(v.at)}`}
            actions={isApproved(v) ? <Status state="ok">approved</Status> : curator ? <button className="sa-btn sa-btn--link" onClick={() => void act(curator.approve(id, v.owner, v.version, 'approved in the console'))}>Approve as the project's way</button> : undefined}>
            <VariantText v={v} />
          </Section>
        ))}
      </div>
      <div className="sa-graphpage__block">
        <h3>Ways out</h3>
        <RecordList rows={d.edges} keyOf={(e) => `${e.to}|${e.owner}|${e.tag}`} empty="Nothing asked or suggested after it yet." columns={[
          { key: 'to', label: 'Next', render: (e) => <button type="button" className="sa-btn sa-btn--link" onClick={() => goTo(e.to)}>{by.get(e.to)?.title ?? e.to}</button> },
          { key: 'tag', label: 'How', render: (e) => <Status state={e.tag === 'asked' ? 'ok' : 'neutral'}>{e.tag === 'asked' ? `asked ${e.count}×` : 'suggested'}</Status> },
          { key: 'check', label: 'Check', render: (e) => <span className="sa-muted">{e.check ? 'when it makes sense' : 'always'}</span> },
          { key: 'owner', label: 'Whose', render: (e) => <span className="sa-muted">{whose(e.owner)}</span> },
        ]} />
      </div>
      <div className="sa-graphpage__block">
        <h3>Answers given here</h3>
        <RecordList search pageSize={10} rows={d.passages} keyOf={(p) => `${p.session}|${p.at}`} empty="Nothing answered here yet." columns={[
          { key: 'q', label: 'Asked', wrap: true, render: (p) => p.question },
          { key: 'a', label: 'Answered', wrap: true, render: (p) => <span className="sa-muted">{p.answer.replace(/:::[^\n]*\n?/g, '').replace(/\s+/g, ' ').slice(0, 240)}</span> },
          { key: 'by', label: 'By', render: (p) => <span className="sa-muted">{p.agent} · {p.who}</span> },
          { key: 'how', label: 'How', render: (p) => <Status state={p.how === 'made' ? 'attention' : 'ok'}>{p.how === 'made' ? 'new' : p.how === 'same' ? 'continued' : 'matched'}</Status> },
          { key: 'at', label: 'When', align: 'end', render: (p) => <span className="sa-muted">{dateTime(p.at)}</span> },
        ]} />
      </div>
      <div className="sa-graphpage__block">
        <h3>Versions</h3>
        <RecordList rows={d.versions} keyOf={(v) => String(v.version)} columns={[
          { key: 'v', label: 'Version', render: (v) => String(v.version) },
          { key: 'why', label: 'Why', wrap: true, render: (v) => v.why },
          { key: 'by', label: 'By', render: (v) => <span className="sa-muted">{v.by}</span> },
          { key: 'at', label: 'When', align: 'end', render: (v) => <span className="sa-muted">{dateTime(v.at)}</span> },
        ]} />
      </div>
    </div>
  )
}

interface AgentRow { name: string; title: string; description: string; needs: string; harness: string; builtin?: boolean; allowed: boolean; instructions?: string }

/** `admin`: given when the reader runs the project — then the project's own agents can be made and removed. */
export function SpecialistsView({ agents, admin }: { agents: SessionAgentsApi; admin?: SessionAgentsAdminApi }) {
  const [rows, setRows] = useState<AgentRow[] | null>(null)
  const [err, setErr] = useState('')
  const [form, setForm] = useState({ name: '', title: '', description: '', needs: 'project.ask', harness: 'claude-code', instructions: '' })
  const load = () => agents.list().then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); setRows(r.agents ?? []) } }).catch((e: any) => setErr(e.message))
  useEffect(() => { void load() }, [agents])   // eslint-disable-line react-hooks/exhaustive-deps
  const act = (done: Promise<any>, then?: () => void) => done.then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); then?.(); void load() } }).catch((e: any) => setErr(e.message))
  const complete = /^[a-z][a-z0-9-]{1,39}$/.test(form.name) && !!form.title.trim() && !!form.description.trim() && !!form.instructions.trim() && !!form.needs.trim()
  return (
    <div className="sa-stack sa-stack--4">
      {err && <Notice state="critical">{err}</Notice>}
      <Section icon="lucide:users" title="Intent nodes' agents" subtitle="An intent node answered by one of these is answered by it, for whoever holds what it needs — one per session, the same agent and folder every time in that session."
        note={rows ? `${rows.length}` : undefined}>
        <RecordList rows={rows} keyOf={(a) => a.name} empty="No agents." columns={[
          { key: 'name', label: 'Agent', render: (a) => <span className="sa-row sa-row--tight"><strong>{a.title}</strong><Code>{a.name}</Code></span> },
          { key: 'for', label: 'For', wrap: true, render: (a) => a.description },
          { key: 'by', label: 'Made by', render: (a) => <span className="sa-muted">{a.builtin ? 'Superatom' : 'this project'}</span> },
          { key: 'needs', label: 'Needs', render: (a) => <Code>{a.needs}</Code> },
          { key: 'you', label: 'You', render: (a) => <Status state={a.allowed ? 'ok' : 'neutral'}>{a.allowed ? 'may use' : 'not given'}</Status> },
          { key: 'rm', label: '', align: 'end', render: (a) => a.builtin || !admin ? null : <button type="button" className="sa-btn sa-btn--link" onClick={() => void act(admin.remove(a.name))}>Remove</button> },
        ]} />
      </Section>
      {admin && <Section icon="lucide:plus" title="Make an agent" subtitle="Given to everyone who holds what it needs; give it to an intent node to answer there">
        <Form onSubmit={() => { if (complete) void act(admin!.save(form), () => setForm({ name: '', title: '', description: '', needs: 'project.ask', harness: 'claude-code', instructions: '' })) }}
          actions={<button className="sa-btn sa-btn--primary" disabled={!complete}>Save</button>}>
          <Field label="Name" help="Lower case, letters, digits and -"><input className="sa-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} placeholder="report-writer" /></Field>
          <Field label="Title"><input className="sa-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Report writer" /></Field>
          <Field label="What it is for" help="Said to the people choosing it"><input className="sa-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Writes a formatted report when someone asks for one" /></Field>
          <Field label="Needs" help="The capability a person must hold to use it"><input className="sa-input" value={form.needs} onChange={(e) => setForm({ ...form, needs: e.target.value })} /></Field>
          <Field label="Runs on"><select className="sa-input" value={form.harness} onChange={(e) => setForm({ ...form, harness: e.target.value })}><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></Field>
          <Field label="Instructions" help="Its role, given to it at every turn"><textarea className="sa-input" rows={6} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></Field>
        </Form>
      </Section>}
    </div>
  )
}
