// THE WORKSPACE — the user UI on the platform's one framework (@superatom/ui): where to go on the left, a session's
// steps in the middle, the artifacts of the work on the right.
//
//   a step     one block of the session: what opened it (a question, a control, a path), the answer (the one answer
//              component), the programs' views its STATE names, and paths from here — what the decision memory has
//              learned people do from a situation like this, the programs' actions, recording a decision
//   the thread the path to the current step; going back to a step and changing it branches (the branch bar at a fork)
//   asking     words go to the session's agent, which answers in the step or opens a new one; its narration shows
//              while it works
//   artifacts  the decisions recorded in this session (and their versions), with the step that made each
//
// Everything is the platform's: the session is the engine's (session:*), the decision memory and the artifacts the
// platform's (decision:paths, artifact:*). The old chat stays at /c/<id>.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@superatom/ui/design.css'
import {
  AppShell, Sidebar, UserProfile, ConnectionStatus, Steps, BlockFrame, Answer, Paths, Artifacts, Section, Toasts,
  listenIntents, pathOf, siblingsOf, revealBlock, notify, type Recognised, type Artifact, type StepItem,
} from '@superatom/ui'
import ProgramBlock, { type ProgramUI } from './ProgramBlock'

type Request = (payload: Record<string, unknown>, onProgress?: (m: any) => void) => Promise<any>
interface Answer_ { id: string; block: string; cause: string; markdown: string; blocks?: Record<string, unknown>; at: string }
interface Intent_ { id: string; kind: 'structured' | 'language'; text?: string; ops?: any[]; call?: any; action?: any; to?: string; block?: string; at: string }
interface View {
  id: string; agent: string; user: string; leaf: string; created: string
  blocks: { id: string; parent: string | null; answer: string | null; stateHash: string }[]
  states: Record<string, Record<string, unknown>>; answers: Answer_[]; intents: Intent_[]
}
interface SessionMsg { t: string; reason?: string; view?: View; uis?: ProgramUI[]; actions?: { package: string; label: string; intent: any }[]; result?: { block: string; opened: boolean; stale?: boolean } }

