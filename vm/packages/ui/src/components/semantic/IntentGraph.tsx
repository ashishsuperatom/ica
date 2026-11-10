// THE INTENT GRAPH, as a page (docs/intent-graph.md) — a plain tree: every intent people asked (one list — no hierarchy is
// canonical), each opening to what was asked or suggested after it; beside it, in the same accordion as the composition
// graph's detail: what it is, how it was first asked, who answers there, the project's
// way of answering it (approved, else the most represented — unverified) and every person's variant, its ways out, the
// answers given at it and its versions. A curator approves a variant here; who runs the project changes a node here.
// Beside it, the agents intent nodes are answered by: Superatom's own and the project's, and making one.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Section } from '../ui/Section'
import { Notice, Receipt, RecordList, Status, Code, Form, Field } from './index'
import { ColumnsSearch } from './Columns'
import { Tree, type TreeRow } from './Tree'
import { Accordion, type AccItem } from './Accordion'
import { Icon } from '../ui/Icon'
import { dateTime } from '../../lib/when'

/** What these views read and change, from what the platform keeps (the project's HTTP client, control-plane/shared/api,
 *  gives it): each call resolves with the platform's JSON — `{ error }` when refused. */
export interface IntentsApi { graph(): Promise<any>; node(id: string): Promise<any> }
/** Given only to someone who runs the project: a node changed, removed (a new version, saying why) or restored. */
export interface IntentsAdminApi { write(id: string, body: unknown, why: string): Promise<any>; remove(id: string, why: string): Promise<any>; restore(id: string, why: string): Promise<any> }
/** Given only to a curator (project.curate): one person's variant approved as the project's way. */
export interface IntentsCuratorApi { approve(id: string, owner: string, version: number, why: string): Promise<any> }
export interface SessionAgentsApi { list(): Promise<any> }
/** Given only to someone who runs the project (the platform checks it on every call). */
export interface SessionAgentsAdminApi { save(spec: unknown): Promise<any>; remove(name: string): Promise<any> }

