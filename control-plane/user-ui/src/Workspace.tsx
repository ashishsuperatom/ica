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
  AppShell, Sidebar, UserProfile, ConnectionStatus, Steps, BlockFrame, Answer, Paths, Artifacts, Toasts, LocalThread, AskBar, StepSkeleton,
  BeatRows, ProgramEnvContext, listenIntents, pathOf, siblingsOf, revealBlock, notify, startThread, Form, Field, Choices,
  type Recognised, type Artifact, type StepItem,
} from '@superatom/ui'
import { PAGE_BLOCKS, PagesContext } from './pageBlocks'
import { accentOf } from './agentLook'
import ProgramBlock, { preloadProgram, type ProgramUI } from './ProgramBlock'

type Request = (payload: Record<string, unknown>, onProgress?: (m: any) => void) => Promise<any>
type FetchFile = (hash: string, path: string) => Promise<string>
interface Answer_ { id: string; block: string; cause: string; markdown: string; blocks?: Record<string, unknown>; at: string }
interface Intent_ { id: string; kind: 'structured' | 'language'; text?: string; ops?: any[]; call?: any; action?: any; to?: string; block?: string; at: string }
interface View {
  id: string; agent: string; user: string; leaf: string; created: string
  blocks: { id: string; parent: string | null; answer: string | null; stateHash: string }[]
  states: Record<string, Record<string, unknown>>; answers: Answer_[]; intents: Intent_[]
}
interface SessionMsg { t: string; reason?: string; view?: View; uis?: ProgramUI[]; actions?: { package: string; label: string; intent: any }[]; functions?: Record<string, string[]>; result?: { block: string; opened: boolean; stale?: boolean } }
/** An agent as the workspace lists it: its look (an iconify icon, an accent, one line) and its starting points. */
export interface WorkAgent { id: string; name: string; isDefault?: boolean; look: { icon?: string; accent?: string; says?: string }; starts: { key: string; label: string; says: string }[] }