const newId = () => `ses-${crypto.randomUUID()}`
const firstLine = (md: string) => (md ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith(':::'))?.replace(/[*_`#>]/g, '').slice(0, 120) ?? ''
const intentWords = (i?: Intent_) => !i ? '' : i.kind === 'language' ? `Asked: ${i.text ?? ''}` : i.call ? `Ran ${i.call.package} · ${i.call.fn}` : i.action ? `Took ${i.action.package} · ${i.action.id}` : (i.ops ?? []).map((o: any) => `${o.op} ${o.path}${'value' in o ? ` = ${JSON.stringify(o.value)}` : ''}`).join(', ') || 'A change'
const who = () => { try { const t = localStorage.getItem('sa-token') ?? ''; const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return { name: String(p.name ?? p.email ?? 'Signed in'), email: p.email ? String(p.email) : undefined } } catch { return { name: 'Signed in', email: undefined } } }

export default function Workspace({ request, projectId, token, projectName, connected, agents, path, go, extraNav }: {
  request: Request; projectId: string; token?: string | null; projectName: string; connected: boolean
  agents: { id: string; name: string }[]
  /** The workspace's address: '' (home), '<session>' or 's/<agent>' (start a session with an agent). */
  path: string; go: (path: string) => void
  /** The rest of the user UI (the chat, pages, consoles), kept reachable. */
  extraNav: { key: string; label: string; icon: string; onClick: () => void }[]
}) {
  const me = useMemo(who, [])
  const [sessions, setSessions] = useState<{ session: string; agent: string; title: string; updated?: string }[]>([])
  useEffect(() => { void request({ t: 'session:list' }).then((m) => setSessions(Array.isArray(m?.sessions) ? m.sessions : [])) }, [request, path])
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name ?? id
  const sessionId = /^[\w-]+$/.test(path) ? path : null
  const startAgent = /^s\/([\w-]+)/.exec(path)?.[1] ?? null

  // Opening an agent starts a session with it.
  useEffect(() => {
    if (!startAgent) return
    const sid = newId()
    void request({ t: 'session:open', session: sid, agent: startAgent }).then((m) => {
      if (m?.t === 'session:view') go(sid)
      else notify(m?.reason ?? 'The session could not be opened', 'refused')
    })
  }, [startAgent, request, go])

  const nav = [{
    items: [{ key: 'home', label: 'Home', icon: 'lucide:home', active: !sessionId && !startAgent, onClick: () => go('') }],
  }, {
    label: 'Agents',
    items: agents.map((a) => ({ key: `a:${a.id}`, label: a.name, icon: 'lucide:bot', onClick: () => go(`s/${a.id}`) })),
  }, {
    label: 'Your sessions',
    items: sessions.slice(0, 12).map((s) => ({ key: `s:${s.session}`, label: s.title || agentName(s.agent), icon: 'lucide:messages-square', active: s.session === sessionId, onClick: () => go(s.session) })),
  }, { label: 'More', items: extraNav }]

  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  return (
    <>
      <AppShell
        sidebar={(collapsed, toggle) => (
          <Sidebar name={projectName} connected={connected} groups={nav} collapsed={collapsed} onToggle={toggle}
            foot={(rail) => <UserProfile name={me.name} email={me.email} context={projectName} showName={!rail} />} />
        )}
        status={<ConnectionStatus status={connected ? 'open' : 'reconnecting'} />}
        artifacts={sessionId ? <Artifacts items={artifacts} onReveal={(b) => revealBlock(b)} /> : undefined}>
        {sessionId
          ? <SessionSteps key={sessionId} session={sessionId} request={request} projectId={projectId} token={token} agentName={agentName} onArtifacts={setArtifacts} />
          : <Home agents={agents} sessions={sessions} agentName={agentName} go={go} />}
      </AppShell>
      <Toasts />
    </>
  )
}

function Home({ agents, sessions, agentName, go }: { agents: { id: string; name: string }[]; sessions: { session: string; agent: string; title: string; updated?: string }[]; agentName: (id: string) => string; go: (p: string) => void }) {
  return (
    <div className="sa-thread"><div className="sa-thread__column">
      <div className="sa-home__hero"><h1 className="sa-home__title">Where do you want to start?</h1></div>
      <Section icon="lucide:bot" title="Agents" subtitle="Each knows one part of the organisation and the programs that work on it. A session with one is a thread of steps you can go back to and branch from.">
        {agents.length === 0 ? <p className="sa-note sa-section__empty">No agents you can see yet.</p> : (
          <div className="sa-sub-grid">
            {agents.map((a) => <button key={a.id} className="sa-sub-card" onClick={() => go(`s/${a.id}`)}><span className="sa-sub-card__title">{a.name}</span><span className="sa-sub-card__text">Start a session</span></button>)}
          </div>
        )}
      </Section>
      {sessions.length > 0 && (
        <Section icon="lucide:history" title="Your sessions" subtitle="Pick up where you left off.">
          <div className="sa-sub-grid">
            {sessions.slice(0, 12).map((s) => <button key={s.session} className="sa-sub-card" onClick={() => go(s.session)}><span className="sa-sub-card__title">{s.title || agentName(s.agent)}</span><span className="sa-sub-card__text">{agentName(s.agent)}{s.updated ? ` · ${new Date(s.updated).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}</span></button>)}
          </div>
        </Section>
      )}
    </div></div>
  )
}

