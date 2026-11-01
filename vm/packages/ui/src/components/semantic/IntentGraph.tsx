// THE INTENT GRAPH, as a page (docs/intent-graph.md): every intent node and the ways people went between them, drawn
// left to right from where conversations start; a node chosen shows what it is for, the knowledge it links to, the agent
// that answers there, its versions, the ways out of it and the answers given at it. Beside it, a session's specialised
// agents: Superatom's own and the project's, and making one.

import { useEffect, useMemo, useState } from 'react'
import { Section } from '../ui/Section'
import { Notice, Receipt, RecordList, Status, Code, Form, Field, Empty } from './index'
import { dateTime } from '../../lib/when'

/** What these views read and change, from what the platform keeps (the project's HTTP client, control-plane/shared
 *  project-api.ts, gives it): each call resolves with the platform's JSON — `{ error }` when refused. */
export interface IntentsApi { graph(): Promise<any>; node(id: string): Promise<any> }
export interface SessionAgentsApi { list(): Promise<any> }
/** Given only to someone who runs the project (the platform checks it on every call). */
export interface SessionAgentsAdminApi { save(spec: unknown): Promise<any>; remove(name: string): Promise<any> }
interface Link { kind: 'domain' | 'concept'; name: string }
interface IndexNode { id: string; cluster: string; title: string; intent: string; links: Link[]; agent: string | null; stale: string | null; passages: number; by: string; at: string }
interface Edge { from: string; to: string; scope: string; count: number; how: string; last: string }
interface Passage { node: string; session: string; question: string; answer: string; who: string; at: string; how: string; from: string | null }
interface NodeDetail { node: IndexNode & { version: number }; edges: Edge[]; versions: { version: number; by: string; why: string; at: string }[]; passages: Passage[] }

const W = 230, H = 58, GX = 90, GY = 22, PAD = 16

/** Columns from where conversations start: a node no way leads to first, then each node one step further than the
 *  furthest node leading to it (a way back drawn as a loop, never moving a node). */
function layout(nodes: IndexNode[], edges: Edge[]) {
  const into = new Map<string, string[]>()
  for (const e of edges) if (e.from !== e.to) into.set(e.to, [...(into.get(e.to) ?? []), e.from])
  const level = new Map<string, number>()
  const visit = (id: string, trail: Set<string>): number => {
    if (level.has(id)) return level.get(id)!
    if (trail.has(id)) return 0
    trail.add(id)
    const from = (into.get(id) ?? []).filter((f) => nodes.some((n) => n.id === f))
    const l = from.length ? Math.max(...from.map((f) => visit(f, trail) + 1)) : 0
    trail.delete(id); level.set(id, l); return l
  }
  for (const n of nodes) visit(n.id, new Set())
  const cols: IndexNode[][] = []
  for (const n of [...nodes].sort((a, b) => b.passages - a.passages)) (cols[level.get(n.id)!] ??= []).push(n)
  const at = new Map<string, { x: number; y: number }>()
  cols.forEach((col, c) => col.forEach((n, r) => at.set(n.id, { x: PAD + c * (W + GX), y: PAD + r * (H + GY) })))
  const width = PAD * 2 + Math.max(1, cols.length) * (W + GX) - GX
  const height = PAD * 2 + Math.max(1, ...cols.map((c) => c.length)) * (H + GY) - GY
  return { at, width, height }
}

const linksOf = (n: { links: Link[] }) => n.links.map((l) => l.kind === 'domain' ? `domain ${l.name}` : l.name).join(', ')