interface IndexNode { id: string; title: string; short?: string | null; category?: string | null; intent: string; canonical: string; concepts: string[]; agent: string | null; needs: string | null; system: string | null; stale: string | null; passages: number; by: string; at: string }
interface Edge { from: string; to: string; owner: string; tag: 'asked' | 'suggested'; kind?: 'interpolation' | 'extrapolation' | 'novelty' | null; count: number; label: string; check?: string | null; last: string; tried?: number; held?: number; retired?: string | null }
interface Variant { owner: string; version: number; concepts: string[]; process: string; show: string; paths: { when: string; how: string }[]; by: string; at: string; why: string; deprecated?: boolean }
interface Passage { session: string; question: string; answer: string; who: string; agent: string; at: string; how: string }
interface NodeRead {
  node: IndexNode & { asked: string; version: number; params: { kind: string; value: string }[]; removed?: { by: string; why: string; at: string } | null }
  variants: Variant[]; approved: { owner: string; version: number; by: string; at: string } | null
  global: { variant: Variant | null; verified: boolean; agreeing: number; kinds: number }
  edges: Edge[]; versions: { version: number; by: string; why: string; at: string }[]; passages: Passage[]
  /** What it has met, for the reader (their own): its signals, situations and latest cases. */
  experience?: { cases: number; signals: { name: string; purpose: string }[]; scenarios: { id: string; says: string; cases?: number; expectation: unknown }[]; recent: { seq: number; at: string; scenario: string | null; surprise?: { kind?: string; name?: string; why: string } | null }[] } | null
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const whose = (owner: string) => owner.replace(/^user:/, '')

/** `admin`: given when the reader runs the project (nodes changed); `curator`: when they approve the project's way. */
export function IntentGraphView({ intents, admin, curator }: { intents: IntentsApi; admin?: IntentsAdminApi; curator?: IntentsCuratorApi }) {
  const [graph, setGraph] = useState<{ nodes: IndexNode[]; edges: Edge[]; removed: { id: string; title: string; removed: { by: string; why: string; at: string } }[] } | null>(null)
  const [err, setErr] = useState('')
  const [q, setQ] = useState('')
  const [focus, setFocus] = useState<string | null>(null)
  const load = useCallback(() => intents.graph().then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); setGraph({ nodes: r.nodes ?? [], edges: r.edges ?? [], removed: r.removed ?? [] }) } }).catch((e: any) => setErr(String(e?.message ?? e))), [intents])
  useEffect(() => { void load() }, [load])
  const by = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph])

  if (err) return <Notice state="critical">{err}</Notice>
  const needle = q.trim().toLowerCase()
  const hit = (n: IndexNode) => !needle || `${n.title} ${n.short ?? ''} ${n.category ?? ''} ${n.intent} ${n.canonical}`.toLowerCase().includes(needle)
  /** The intents asked or suggested after one: most asked first; how often, or the kind it was suggested as. */
  const after = (id: string): { n: IndexNode; asked: number; kinds: string[] }[] => {
    const to = new Map<string, { asked: number; kinds: Set<string> }>()
    for (const e of graph?.edges.filter((x) => x.from === id) ?? []) { const t = to.get(e.to) ?? { asked: 0, kinds: new Set<string>() }; if (e.tag === 'asked') t.asked += e.count; else t.kinds.add(e.kind ?? 'suggested'); to.set(e.to, t) }
    return [...to.entries()].sort((a, b) => b[1].asked - a[1].asked).flatMap(([k, t]) => { const n = by.get(k); return n ? [{ n, asked: t.asked, kinds: [...t.kinds] }] : [] })
  }
  const row = (n: IndexNode, end: string, path: string[] = []): TreeRow => ({ key: n.id, title: n.short || n.title, end, open: after(n.id).length > 0, again: path.includes(n.id),
    ...(n.stale ? { badge: 'stale' } : n.system ? { badge: 'platform' } : {}) })
  // THE TREE: every intent people asked (and the platform's own), most answered first; each opens to what was asked or
  // suggested after it. A next intent only suggested, never asked, is seen under the intent it follows.
  const roots = (graph?.nodes ?? []).filter((n) => (n.passages > 0 || n.system) && hit(n)).sort((a, b) => b.passages - a.passages).map((n) => row(n, plural(n.passages, 'answer')))
  const under = (id: string, path: string[]) => after(id).map((x) => row(x.n, [x.asked ? `asked next ${x.asked}×` : '', x.kinds.join(', ')].filter(Boolean).join(' · '), path))
  return (
    <div className="sa-graphpage">
      <ColumnsSearch value={q} onChange={setQ} placeholder="Search intents — titles, what they ask, how they were asked" />
      <div className="sa-treepage">
        <div className="sa-treepage__tree">
          {!graph ? <p className="sa-muted">Reading the intent graph…</p>
            : <Tree rows={roots} under={under} selected={focus} onSelect={(k) => setFocus(k)} empty={needle ? 'No intent matches.' : 'Every question asked here becomes an intent.'} />}
        </div>
        <div className="sa-treepage__detail">
          {focus
            ? <IntentDetail key={focus} id={focus} intents={intents} admin={admin} curator={curator} by={by} goTo={setFocus} reload={load} />
            : graph && <div className="sa-graphpage__hint"><p>Choose an intent to see how it is answered — the project's way and each person's. Open it to see what was asked after it.</p>
                <Receipt items={[['Intents', String(graph.nodes.length)], ['Ways between them', String(new Set(graph.edges.map((e) => `${e.from}>${e.to}`)).size)], ['Answers', String(graph.nodes.reduce((a, n) => a + n.passages, 0))], ...(graph.removed.length ? [['Removed', String(graph.removed.length)] as [string, string]] : [])]} />
                {graph.removed.length > 0 && <div className="sa-words">{graph.removed.map((r) => <button key={r.id} type="button" className="sa-word sa-graphpage__link" title={`Removed by ${r.removed.by}: ${r.removed.why}`} onClick={() => setFocus(r.id)}>{r.title}</button>)}</div>}
              </div>}
        </div>
      </div>
    </div>
  )
}

function VariantText({ v }: { v: Variant }) {
  return <>
    {v.process && <p className="sa-graphpage__text">{v.process}</p>}
    {v.paths.length > 0 && <ul className="sa-graphpage__order">{v.paths.map((p, i) => <li key={i}><span><strong>When {p.when}:</strong> {p.how}</span></li>)}</ul>}
    {v.show && <p className="sa-note">Shown: {v.show}</p>}
    {v.concepts.length > 0 && <div className="sa-words">{v.concepts.map((c) => <span key={c} className="sa-word">{c}</span>)}</div>}
  </>
}