const newId = () => `ses-${crypto.randomUUID()}`
const plain = (s: string) => s.replace(/\*\*|__|`|^#+\s*|^>\s*/g, '').replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2').trim()
const firstLine = (md: string) => plain((md ?? '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith(':::')) ?? '').slice(0, 120)
const intentWords = (i?: Intent_) => !i ? '' : i.kind === 'language' ? `Asked: ${i.text ?? ''}` : i.call ? `Ran ${i.call.package} · ${i.call.fn}` : i.action ? `Took ${i.action.package} · ${i.action.id}` : (i.ops ?? []).map((o: any) => `${o.op} ${o.path}${'value' in o ? ` = ${JSON.stringify(o.value)}` : ''}`).join(', ') || 'A change'
const who = () => { try { const t = localStorage.getItem('sa-token') ?? ''; const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); return { name: String(p.name ?? p.email ?? 'Signed in'), email: p.email ? String(p.email) : undefined } } catch { return { name: 'Signed in', email: undefined } } }
/** A step's first line names it: "**title** — _what was done_". The rest is the answer's prose and blocks. */
function leadOf(md: string): { title?: string; said?: string; rest: string } {
  const lines = String(md ?? '').split('\n')
  const i = lines.findIndex((l) => l.trim())
  const m = /^\*\*(.+?)\*\*(?:\s+—\s+_(.+)_)?\s*$/.exec(lines[i]?.trim() ?? '')
  return m ? { title: m[1], said: m[2], rest: lines.filter((_, j) => j !== i).join('\n') } : { rest: md }
}

/** Views opened by this page and ready to show (their programs' views loaded): a session opens from here without asking again. */
const opened = new Map<string, SessionMsg>()
/** A view made ready to show whole: its programs' React sides loaded, and the paths from its current step, waited for a
 *  moment at most — so a step appears once, complete, instead of in pieces. */
async function ready(m: SessionMsg, fetchFile: FetchFile, request: Request, session: string): Promise<Recognised | null | undefined> {
  if (m?.t !== 'session:view' || !m.view) return undefined
  let recognised: Recognised | null | undefined
  const paths = request({ t: 'decision:paths', session, block: m.view.leaf }).then((r) => { recognised = r?.t === 'decision:paths' ? r : null }, () => { recognised = null })
  const programs = Promise.all((m.uis ?? []).filter((u) => u.blocks.length).map((u) => preloadProgram(u, fetchFile).catch(() => null)))
  await Promise.race([Promise.all([paths, programs]), new Promise((r) => setTimeout(r, 2500))])
  return recognised
}

export default function Workspace({ request, subscribeLive, scopes, projectId, token, projectName, connected, agents, path, go, extraNav }: {
  request: Request; subscribeLive: (fn: (m: any) => void) => () => void; scopes: string[]; projectId: string; token?: string | null; projectName: string; connected: boolean
  agents: WorkAgent[]
  /** The workspace's address: '' (home), '<session>' or 's/<agent>[/<start>]' (start a session with an agent). */
  path: string; go: (path: string) => void
  /** The rest of the user UI (the chat, pages, consoles), kept reachable. */
  extraNav: { key: string; label: string; icon: string; onClick: () => void }[]
}) {
  const me = useMemo(who, [])
  const [sessions, setSessions] = useState<{ session: string; agent: string; title: string; updated?: string }[]>([])
  useEffect(() => { void request({ t: 'session:list' }).then((m) => setSessions(Array.isArray(m?.sessions) ? m.sessions : [])) }, [request, path])
  const agentOf = useCallback((id: string): WorkAgent => agents.find((a) => a.id === id) ?? { id, name: id, look: {}, starts: [] }, [agents])
  const sessionId = /^[\w-]+$/.test(path) ? path : null
  const startMatch = /^s\/([\w-]+)(?:\/([\w-]+))?/.exec(path)
  const startAgent = startMatch?.[1] ?? null
  const startKey = startMatch?.[2] ?? null

  // A program's React side: from the platform (immutable, by hash), else from the engine.
  const fetchFile = useCallback<FetchFile>(async (hash, file) => {
    const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/programs/${hash}/${file}`, { credentials: 'include', headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => null)
    if (r?.ok) return r.text()
    const m = await request({ t: 'session:file', hash, path: file })
    if (typeof m?.text === 'string') return m.text
    throw new Error(m?.reason ?? 'the file did not come')
  }, [projectId, token, request])

  // Opening an agent (or one of its starting points) starts a session with it; the step shows at once, as a skeleton,
  // and the session replaces it whole when it is ready.
  const live = useRef({ request, go, fetchFile }); live.current = { request, go, fetchFile }
  const openingPath = useRef<string | null>(null)
  useEffect(() => {
    if (!startAgent) { openingPath.current = null; return }
    if (openingPath.current === path) return   // once per address (React runs effects twice in development)
    openingPath.current = path
    const sid = newId()
    const { request: rq, go: to, fetchFile: ff } = live.current
    void rq({ t: 'session:open', session: sid, agent: startAgent, ...(startKey ? { startAt: startKey } : {}) }).then(async (m: SessionMsg) => {
      if (m?.t !== 'session:view') { notify(m?.reason ?? 'The session could not be opened', 'refused'); live.current.go(''); return }
      await ready(m, ff, rq, sid)
      opened.set(sid, m)
      to(sid)
    })
  }, [startAgent, startKey])   // eslint-disable-line react-hooks/exhaustive-deps

  // A page of the user UI is a block: from a session it opens a fresh thread starting there; on the pages, a new thread.
  const [root, setRoot] = useState<string | null>(null)
  const [pending, setPending] = useState<{ type: string } | null>(() => { const p = new URLSearchParams(location.search).get('page'); return p && ['agents', 'activity', 'connections'].includes(p) ? { type: p } : null })
  const page = (type: string) => { if (sessionId || startAgent) { setPending({ type }); go('') } else startThread(type) }
  const onPages = !sessionId && !startAgent
  const current = sessionId ? sessions.find((s) => s.session === sessionId)?.agent ?? null : startAgent
  const nav = [{
    items: [{ key: 'home', label: 'Home', icon: 'lucide:house', active: onPages && root === 'home', onClick: () => page('home') }],
  }, {
    label: 'Agents',
    items: agents.filter((a) => !a.isDefault).map((a) => ({ key: `a:${a.id}`, label: a.name, icon: a.look.icon ?? 'lucide:bot', title: a.look.says, active: !onPages && current === a.id, onClick: () => go(`s/${a.id}`) })),
  }, {
    label: 'Your sessions',
    items: sessions.slice(0, 10).map((s) => ({ key: `s:${s.session}`, label: plain(s.title || agentOf(s.agent).name), icon: agentOf(s.agent).look.icon ?? 'lucide:messages-square', active: s.session === sessionId, onClick: () => go(s.session) })),
  }, {
    label: 'More',
    items: [
      { key: 'agents', label: 'Manage agents', icon: 'lucide:bot', active: onPages && root === 'agents', onClick: () => page('agents') },
      { key: 'activity', label: 'Activity', icon: 'lucide:activity', active: onPages && root === 'activity', onClick: () => page('activity') },
      { key: 'connections', label: 'Connections', icon: 'lucide:plug', active: onPages && root === 'connections', onClick: () => page('connections') },
      ...extraNav,
    ],
  }]

  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [artifactsTick, setArtifactsTick] = useState(0)
  useEffect(() => { setArtifacts([]) }, [sessionId])
  const pagesEnv = useMemo(() => ({ request, subscribeLive, projectId, token, scopes, agents, sessions, go }), [request, subscribeLive, projectId, token, scopes, agents, sessions, go])
  const programEnv = useMemo(() => ({ request }), [request])
  const opening = startAgent ? agentOf(startAgent) : null
  return (
    <>
      <AppShell
        sidebar={(collapsed, toggle) => (
          <Sidebar name={projectName} connected={connected} groups={nav} collapsed={collapsed} onToggle={toggle}
            foot={(rail) => <UserProfile name={me.name} email={me.email} context={projectName} showName={!rail} />} />
        )}
        status={<ConnectionStatus status={connected ? 'open' : 'reconnecting'} />}
        artifacts={sessionId ? <>
          <Artifacts items={artifacts} onReveal={(b) => revealBlock(b)} />
          <ForkAgent session={sessionId} request={request} onMade={() => setArtifactsTick((n) => n + 1)} />
        </> : undefined}
        artifactsCount={artifacts.length}>
        <ProgramEnvContext.Provider value={programEnv}>
          {opening
            ? <div className="sa-work"><Steps onSwitch={() => {}} items={[{ id: 'opening', at: new Date().toISOString(), node: (
                <BlockFrame id="opening" step={1} label={opening.name} title={(startKey && opening.starts.find((x) => x.key === startKey)?.label) || opening.name} subtitle="Opening…" busy
                  icon={opening.look.icon} accent={accentOf(opening.look.accent)}><StepSkeleton label="Opening" /></BlockFrame>
              ) }]} /></div>
            : sessionId
            ? <SessionSteps key={sessionId} session={sessionId} request={request} fetchFile={fetchFile} agentOf={agentOf} onArtifacts={setArtifacts} artifactsTick={artifactsTick} />
            : <PagesContext.Provider value={pagesEnv}>
                <LocalThread blocks={PAGE_BLOCKS} home={pending ?? { type: 'home' }} onRoot={(r) => { setRoot(r); if (r) setPending(null) }} address={(b) => (b.type === 'home' ? '/w' : ['agents', 'activity', 'connections'].includes(b.type) ? `/w?page=${b.type}` : null)} />
              </PagesContext.Provider>}
        </ProgramEnvContext.Provider>
      </AppShell>
      <Toasts />
    </>
  )
}