export function IntentGraphView({ intents }: { intents: IntentsApi }) {
  const [graph, setGraph] = useState<{ nodes: IndexNode[]; edges: Edge[]; clusters: string[] } | null>(null)
  const [err, setErr] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [detail, setDetail] = useState<NodeDetail | null>(null)
  useEffect(() => { void intents.graph().then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); setGraph({ nodes: r.nodes ?? [], edges: r.edges ?? [], clusters: r.clusters ?? [] }) } }).catch((e: any) => setErr(e.message)) }, [intents])
  useEffect(() => { setDetail(null); if (picked) void intents.node(picked).then((r: any) => { if (r.error) setErr(r.error); else { setErr(''); setDetail(r) } }).catch((e: any) => setErr(e.message)) }, [intents, picked])
  const drawn = useMemo(() => graph ? layout(graph.nodes, graph.edges) : null, [graph])

  if (err) return <Notice state="critical">{err}</Notice>
  if (!graph || !drawn) return <Section icon="lucide:git-fork" title="Intent graph" subtitle="Loading…"><span className="sa-faint">…</span></Section>
  const used = new Map<string, number>()
  for (const e of graph.edges) used.set(`${e.from}>${e.to}`, (used.get(`${e.from}>${e.to}`) ?? 0) + e.count)
  return (
    <div className="sa-stack sa-stack--4">
      <Section icon="lucide:git-fork" title="Intent graph" subtitle="Each node is a kind of thing people ask for; each line, how people went from one to another — the number, how many times."
        note={`${graph.nodes.length} nodes · ${graph.clusters.length} clusters · ${graph.edges.length} ways`}>
        {!graph.nodes.length ? <Empty>The graph grows as questions are asked: each question is answered at a node, made for it when none answers it.</Empty> : (
          <div style={{ overflow: 'auto', maxHeight: '62vh', border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--surface)' }}>
            <svg width={drawn.width} height={drawn.height} role="img" aria-label="The intent graph">
              {[...used.entries()].map(([k, count]) => {
                const [f, t] = k.split('>'); const a = drawn.at.get(f), b = drawn.at.get(t)
                if (!a || !b) return null
                const forward = b.x > a.x
                const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2
                const d = forward ? `M ${x1} ${y1} C ${x1 + GX / 2} ${y1}, ${x2 - GX / 2} ${y2}, ${x2} ${y2}` : `M ${a.x + W / 2} ${a.y + H} C ${a.x + W / 2} ${a.y + H + 40}, ${b.x + W / 2} ${b.y + H + 40}, ${b.x + W / 2} ${b.y + H}`
                const mx = forward ? (x1 + x2) / 2 : (a.x + b.x + W) / 2, my = forward ? (y1 + y2) / 2 : Math.max(a.y, b.y) + H + 30
                return <g key={k}><path d={d} fill="none" style={{ stroke: 'var(--muted)', strokeWidth: Math.min(4, 1 + Math.log2(count)) }} markerEnd="url(#sa-arrow)" />
                  <text x={mx} y={my - 4} textAnchor="middle" style={{ fill: 'var(--muted)', fontSize: 11 }}>{count}</text></g>
              })}
              <defs><marker id="sa-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" style={{ fill: 'var(--muted)' }} /></marker></defs>
              {graph.nodes.map((n) => {
                const p = drawn.at.get(n.id)!; const on = picked === n.id
                return (
                  <g key={n.id} transform={`translate(${p.x}, ${p.y})`} onClick={() => setPicked(n.id)} style={{ cursor: 'pointer' }}>
                    <title>{`${n.title}\n${n.intent}`}</title>
                    <rect width={W} height={H} rx={8} style={{ fill: on ? 'var(--panel)' : 'var(--surface)', stroke: n.stale ? 'var(--warn)' : on ? 'var(--primary)' : 'var(--line)', strokeWidth: on || n.stale ? 2 : 1 }} />
                    <text x={10} y={22} style={{ fill: 'var(--ink)', fontSize: 13, fontWeight: 600 }}>{n.title.length > 30 ? `${n.title.slice(0, 29)}…` : n.title}</text>
                    <text x={10} y={42} style={{ fill: 'var(--muted)', fontSize: 11 }}>{`${n.passages} answer${n.passages === 1 ? '' : 's'}${n.agent ? ` · ${n.agent}` : ''}${n.stale ? ' · stale' : ''} · ${n.cluster}`.slice(0, 40)}</text>
                  </g>
                )
              })}
            </svg>
          </div>
        )}
      </Section>

      {picked && (
        <Section icon="lucide:target" title={detail?.node.title ?? '…'} subtitle={detail ? <Code>{detail.node.id}</Code> : undefined}
          note={detail ? `version ${detail.node.version}` : undefined} actions={<button type="button" className="sa-btn sa-btn--link" onClick={() => setPicked(null)}>Close</button>}>
          {!detail ? <span className="sa-faint">…</span> : (
            <div className="sa-stack sa-stack--4">
              {detail.node.stale && <Notice state="attention">Stale — {detail.node.stale}. What it links to changed since it was last answered at.</Notice>}
              <Receipt items={[
                ['Asks for', detail.node.intent],
                ['Knowledge', linksOf(detail.node) || '—'],
                ['Answered by', detail.node.agent ? `the ${detail.node.agent} agent` : 'the composer'],
                ['Cluster', detail.node.cluster],
                ['Made', `${dateTime(detail.node.at)} by ${detail.node.by}`],
                ['Answers', String(detail.node.passages)],
              ]} />
              <RecordList rows={detail.edges} keyOf={(e) => `${e.to}|${e.scope}`} empty="No way out of it yet." columns={[
                { key: 'to', label: 'Went on to', render: (e) => <button type="button" className="sa-btn sa-btn--link" onClick={() => setPicked(e.to)}>{graph.nodes.find((n) => n.id === e.to)?.title ?? e.to}</button> },
                { key: 'count', label: 'Times', align: 'end', render: (e) => String(e.count) },
                { key: 'scope', label: 'Whose', render: (e) => <span className="sa-muted">{e.scope}</span> },
              ]} />
              <RecordList search pageSize={10} rows={detail.passages} keyOf={(p) => `${p.session}|${p.at}`} empty="Nothing answered here yet." columns={[
                { key: 'q', label: 'Asked', wrap: true, render: (p) => p.question },
                { key: 'a', label: 'Answered', wrap: true, render: (p) => <span className="sa-muted">{p.answer.replace(/:::[^\n]*\n?/g, '').replace(/\s+/g, ' ').slice(0, 240)}</span> },
                { key: 'how', label: 'How', render: (p) => <Status state={p.how === 'made' ? 'attention' : 'ok'}>{p.how === 'made' ? 'made here' : p.how === 'stayed' ? 'about an answer' : 'followed'}</Status> },
                { key: 'at', label: 'When', align: 'end', render: (p) => <span className="sa-muted">{dateTime(p.at)}</span> },
              ]} />
              <RecordList rows={detail.versions} keyOf={(v) => String(v.version)} columns={[
                { key: 'v', label: 'Version', render: (v) => String(v.version) },
                { key: 'why', label: 'Why', wrap: true, render: (v) => v.why },
                { key: 'by', label: 'By', render: (v) => <span className="sa-muted">{v.by}</span> },
                { key: 'at', label: 'When', align: 'end', render: (v) => <span className="sa-muted">{dateTime(v.at)}</span> },
              ]} />
            </div>
          )}
        </Section>
      )}
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
      <Section icon="lucide:users" title="Specialised agents" subtitle="Each session gets one of each when a node needs it — the same agent and folder every time in that session."
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
      {admin && <Section icon="lucide:plus" title="Make an agent" subtitle="Given to everyone who holds what it needs; a node it answers at is made when someone asks for its kind of work">
        <Form onSubmit={() => { if (complete) void act(admin!.save(form), () => setForm({ name: '', title: '', description: '', needs: 'project.ask', harness: 'claude-code', instructions: '' })) }}
          actions={<button className="sa-btn sa-btn--primary" disabled={!complete}>Save</button>}>
          <Field label="Name" help="Lower case, letters, digits and -"><input className="sa-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase() })} placeholder="report-writer" /></Field>
          <Field label="Title"><input className="sa-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Report writer" /></Field>
          <Field label="What it is for" help="Said to people, and to the model that places a question"><input className="sa-input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Writes a formatted report when someone asks for one" /></Field>
          <Field label="Needs" help="The capability a person must hold to use it"><input className="sa-input" value={form.needs} onChange={(e) => setForm({ ...form, needs: e.target.value })} /></Field>
          <Field label="Runs on"><select className="sa-input" value={form.harness} onChange={(e) => setForm({ ...form, harness: e.target.value })}><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></Field>
          <Field label="Instructions" help="Its role, given to it at every turn"><textarea className="sa-input" rows={6} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} /></Field>
        </Form>
      </Section>}
    </div>
  )
}