function IntentDetail({ id, intents, admin, curator, by, goTo, reload }: { id: string; intents: IntentsApi; admin?: IntentsAdminApi; curator?: IntentsCuratorApi; by: Map<string, IndexNode>; goTo: (id: string) => void; reload: () => Promise<void> }) {
  const [d, setD] = useState<NodeRead | null>(null)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState<{ title: string; intent: string; agent: string; needs: string } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const read = useCallback(() => intents.node(id).then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); setD(r) } }).catch((e: any) => setErr(String(e?.message ?? e))), [intents, id])
  useEffect(() => { void read() }, [read])
  const act = (p: Promise<any>, then?: () => void) => p.then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); then?.(); void read(); void reload() } }).catch((e: any) => setErr(String(e?.message ?? e)))
  if (!d) return <div className="sa-graphpage__detail">{err ? <Notice state="critical">{err}</Notice> : <div className="sa-graphpage__hint"><Icon icon="lucide:loader" /><p>Reading the intent…</p></div>}</div>
  const n = d.node, g = d.global
  const isApproved = (v: Variant) => d.approved?.owner === v.owner && d.approved?.version === v.version
  const live = d.variants.filter((v) => !v.deprecated)
  const latest = live.filter((v, i) => live.findIndex((x) => x.owner === v.owner) === i)
  const canChange = !!admin && !n.removed
  // ONE INTENT, AS A TREE: five branches, nothing open until chosen — each opens to its parts, and those to their detail.
  const met = d.experience
  const items: AccItem[] = [
    { key: 'what', icon: 'lucide:message-square-text', title: 'What it is',
      acts: canChange && !editing && removing === null ? <>
        <button className="sa-btn sa-btn--link" onClick={() => setEditing({ title: n.title, intent: n.intent, agent: n.agent ?? '', needs: n.needs ?? '' })}>Change</button>
        {!n.system && <button className="sa-btn sa-btn--link" onClick={() => setRemoving('')}>Remove</button>}
      </> : undefined,
      body: () => <>
        <p className="sa-graphpage__text">{n.intent}</p>
        <Receipt items={[
          ['First asked', n.asked],
          ['Matched as', <Code key="c">{n.canonical}</Code>],
          ['Category', n.category ? <Code key="k">{n.category}</Code> : '—'],
          ['Answered by', n.agent ? `the ${n.agent} agent` : 'the composer — the analyst when it is new to it'],
          ['Who may be answered here', n.needs ? <Code key="n">{n.needs}</Code> : 'everyone in the project'],
        ]} />
        {n.removed && <Notice state="attention">Removed by {n.removed.by}, {dateTime(n.removed.at)} — {n.removed.why}. It is never matched, offered or answered at; its history stays.
          {admin && <> <button className="sa-btn sa-btn--link" onClick={() => void act(admin.restore(id, 'restored in the console'))}>Restore</button></>}</Notice>}
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
        {removing !== null && admin && (
          <Form onSubmit={() => { if (removing.trim()) void act(admin.remove(id, removing.trim()), () => setRemoving(null)) }}
            actions={<><button type="button" className="sa-btn" onClick={() => setRemoving(null)}>Cancel</button><button className="sa-btn sa-btn--primary" disabled={!removing.trim()}>Remove</button></>}>
            <Field label="Why it is removed" help="Kept with its history; it is never matched, offered or answered at again, and can be restored"><input className="sa-input" value={removing} onChange={(e) => setRemoving(e.target.value)} placeholder="Two questions in one; asked as a count but answered as a list…" /></Field>
          </Form>
        )}
      </> },
    { key: 'answered', icon: 'lucide:route', title: 'How it\'s answered', tag: g.variant ? <span className="sa-col__badge" data-tone={g.verified ? 'neutral' : 'warn'}>{g.verified ? 'Approved' : 'Not approved'}</span> : undefined,
      body: () => g.variant ? <Accordion items={[
        { key: 'project', icon: 'lucide:building-2', title: 'The project\'s way', body: () => <><p className="sa-note">{g.verified ? (d.approved ? `Approved by ${d.approved.by} — ${whose(g.variant!.owner)}'s way.` : 'Everyone answers it the same way.') : `The most represented of ${plural(g.kinds, 'way')} — not approved yet.`}</p><VariantText v={g.variant!} /></> },
        { key: 'people', icon: 'lucide:users', title: 'Each person\'s way', n: latest.length, body: () => <Accordion items={latest.map((v): AccItem => ({ key: `v:${v.owner}`, icon: 'lucide:user', title: `${whose(v.owner)}'s way`, tag: isApproved(v) ? <span className="sa-col__badge">Approved</span> : undefined,
          acts: curator && !isApproved(v) ? <button className="sa-btn sa-btn--link" onClick={() => void act(curator.approve(id, v.owner, v.version, 'approved in the console'))}>Approve</button> : undefined,
          body: () => <><p className="sa-note">Version {v.version} · {dateTime(v.at)}</p><VariantText v={v} /></> }))} /> },
      ]} /> : <p className="sa-note">Nothing learnt about answering it yet.</p> },
    { key: 'met', icon: 'lucide:radar', title: 'What it has met', n: met?.cases ?? 0,
      body: () => !met || (!met.cases && !met.signals.length) ? <p className="sa-note">Nothing yet — what it meets is kept as it is answered.</p> : <Accordion items={[
        { key: 'scenarios', icon: 'lucide:git-branch', title: 'Situations', n: met.scenarios.length, body: () => <RecordList rows={met.scenarios} keyOf={(x) => x.id} empty="No situation told apart yet." columns={[
          { key: 'says', label: 'Situation', wrap: true, render: (x) => x.says },
          { key: 'cases', label: 'Cases', align: 'end', render: (x) => String(x.cases ?? 0) },
          { key: 'exp', label: 'Expected', wrap: true, render: (x) => <Code>{JSON.stringify(x.expectation)}</Code> },
        ]} /> },
        { key: 'signals', icon: 'lucide:activity', title: 'What it measures', n: met.signals.length, body: () => <RecordList rows={met.signals} keyOf={(x) => x.name} empty="Nothing measured yet." columns={[
          { key: 'name', label: 'Signal', render: (x) => <Code>{x.name}</Code> },
          { key: 'why', label: 'Why', wrap: true, render: (x) => x.purpose },
        ]} /> },
        { key: 'cases', icon: 'lucide:list', title: 'Cases', n: met.cases, body: () => <RecordList search pageSize={10} rows={[...met.recent].reverse()} keyOf={(x) => String(x.seq)} empty="No case kept yet." columns={[
          { key: 'at', label: 'When', render: (x) => <span className="sa-muted">{dateTime(x.at)}</span> },
          { key: 'in', label: 'Situation', render: (x) => x.scenario ?? '—' },
          { key: 'surprise', label: 'Surprise', wrap: true, render: (x) => x.surprise ? `${x.surprise.kind ?? ''}${x.surprise.name ? ` ${x.surprise.name}` : ''} — ${x.surprise.why}` : '—' },
        ]} /> },
      ]} /> },
    { key: 'next', icon: 'lucide:arrow-right', title: 'What comes next', n: d.edges.length, body: () => <RecordList rows={d.edges} keyOf={(e) => `${e.to}|${e.owner}|${e.tag}`} empty="Nothing asked or suggested after it yet." columns={[
      { key: 'to', label: 'Next', render: (e) => <button type="button" className="sa-btn sa-btn--link" onClick={() => goTo(e.to)}>{by.get(e.to)?.short || by.get(e.to)?.title || e.to}</button> },
      { key: 'tag', label: 'How', render: (e) => <Status state={e.tag === 'asked' ? 'ok' : 'neutral'}>{e.tag === 'asked' ? `asked ${e.count}×` : e.kind ?? 'suggested'}</Status> },
      { key: 'check', label: 'Made sense', render: (e) => <span className="sa-muted">{e.tag === 'asked' ? '—' : `${e.held ?? 0} of ${e.tried ?? 0}${e.retired ? ' · retired' : ''}`}</span> },
    ]} /> },
    { key: 'history', icon: 'lucide:history', title: 'History', n: n.passages, body: () => <><p className="sa-note">Made {dateTime(n.at)} by {n.by} · {plural(n.passages, 'answer')}</p><Accordion items={[
      { key: 'answers', icon: 'lucide:messages-square', title: 'Answers given', n: d.passages.length, body: () => <RecordList search pageSize={10} rows={d.passages} keyOf={(p) => `${p.session}|${p.at}`} empty="Nothing answered here yet." columns={[
        { key: 'q', label: 'Asked', wrap: true, render: (p) => p.question },
        { key: 'by', label: 'By', render: (p) => <span className="sa-muted">{p.agent}</span> },
        { key: 'how', label: 'How', render: (p) => <Status state={p.how === 'made' ? 'attention' : 'ok'}>{p.how === 'made' ? 'new' : p.how === 'same' ? 'continued' : 'matched'}</Status> },
        { key: 'at', label: 'When', align: 'end', render: (p) => <span className="sa-muted">{dateTime(p.at)}</span> },
      ]} /> },
      { key: 'versions', icon: 'lucide:git-commit', title: 'Versions', n: d.versions.length, body: () => <RecordList rows={d.versions} keyOf={(v) => String(v.version)} columns={[
        { key: 'v', label: 'Version', render: (v) => String(v.version) },
        { key: 'why', label: 'Why', wrap: true, render: (v) => v.why },
        { key: 'at', label: 'When', align: 'end', render: (v) => <span className="sa-muted">{dateTime(v.at)}</span> },
      ]} /> },
    ]} /></> },
  ]
  return (
    <div className="sa-graphpage__detail">
      {err && <Notice state="critical">{err}</Notice>}
      <h2 className="sa-graphpage__title">{n.short || n.title}</h2>
      {n.short && <p className="sa-note">{n.title}</p>}
      <Accordion items={items} openOnly={editing || removing !== null ? 'what' : null} />
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