/** Making an agent from a session: what the work learned (its questions and the steps taken) becomes an agent, and the
 *  agent an artifact of the session. */
function ForkAgent({ session, request, onMade }: { session: string; request: Request; onMade: () => void }) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const fork = async () => {
    const t = title.trim(); if (!t) return
    const m = await request({ t: 'session:fork', session, name: t, title: t })
    if (m?.t !== 'session:forked') { notify(m?.reason ?? 'The agent could not be made', 'refused'); return }
    await request({ t: 'artifact:record', session, kind: 'agent', title: `Agent: ${t}`, body: { agent: m.agent, domain: m.domain, concept: m.concept, scope: m.scope, reasoning: 'made from this session: its questions and the steps taken' } })
    notify(`${t} made — yours until it is published`, 'note'); setOpen(false); setTitle(''); onMade()
  }
  if (!open) return <button className="sa-btn sa-btn--link sa-artifacts__make" title="An agent that knows what this session learned: the questions asked and the steps taken" onClick={() => setOpen(true)}>Make an agent from this session</button>
  return (
    <Form onSubmit={() => void fork()} actions={<><button type="button" className="sa-btn" onClick={() => setOpen(false)}>Cancel</button><button className="sa-btn sa-btn--primary">Make the agent</button></>}>
      <Field label="The new agent's title"><input id="sa-fork-title" className="sa-input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required /></Field>
    </Form>
  )
}