function SessionSteps({ session, request, projectId, token, agentName, onArtifacts }: { session: string; request: Request; projectId: string; token?: string | null; agentName: (id: string) => string; onArtifacts: (a: Artifact[]) => void }) {
  const [msg, setMsg] = useState<SessionMsg | null>(null)
  const [refused, setRefused] = useState('')
  const [busy, setBusy] = useState(false)
  const [beats, setBeats] = useState<{ text: string; at: number }[]>([])
  const [asking, setAsking] = useState('')
  const [paths, setPaths] = useState<Record<string, Recognised | null>>({})
  const [deciding, setDeciding] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const view = msg?.view

  const take = useCallback((m: SessionMsg) => {
    if (m?.t === 'session:view' && m.view) { setRefused(''); if (!m.result?.stale) setMsg(m) }
    else if (m?.t === 'session:refused') setRefused(m.reason ?? 'The engine refused that.')
  }, [])
  const loadArtifacts = useCallback(() => request({ t: 'artifact:list', session }).then((m) => {
    const blocks = msg?.view?.blocks ?? []
    onArtifacts((Array.isArray(m?.artifacts) ? m.artifacts : []).map((a: any) => ({ id: a.id, kind: a.kind, title: a.title, at: a.at, by: a.by, version: a.version, status: a.status,
      summary: a.body?.reasoning ? `${a.body.reasoning}` : undefined, step: a.block ? { block: a.block, step: pathOf(blocks as any, msg?.view?.leaf ?? '').indexOf(a.block) + 1 || 0 } : undefined })))
  }), [request, session, onArtifacts, msg])

  useEffect(() => { setBusy(true); void request({ t: 'session:get', session }).then((m) => { setBusy(false); take(m) }) }, [session, request, take])
  useEffect(() => { if (view) void loadArtifacts() }, [view?.leaf, view?.answers.length])   // eslint-disable-line react-hooks/exhaustive-deps
  // Paths from the current step: what the decision memory recognises here.
  useEffect(() => {
    if (!view?.leaf || view.leaf in paths) return
    void request({ t: 'decision:paths', session, block: view.leaf }).then((m) => setPaths((p) => ({ ...p, [view.leaf]: m?.t === 'decision:paths' ? m : null })))
  }, [view?.leaf, request, session, paths])

  const intent = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true)
    take(await request({ t: 'session:intent', session, ...payload }))
    setBusy(false)
  }, [request, session, take])
  useEffect(() => {
    const el = root.current
    if (!el) return
    return listenIntents(el, (i, at) => void intent({ ...i, block: i.block ?? at.closest('[data-block]')?.getAttribute('data-block') ?? undefined }))
  }, [intent])

  const ask = async (text: string, block?: string) => {
    const t = text.trim(); if (!t || busy) return
    setAsking(t); setBeats([{ text: 'Looking into your question…', at: Date.now() }]); setBusy(true)
    const m = await request({ t: 'session:intent', session, kind: 'language', text: t, ...(block ? { block } : {}) }, (p) => { if (p?.t === 'narration' && p.text) setBeats((b) => [...b, { text: String(p.text), at: Date.now() }]) })
    setBusy(false); setAsking(''); setBeats([])
    take(m)
  }

  // A program's React side: from the platform (immutable, by hash), else from the engine.
  const fetchFile = useCallback(async (hash: string, path: string) => {
    const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/programs/${hash}/${path}`, { credentials: 'include', headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => null)
    if (r?.ok) return r.text()
    const m = await request({ t: 'session:file', hash, path })
    if (typeof m?.text === 'string') return m.text
    throw new Error(m?.reason ?? 'the file did not come')
  }, [projectId, token, request])

  const items: StepItem[] = useMemo(() => {
    if (!view) return []
    const path = pathOf(view.blocks as any, view.leaf)
    return path.map((id, i) => {
      const block = view.blocks.find((b) => b.id === id)!
      const answer = block.answer ? view.answers.find((a) => a.id === block.answer) : undefined
      const cause = answer ? view.intents.find((x) => x.id === answer.cause) : undefined
      const parentIdx = block.parent ? path.indexOf(block.parent) : -1
      const siblings = block.parent ? siblingsOf(view.blocks as any, id).map((sid: string) => {
        const s = view.blocks.find((b) => b.id === sid)!
        const a = s.answer ? view.answers.find((x) => x.id === s.answer) : undefined
        const c = a ? view.intents.find((x) => x.id === a.cause) : undefined
        return { id: s.id, label: c?.kind === 'language' ? c.text ?? 'A question' : firstLine(a?.markdown ?? '') || 'A step', cause: c?.kind === 'language' ? undefined : intentWords(c), active: s.id === id }
      }) : undefined
      const isLeaf = id === view.leaf
      const title = cause?.kind === 'language' ? cause.text ?? '' : firstLine(answer?.markdown ?? '') || (i === 0 ? agentName(view.agent) : 'A step')
      return {
        id, at: answer?.at ?? view.created, siblings,
        node: (
          <BlockFrame id={id} step={i + 1} label={i === 0 ? agentName(view.agent) : cause?.kind === 'language' ? 'Question' : 'Step'}
            title={title} cause={i > 0 ? intentWords(cause) : undefined}
            from={parentIdx >= 0 ? { id: block.parent!, step: parentIdx + 1, onPath: true } : undefined} onReveal={revealBlock}
            busy={busy && isLeaf} icon={cause?.kind === 'language' ? 'lucide:message-circle-question' : undefined}>
            {answer ? <Answer markdown={answer.markdown} blocks={answer.blocks} /> : <p className="sa-note sa-section__empty">Nothing shown yet. Run a program below, or ask.</p>}
            {msg?.uis?.filter((u) => u.blocks.length).map((u) => (
              <ProgramBlock key={u.hash} program={u} slice={view.states[id]?.[u.package]} state={view.states[id]} fetchFile={fetchFile} />
            ))}
            <Paths block={id} recognised={paths[id] ?? null} offered={(msg?.actions ?? []).map((a) => ({ label: a.label, intent: a.intent }))} onAsk={(t) => ask(t, id)} />
            <div className="sa-step__decide">
              {deciding === id
                ? <DecisionForm onCancel={() => setDeciding(null)} onRecord={async (body, approval) => {
                    const m = await request({ t: 'artifact:record', session, block: id, kind: 'decision', body, approval })
                    if (m?.t === 'artifact:recorded') { notify('Decision recorded', 'note'); setDeciding(null); void loadArtifacts() } else notify(m?.reason ?? 'The decision was not recorded', 'refused')
                  }} />
                : <button className="sa-btn sa-btn--link" onClick={() => setDeciding(id)}>Record a decision from this step</button>}
            </div>
          </BlockFrame>
        ),
      }
    })
  }, [view, msg, paths, busy, deciding, agentName, fetchFile, request, session, loadArtifacts])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={root} className="sa-work">
      {refused && <p className="sa-alert" role="alert"><span className="sa-alert__text">{refused}</span></p>}
      <Steps items={items} onSwitch={(b) => void request({ t: 'session:goto', session, block: b }).then(take)}
        empty={!refused && <p className="sa-note">Opening the session…</p>}
        after={
          <div className="sa-askbar">
            {asking && (
              <div className="sa-askbar__working">
                <span className="sa-label">Working on: {asking}</span>
                {beats.slice(-3).map((b, i) => <div key={i} className="sa-note">{b.text}</div>)}
              </div>
            )}
            <form className="sa-askbar__form" onSubmit={(e) => { e.preventDefault(); const f = e.currentTarget.elements.namedItem('q') as HTMLInputElement; void ask(f.value); f.value = '' }}>
              <div className="sa-askbar__field">
                <input id="sa-ask" name="q" className="sa-askbar__input" placeholder={busy ? 'Working…' : 'Ask about this step, or what to do next…'} disabled={busy} autoComplete="off" />
                <button className="sa-btn sa-btn--primary" disabled={busy}>Ask</button>
              </div>
            </form>
          </div>
        } />
    </div>
  )
}

/** Recording a decision: what was decided, the options weighed, the one chosen, and why. What it rested on (the step's
 *  answer, STATE and figures) is filled in by the platform. */
function DecisionForm({ onRecord, onCancel }: { onRecord: (body: Record<string, unknown>, approval: boolean) => void; onCancel: () => void }) {
  const [decision, setDecision] = useState('')
  const [reasoning, setReasoning] = useState('')
  const [options, setOptions] = useState('')
  const [approval, setApproval] = useState(false)
  return (
    <form className="sa-decide" onSubmit={(e) => { e.preventDefault(); onRecord({ decision, reasoning, options: options.split('\n').map((o) => o.trim()).filter(Boolean).map((label) => ({ label })), chosen: decision }, approval) }}>
      <label className="sa-label" htmlFor="sa-decision">What was decided</label>
      <input id="sa-decision" className="sa-input" value={decision} onChange={(e) => setDecision(e.target.value)} required />
      <label className="sa-label" htmlFor="sa-options">Options weighed (one per line)</label>
      <textarea id="sa-options" className="sa-input" rows={3} value={options} onChange={(e) => setOptions(e.target.value)} />
      <label className="sa-label" htmlFor="sa-reasoning">Why</label>
      <textarea id="sa-reasoning" className="sa-input" rows={3} value={reasoning} onChange={(e) => setReasoning(e.target.value)} required />
      <label className="sa-decide__check"><input id="sa-approval" type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> Needs approval by someone else</label>
      <div className="sa-decide__actions">
        <button type="button" className="sa-btn" onClick={onCancel}>Cancel</button>
        <button className="sa-btn sa-btn--primary">Record the decision</button>
      </div>
    </form>
  )
}