type Pending = { kind: 'new'; from: string | null; label: string; beats?: { text: string; at: number }[] } | { kind: 'edit'; block: string }

function SessionSteps({ session, request, fetchFile, agentOf, onArtifacts, artifactsTick }: { session: string; request: Request; fetchFile: FetchFile; agentOf: (id: string) => WorkAgent; onArtifacts: (a: Artifact[]) => void; artifactsTick: number }) {
  const [msg, setMsg] = useState<SessionMsg | null>(() => opened.get(session) ?? null)
  const [refused, setRefused] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [paths, setPaths] = useState<Record<string, Recognised | null>>({})
  const [deciding, setDeciding] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const view = msg?.view
  const agent = agentOf(view?.agent ?? '')

  // A reply is shown once it is ready to show whole; a later reply wins over an earlier one still getting ready.
  const accept = useCallback(async (m: SessionMsg) => {
    const n = ++seq.current
    if (m?.t === 'session:refused') { setRefused(m.reason ?? 'The engine refused that.'); return }
    if (m?.t !== 'session:view' || !m.view || m.result?.stale) return
    const recognised = await ready(m, fetchFile, request, session)
    if (n !== seq.current) return
    setRefused(''); setMsg(m)
    if (recognised !== undefined) setPaths((p) => ({ ...p, [m.view!.leaf]: recognised }))
  }, [fetchFile, request, session])

  useEffect(() => {
    const had = opened.get(session)
    if (had) { opened.delete(session); return }
    void request({ t: 'session:get', session }).then(accept)
  }, [session, request, accept])
  // Paths from a step reached without them (going back to a step, a branch).
  useEffect(() => {
    if (!view?.leaf || view.leaf in paths) return
    const leaf = view.leaf
    void request({ t: 'decision:paths', session, block: leaf }).then((m) => setPaths((p) => ({ ...p, [leaf]: m?.t === 'decision:paths' ? m : null })))
  }, [view?.leaf, request, session, paths])

  const loadArtifacts = useCallback(() => request({ t: 'artifact:list', session }).then((m) => {
    const blocks = view?.blocks ?? []
    onArtifacts((Array.isArray(m?.artifacts) ? m.artifacts : []).map((a: any) => ({ id: a.id, kind: a.kind, title: a.title, at: a.at, by: a.by, version: a.version, status: a.status,
      summary: a.body?.reasoning ? `${a.body.reasoning}` : undefined, step: a.block ? { block: a.block, step: pathOf(blocks as any, view?.leaf ?? '').indexOf(a.block) + 1 || 0 } : undefined })))
  }), [request, session, onArtifacts, view])
  useEffect(() => { if (view) void loadArtifacts() }, [view?.id, view?.blocks.length, artifactsTick])   // eslint-disable-line react-hooks/exhaustive-deps

  // An intent: from the current step and to it, the step changes in place (dimmed while it works); otherwise a new step
  // appears at once where it will stand, as a skeleton, and the answer fills it.
  const intent = useCallback(async (payload: Record<string, unknown>, label: string) => {
    if (pending || !view) return
    const block = String(payload.block ?? view.leaf)
    const opens = payload.to === 'new' || block !== view.leaf
    setPending(opens ? { kind: 'new', from: block, label } : { kind: 'edit', block })
    if (opens) setTimeout(() => revealBlock('pending'), 30)
    const m = await request({ t: 'session:intent', session, ...payload })
    await accept(m)
    setPending(null)
    if (opens && m?.view?.leaf) setTimeout(() => revealBlock(m.view.leaf), 30)
  }, [pending, view, request, session, accept])
  const intentRef = useRef(intent); intentRef.current = intent
  useEffect(() => {
    const el = root.current
    if (!el) return
    return listenIntents(el, (i, at) => {
      const words = at.hasAttribute('data-sa-intent') ? (at.getAttribute('title') || at.textContent || '').trim().slice(0, 120) : ''
      void intentRef.current({ ...i, block: i.block ?? at.closest('[data-block]')?.getAttribute('data-block') ?? undefined }, words)
    })
  }, [])

  const ask = async (text: string, block?: string) => {
    const t = text.trim(); if (!t || pending || !view) return
    setPending({ kind: 'new', from: block ?? view.leaf, label: t, beats: [{ text: 'Looking into your question…', at: Date.now() }] })
    setTimeout(() => revealBlock('pending'), 30)
    const m = await request({ t: 'session:intent', session, kind: 'language', text: t, ...(block ? { block } : {}) }, (p) => {
      if (p?.t === 'narration' && p.text) setPending((x) => (x?.kind === 'new' ? { ...x, beats: [...(x.beats ?? []), { text: String(p.text), at: Date.now() }] } : x))
    })
    await accept(m)
    setPending(null)
    if (m?.view?.leaf) setTimeout(() => revealBlock(m.view.leaf), 30)
  }

  // The program a clicked row goes to: one in the step's STATE that offers row() (the session's programs say so).
  const rowPackage = (block: string) => Object.keys((view?.states[block]?.packages ?? {}) as Record<string, string>).find((p) => msg?.functions?.[p]?.includes('row'))
  // What the programs offer beyond opening (their actions), as next moves; running again is what opening already did.
  const offered = (msg?.actions ?? []).filter((a) => a.intent?.call?.fn !== 'run').map((a) => ({ label: a.label, intent: a.intent }))
  const uis = (msg?.uis ?? []).filter((u) => u.blocks.length)
  const items: StepItem[] = useMemo(() => {
    if (!view) return []
    const full = pathOf(view.blocks as any, view.leaf) as string[]
    // A new step from an earlier one stands under it: the path down to it, then the step on its way.
    const cut = pending?.kind === 'new' && pending.from ? full.indexOf(pending.from) : -1
    const path = cut >= 0 ? full.slice(0, cut + 1) : full
    const steps: StepItem[] = path.map((id, i) => {
      const block = view.blocks.find((b) => b.id === id)!
      const answer = block.answer ? view.answers.find((a) => a.id === block.answer) : undefined
      const cause = answer ? view.intents.find((x) => x.id === answer.cause) : undefined
      const asked = cause?.kind === 'language'
      const lead = asked ? { rest: answer?.markdown ?? '' } : leadOf(answer?.markdown ?? '')
      const parentIdx = block.parent ? path.indexOf(block.parent) : -1
      const siblings = block.parent ? siblingsOf(view.blocks as any, id).map((sid: string) => {
        const s = view.blocks.find((b) => b.id === sid)!
        const a = s.answer ? view.answers.find((x) => x.id === s.answer) : undefined
        const c = a ? view.intents.find((x) => x.id === a.cause) : undefined
        return { id: s.id, label: c?.kind === 'language' ? c.text ?? 'A question' : leadOf(a?.markdown ?? '').said ?? (firstLine(a?.markdown ?? '') || 'A step'), active: s.id === id }
      }) : undefined
      const editing = pending?.kind === 'edit' && pending.block === id
      const isLeaf = id === view.leaf && !(pending?.kind === 'new')
      const title = asked ? cause?.text ?? '' : lead.title ?? (firstLine(answer?.markdown ?? '') || agent.name)
      const said = asked ? undefined : lead.said
      return {
        id, at: answer?.at ?? view.created, siblings,
        node: (
          <BlockFrame id={id} step={i + 1} label={asked ? 'Question' : agent.name} title={title}
            cause={i > 0 ? (said ?? intentWords(cause)) : undefined} subtitle={i === 0 ? said ?? `opened ${agent.name.toLowerCase()}` : undefined}
            from={parentIdx >= 0 ? { id: block.parent!, step: parentIdx + 1, onPath: true } : undefined} onReveal={revealBlock}
            busy={editing} icon={asked ? 'lucide:message-circle-question' : agent.look.icon} accent={asked ? 'var(--series-2)' : accentOf(agent.look.accent)}>
            {uis.filter((u) => u.head?.length).map((u) => <ProgramBlock key={`h:${u.hash}`} program={u} only={u.head} slice={view.states[id]?.[u.package]} state={view.states[id]} fetchFile={fetchFile} />)}
            <div className={`sa-stack${editing ? ' sa-busy' : ''}`}>
              {answer ? <Answer markdown={lead.rest} blocks={answer.blocks}
                onRow={rowPackage(id) ? (move, row) => void intent({ call: { package: rowPackage(id)!, fn: 'row', params: { move, row } }, to: 'new', block: id }, String(row[(move as any).label] ?? '')) : undefined} />
                : <p className="sa-note sa-section__empty">Nothing shown yet. Ask below.</p>}
              <Paths block={id} recognised={paths[id] ?? null} offered={isLeaf ? offered : []} onAsk={(t) => ask(t, id)} />
              {uis.map((u) => { const body = u.blocks.filter((b) => !u.head?.includes(b)); return body.length ? <ProgramBlock key={`b:${u.hash}`} program={u} only={body} slice={view.states[id]?.[u.package]} state={view.states[id]} fetchFile={fetchFile} /> : null })}
              {isLeaf && (deciding === id
                ? <DecisionForm onCancel={() => setDeciding(null)} onRecord={async (body, approval) => {
                    const m = await request({ t: 'artifact:record', session, block: id, kind: 'decision', body, approval })
                    if (m?.t === 'artifact:recorded') { notify('Decision recorded', 'note'); setDeciding(null); void loadArtifacts() } else notify(m?.reason ?? 'The decision was not recorded', 'refused')
                  }} />
                : <div className="sa-step__decide"><button className="sa-btn sa-btn--link" onClick={() => setDeciding(id)}>Record a decision from this step</button></div>)}
            </div>
          </BlockFrame>
        ),
      }
    })
    if (pending?.kind === 'new') {
      const fromIdx = pending.from ? path.indexOf(pending.from) : path.length - 1
      steps.push({ id: 'pending', at: new Date().toISOString(), node: (
        <BlockFrame id="pending" step={path.length + 1} label={pending.beats ? 'Question' : agent.name} title={pending.label || 'The next step'} busy
          cause={pending.beats ? undefined : 'Opening'} from={fromIdx >= 0 ? { id: path[fromIdx], step: fromIdx + 1, onPath: true } : undefined} onReveal={revealBlock}
          icon={pending.beats ? 'lucide:message-circle-question' : agent.look.icon} accent={pending.beats ? 'var(--series-2)' : accentOf(agent.look.accent)}>
          {pending.beats ? <div className="sa-card" aria-busy="true" aria-live="polite"><BeatRows beats={pending.beats} live /></div> : <StepSkeleton />}
        </BlockFrame>
      ) })
    }
    return steps
  }, [view, msg, paths, pending, deciding, agent, fetchFile, request, session, loadArtifacts, intent])   // eslint-disable-line react-hooks/exhaustive-deps

  const leafLead = view ? leadOf(view.answers.find((a) => a.id === view.blocks.find((b) => b.id === view.leaf)?.answer)?.markdown ?? '') : null
  return (
    <div ref={root} className="sa-work">
      {refused && <p className="sa-alert" role="alert"><span className="sa-alert__text">{refused}</span></p>}
      <Steps items={items} onSwitch={(b) => void request({ t: 'session:goto', session, block: b }).then(accept)}
        empty={!refused && <StepSkeleton label="Opening the session" />}
        after={view && <AskBar onAsk={(t) => void ask(t)} busy={!!pending} placeholder="Ask about these numbers…" from={leafLead?.title ?? agent.name} />} />
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
    <Form onSubmit={() => onRecord({ decision, reasoning, options: options.split('\n').map((o) => o.trim()).filter(Boolean).map((label) => ({ label })), chosen: decision }, approval)}
      actions={<><button type="button" className="sa-btn" onClick={onCancel}>Cancel</button><button className="sa-btn sa-btn--primary">Record the decision</button></>}>
      <Field label="What was decided"><input id="sa-decision" className="sa-input" value={decision} onChange={(e) => setDecision(e.target.value)} required /></Field>
      <Field label="Options weighed (one per line)"><textarea id="sa-options" className="sa-input" rows={3} value={options} onChange={(e) => setOptions(e.target.value)} /></Field>
      <Field label="Why"><textarea id="sa-reasoning" className="sa-input" rows={3} value={reasoning} onChange={(e) => setReasoning(e.target.value)} required /></Field>
      <Choices label="Approval"><label><input id="sa-approval" type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} /> Needs approval by someone else</label></Choices>
    </Form>
  )
}
