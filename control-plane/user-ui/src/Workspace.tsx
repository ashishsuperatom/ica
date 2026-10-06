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
// platform's (decision:paths, artifact:*). It is the only view of the user UI: a new chat starts from home, where the first
// question picks the agent.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import '@superatom/ui/design.css'
import {
  AppShell, RailSidebar, NavList, MenuItem, MenuRule, type RailPlace, UserProfile, ConnectionStatus, Search, useSearchKey, recall, remember, Icon, Dialog, type SearchItem, Steps, BlockFrame, Answer, Paths, Artifacts, Toasts, LocalThread, AskBar, StepSkeleton,
  BeatRows, ProgramEnvContext, listenIntents, pathOf, siblingsOf, revealBlock, notify, startThread, Form, Field, Choices,
  type Recognised, type Artifact, type StepItem,
} from '@superatom/ui'
import { PAGE_BLOCKS, PagesContext, KeyboardShortcuts } from './pageBlocks'
import { accentOf } from './agentLook'
import ProgramBlock, { preloadProgram } from './ProgramBlock'
import { sessionSource, viewSource, viewFromHistory, type Request, type SessionMsg, type ThreadSource, type Intent_, type View } from './threadSource'

type FetchFile = (hash: string, path: string) => Promise<string>
/** An agent as the workspace lists it: its look (an iconify icon, an accent, one line) and its starting points. */
export interface WorkAgent { id: string; name: string; isDefault?: boolean; look: { icon?: string; accent?: string; says?: string; main?: { label: string; says?: string } }; starts: { key: string; label: string; says: string }[] }

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

/** Record something on a session (a decision, what it made), waiting a moment for the platform to have a session just
 *  kept from a view. */
async function recordKept(request: Request, session: string, payload: Record<string, unknown>) {
  let m: any
  for (let i = 0; i < 5; i++) {
    m = await request(payload)
    if (m?.t !== 'artifact:refused' || !/no such session/i.test(String(m?.reason ?? ''))) return m
    await new Promise((r) => setTimeout(r, 700))
  }
  return m
}

/** Views opened by this page and ready to show (their programs' views loaded): a session opens from here without asking again. */
const opened = new Map<string, SessionMsg>()
/** A view made ready to show whole: its programs' React sides loaded, and the paths from its current step, waited for a
 *  moment at most — so a step appears once, complete, instead of in pieces. */
async function ready(m: SessionMsg, fetchFile: FetchFile, source: ThreadSource): Promise<Recognised | null | undefined> {
  if (m?.t !== 'session:view' || !m.view) return undefined
  let recognised: Recognised | null | undefined
  const paths = source.paths(m.view, m.view.leaf).then((r) => { recognised = r?.t === 'decision:paths' ? r : null }, () => { recognised = null })
  const programs = Promise.all((m.uis ?? []).filter((u) => u.blocks.length).map((u) => preloadProgram(u, fetchFile).catch(() => null)))
  await Promise.race([Promise.all([paths, programs]), new Promise((r) => setTimeout(r, 2500))])
  return recognised
}

export default function Workspace({ request, send, subscribeLive, scopes, caps, projectId, token, projectName, connected, status, agents, path, go, onSignOut }: {
  request: Request; send: (payload: Record<string, unknown>) => void; subscribeLive: (fn: (m: any) => void) => () => void
  scopes: string[]; caps: string[]; projectId: string; token?: string | null; projectName: string
  /** Whether the socket is open, and what to say when it is not (an expired sign-in, no access). */
  connected: boolean; status: string
  agents: WorkAgent[]
  /** The workspace's address: '' (home), '<session>' or 's/<agent>[/<start>]' (start a session with an agent). */
  path: string; go: (path: string) => void
  onSignOut?: () => void
}) {
  const me = useMemo(who, [])
  const [sessions, setSessions] = useState<Conversation[]>([])
  const [listTick, setListTick] = useState(0)
  // A session is kept only once it is used, so the list is read again then (a moment later, once the platform has it).
  useEffect(() => { void request({ t: 'session:list' }).then((m) => setSessions(Array.isArray(m?.sessions) ? m.sessions : [])) }, [request, path, listTick])
  const onUsed = useCallback(() => { setTimeout(() => setListTick((n) => n + 1), 1200) }, [])
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

  // A session's thread is the platform's; an agent's views are this browser's until something must be kept.
  const source = useMemo(() => (sessionId ? sessionSource(request, sessionId) : startAgent ? viewSource(request, startAgent, startKey) : null), [request, sessionId, startAgent, startKey])
  // A view became a session (a question, a decision): go to it, with what was just shown.
  const onKept = useCallback((session: string, msg: SessionMsg | null) => { if (msg) opened.set(session, msg); setListTick((n) => n + 1); go(session) }, [go])

  // A page of the user UI is a block: from a session it opens a fresh thread starting there; on the pages, a new thread.
  const [root, setRoot] = useState<string | null>(null)
  const [pending, setPending] = useState<{ type: string } | null>(() => { const p = new URLSearchParams(location.search).get('page'); return p && PAGES.includes(p) ? { type: p } : null })
  const page = (type: string) => { if (sessionId || startAgent) { setPending({ type }); go('') } else startThread(type) }
  const onPages = !sessionId && !startAgent
  const current = sessionId ? sessions.find((s) => s.session === sessionId)?.agent ?? null : startAgent
  // A new chat: the greeting, with the ask bar ready; the first question opens the session, with the agent it reaches.
  const focusAsk = () => setTimeout(() => (document.querySelector('.sa-askbar textarea, .sa-askbar input') as HTMLElement | null)?.focus(), 80)
  const newChat = () => { page('home'); focusAsk() }
  // The sidebar is two: a rail of the big places (home, agents, connections) with the person at its foot, and the panel
  // of the place picked — home's is a new chat and the conversations, newest first, a page at a time; activity and
  // search sit in the panel's head.
  const [shownConversations, setShownConversations] = useState(20)
  const [activityView, setActivityView] = useState(() => recall<boolean>('sidebar-activity', false))
  const toggleActivity = useCallback(() => setActivityView((v) => { remember('sidebar-activity', !v); return !v }), [])
  const [searching, setSearching] = useState(false)
  useSearchKey(useCallback(() => setSearching(true), []))
  useEffect(() => { const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.altKey && e.key.toLowerCase() === 'u') { e.preventDefault(); toggleActivity() } }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [toggleActivity])
  // How the person keeps a conversation: a name, pinned, in a collection, archived — kept in their UserDO.
  const keep = useCallback(async (session: string, change: { name?: string; pinned?: boolean; archived?: boolean; collection?: string }) => {
    const m = await request({ t: 'session:keep', session, ...change })
    if (m?.t === 'session:kept') setListTick((n) => n + 1); else notify(m?.reason ?? 'That could not be changed', 'refused')
  }, [request])
  const [naming, setNaming] = useState<{ session: string; what: 'name' | 'collection'; value: string } | null>(null)
  const titleOf = (s: Conversation) => s.name || plain(s.title) || agentOf(s.agent).name
  const live = sessions.filter((s) => !s.archived)
  const collections = [...new Set(live.map((s) => s.collection).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b))
  const menuOf = (s: Conversation) => () => <>
    <MenuItem icon="solar:pen-linear" label="Rename" onClick={() => setNaming({ session: s.session, what: 'name', value: titleOf(s) })} />
    <MenuItem icon={s.pinned ? 'solar:pin-bold' : 'solar:pin-linear'} label={s.pinned ? 'Unpin' : 'Pin'} onClick={() => void keep(s.session, { pinned: !s.pinned })} />
    <MenuItem icon="solar:folder-linear" label="Move to collection" sub={<>
      {collections.filter((c) => c !== s.collection).map((c) => <MenuItem key={c} icon="solar:folder-linear" label={c} onClick={() => void keep(s.session, { collection: c })} />)}
      <MenuItem icon="solar:add-folder-linear" label="New collection…" onClick={() => setNaming({ session: s.session, what: 'collection', value: '' })} />
      {s.collection && <MenuItem icon="solar:close-circle-linear" label={`Take out of ${s.collection}`} onClick={() => void keep(s.session, { collection: '' })} />}
    </>} />
    <MenuRule />
    <MenuItem icon={s.archived ? 'solar:archive-up-linear' : 'solar:archive-linear'} label={s.archived ? 'Unarchive' : 'Archive'} onClick={() => void keep(s.session, { archived: !s.archived })} />
  </>
  const itemOf = (s: Conversation) => ({ key: `s:${s.session}`, label: titleOf(s), active: s.session === sessionId, onClick: () => go(s.session), menu: menuOf(s),
    quick: [{ key: 'pin', icon: s.pinned ? 'solar:pin-bold' : 'solar:pin-linear', label: s.pinned ? 'Unpin' : 'Pin', onClick: () => void keep(s.session, { pinned: !s.pinned }) }] })
  const loose = live.filter((s) => !s.pinned && !s.collection)
  const nav = [
    { items: [{ key: 'new', label: 'New chat', icon: 'solar:pen-new-square-linear', onClick: newChat }] },
    ...(live.some((s) => s.pinned) ? [{ label: 'Pinned', items: live.filter((s) => s.pinned).map(itemOf) }] : []),
    ...collections.map((c) => ({ label: c, items: live.filter((s) => !s.pinned && s.collection === c).map(itemOf) })).filter((g) => g.items.length),
    { label: 'Conversations', items: loose.slice(0, shownConversations).map(itemOf) },
  ]
  const searchItems: SearchItem[] = [
    { key: 'a:new', label: 'New chat', icon: 'solar:pen-new-square-linear', group: 'Go to', onSelect: newChat },
    { key: 'a:agents', label: 'Agents', icon: 'solar:widget-linear', group: 'Go to', onSelect: () => page('agents') },
    { key: 'a:activity', label: 'Activity', icon: 'solar:pulse-linear', group: 'Go to', onSelect: () => page('activity') },
    { key: 'a:connections', label: 'Connections', icon: 'solar:link-round-linear', group: 'Go to', onSelect: () => page('connections') },
    ...sessions.map((s) => ({ key: `s:${s.session}`, label: titleOf(s), sub: [agentOf(s.agent).name, s.collection].filter(Boolean).join(' · '), group: s.archived ? 'Archived' : 'Conversations', onSelect: () => go(s.session) })),
  ]
  const sideActions = <>
    <button type="button" className="sa-icon-btn sa-icon-btn--lg" data-on={activityView} onClick={toggleActivity} title={activityView ? 'Back to the conversations (⌥⌘U)' : 'What is running, and lately (⌥⌘U)'} aria-label="Activity" aria-pressed={activityView}><Icon icon="solar:bell-linear" /></button>
    <button type="button" className="sa-icon-btn sa-icon-btn--lg" onClick={() => setSearching(true)} title="Search (⌘K)" aria-label="Search"><Icon icon="solar:magnifer-linear" /></button>
  </>
  const moreConversations = loose.length > shownConversations
    ? <button type="button" className="sa-sidelist__more" onClick={() => setShownConversations((n) => n + 30)}>Show more</button> : null
  const named = agents.filter((a) => !a.isDefault)
  const places: RailPlace[] = [
    { key: 'home', label: 'Home', icon: 'solar:home-angle-linear', onClick: () => page('home'), actions: sideActions,
      panel: activityView ? <><NavList groups={[nav[0]!]} /><SideActivity request={request} subscribeLive={subscribeLive} /></> : <><NavList groups={nav} />{moreConversations}</> },
    { key: 'agents', label: 'Agents', icon: 'solar:widget-linear', onClick: () => page('agents'), actions: sideActions,
      panel: <NavList groups={[
        { items: [{ key: 'agents', label: 'All agents', icon: 'solar:list-linear', active: onPages && root === 'agents', onClick: () => page('agents') }] },
        { label: 'Agents', items: named.map((a) => ({ key: `a:${a.id}`, label: a.name, icon: a.look.icon ?? 'solar:widget-linear', active: startAgent === a.id || (!!sessionId && current === a.id), onClick: () => go(`s/${a.id}`) })) },
      ]} /> },
    { key: 'connections', label: 'Connections', icon: 'solar:link-round-linear', onClick: () => page('connections') },
  ]
  const railAt = sessionId || (onPages && (root === 'home' || !root)) ? 'home' : startAgent || (onPages && root?.startsWith('agent')) ? 'agents' : onPages && root?.startsWith('connection') ? 'connections' : ''
  const [showKeys, setShowKeys] = useState(false)
  // The ask bar is at the foot of every page alike: in a conversation it asks there; anywhere else it starts one.
  const [starting, setStarting] = useState('')
  const [startBeats, setStartBeats] = useState<{ text: string; at: number }[]>([])
  const startWith = useCallback(async (text: string) => {
    const t = text.trim(); if (!t || starting) return
    const sid = newId()
    setStarting(t); setStartBeats([{ text: 'Finding the agent for this question…', at: Date.now() }])
    const m = await request({ t: 'session:start', session: sid, text: t, kind: 'language' }, (p: any) => { if (p?.t === 'narration' && p.text) setStartBeats((b) => [...b, { text: String(p.text), at: Date.now() }]) })
    setStarting(''); setStartBeats([])
    if (m?.t === 'session:view') { opened.set(sid, m as SessionMsg); setListTick((n) => n + 1); go(sid) } else notify(m?.reason ?? 'The question could not be asked', 'refused')
  }, [request, starting, go])

  const [artifacts, setArtifacts] = useState<Artifact[]>([])
  const [artifactsTick, setArtifactsTick] = useState(0)
  useEffect(() => { setArtifacts([]) }, [sessionId])
  const pagesEnv = useMemo(() => ({ request, subscribeLive, projectId, token, scopes, caps, agents, sessions, go, me, projectName, keep, onSignOut }), [request, subscribeLive, projectId, token, scopes, caps, agents, sessions, go, me, projectName, keep, onSignOut])
  const programEnv = useMemo(() => ({ request }), [request])
  return (
    <>
      <AppShell
        sidebar={(collapsed, toggle) => (
          <RailSidebar name={projectName} places={places} current={railAt} pinned={!collapsed} onPin={(p) => toggle(!p)}
            foot={<UserProfile name={me.name} email={me.email}
              menu={<>
                <MenuItem icon="solar:user-circle-linear" label="Profile" onClick={() => page('profile')} />
                <MenuItem icon="solar:settings-linear" label="Settings" onClick={() => page('settings')} />
                <MenuRule />
                <MenuItem icon="solar:widget-linear" label="Agents" onClick={() => page('agents')} />
                <MenuItem icon="solar:link-round-linear" label="Connections" onClick={() => page('connections')} />
                <MenuItem icon="solar:pulse-linear" label="Activity" onClick={() => page('activity')} />
                <MenuRule />
                <MenuItem icon="solar:question-circle-linear" label="Help" sub={<>
                  <MenuItem icon="solar:keyboard-linear" label="Keyboard shortcuts" onClick={() => setShowKeys(true)} />
                </>} />
                {onSignOut && <MenuItem icon="solar:logout-2-linear" label="Log out" onClick={onSignOut} />}
              </>} />} />
        )}
        status={<ConnectionStatus status={connected ? 'open' : /access/.test(status) ? 'rejected' : 'reconnecting'} message={connected ? undefined : status || undefined} />}
        artifacts={sessionId ? <>
          <Artifacts items={artifacts} onReveal={(b) => revealBlock(b)} />
          <ForkAgent session={sessionId} request={request} onMade={() => setArtifactsTick((n) => n + 1)} />
          {caps.includes('project.audit') && <AgentWork key={sessionId} session={sessionId} send={send} subscribeLive={subscribeLive} />}
        </> : undefined}
        artifactsCount={artifacts.length}>
        <ProgramEnvContext.Provider value={programEnv}>
          {source
            ? <ThreadSteps key={sessionId ?? `view:${path}`} source={source} session={sessionId} request={request} fetchFile={fetchFile} agentOf={agentOf} viewAgent={startAgent} viewStart={startKey}
                onArtifacts={setArtifacts} artifactsTick={artifactsTick} onUsed={onUsed} onKept={onKept} />
            : <PagesContext.Provider value={pagesEnv}>
                <LocalThread blocks={PAGE_BLOCKS} home={pending ?? { type: 'home' }} onRoot={(r) => { setRoot(r); if (r) setPending(null) }} address={(b) => (b.type === 'home' ? '/w' : PAGES.includes(b.type) ? `/w?page=${b.type}` : null)} />
                <AskBar onAsk={(t) => void startWith(t)} busy={!!starting} placeholder="Ask anything"
                  working={starting ? <><span className="sa-label">Working on: {starting}</span><BeatRows beats={startBeats.slice(-3)} live /></> : undefined} />
              </PagesContext.Provider>}
        </ProgramEnvContext.Provider>
      </AppShell>
      {showKeys && <Dialog title="Keyboard shortcuts" onClose={() => setShowKeys(false)}
        actions={<button type="button" className="sa-btn" onClick={() => setShowKeys(false)}>Close</button>}><KeyboardShortcuts /></Dialog>}
      {naming && <Dialog title={naming.what === 'name' ? 'Rename the conversation' : 'A new collection'} onClose={() => setNaming(null)}
        actions={<><button type="button" className="sa-btn" onClick={() => setNaming(null)}>Cancel</button>
          <button type="button" className="sa-btn sa-btn--primary" disabled={!naming.value.trim()} onClick={() => { const n = naming; setNaming(null); void keep(n.session, n.what === 'name' ? { name: n.value } : { collection: n.value }) }}>{naming.what === 'name' ? 'Rename' : 'Keep it there'}</button></>}>
        <input className="sa-input" autoFocus value={naming.value} maxLength={naming.what === 'name' ? 200 : 80} placeholder={naming.what === 'name' ? 'What this conversation is about' : 'The collection’s name'}
          onChange={(e) => setNaming({ ...naming, value: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter' && naming.value.trim()) { const n = naming; setNaming(null); void keep(n.session, n.what === 'name' ? { name: n.value } : { collection: n.value }) } }} />
      </Dialog>}
      {searching && <Search items={searchItems} placeholder="Search conversations, or go to…" onClose={() => setSearching(false)} />}
      <Toasts />
    </>
  )
}

/** The pages of the user UI that have an address of their own (/w?page=…). */
const PAGES = ['agents', 'activity', 'connections', 'profile', 'settings']

/** One of the person's conversations, as their UserDO keeps it. */
export type Conversation = { session: string; agent: string; title: string; updated?: string; name?: string; pinned?: number | boolean; archived?: number | boolean; collection?: string }

/** The sidebar's activity view: what is running for this person now, then what ran today, then earlier. */
function SideActivity({ request, subscribeLive }: { request: Request; subscribeLive: (fn: (m: any) => void) => () => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  useEffect(() => { void request({ t: 'activity:list' }).then((r: any) => setRows(Array.isArray(r?.activities) ? r.activities : [])) }, [request])
  useEffect(() => subscribeLive((m) => { if (m?.t === 'activity' && m.activity?.id) setRows((prev) => [m.activity, ...(prev ?? []).filter((x) => x.id !== m.activity.id)].slice(0, 100)) }), [subscribeLive])
  const words = (v: unknown) => String(v ?? '').replace(/\s+in session ses-[\w-]+/g, '').replace(/\*\*|__|`/g, '').replace(/(^|\s)_([^_]+)_(?=\s|[.,;:!?]|$)/g, '$1$2').trim()
  const at = (a: any) => Date.parse(a.updated_at ?? a.updatedAt ?? '') || 0
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const groups: [string, any[]][] = rows ? [
    ['Running', rows.filter((a) => a.state === 'running')],
    ['Today', rows.filter((a) => a.state !== 'running' && at(a) >= today.getTime())],
    ['Earlier', rows.filter((a) => a.state !== 'running' && at(a) < today.getTime())],
  ] : []
  if (!rows) return <p className="sa-sidelist__none">Reading what ran…</p>
  return (
    <div className="sa-sidelist">
      {groups.map(([label, list]) => (label === 'Running' || list.length) ? (
        <div key={label}>
          <div className="sa-label sa-sidelist__head">{label}</div>
          {list.length ? list.slice(0, 30).map((a) => (
            <div key={a.id} className="sa-sidelist__item" title={words(a.title)}>
              <span className="sa-sidelist__title">{words(a.title)}</span>
              {(a.progress || a.detail) && <span className="sa-sidelist__line">{words(a.progress ?? a.detail)}</span>}
            </div>
          )) : <p className="sa-sidelist__none">Nothing running</p>}
        </div>
      ) : null)}
    </div>
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
    await recordKept(request, session, { t: 'artifact:record', session, kind: 'agent', title: `Agent: ${t}`, body: { agent: m.agent, domain: m.domain, concept: m.concept, scope: m.scope, reasoning: 'made from this session: its questions and the steps taken' } })
    notify(`${t} made — yours until it is published`, 'note'); setOpen(false); setTitle(''); onMade()
  }
  if (!open) return <button className="sa-btn sa-btn--link sa-artifacts__make" title="An agent that knows what this session learned: the questions asked and the steps taken" onClick={() => setOpen(true)}>Make an agent from this session</button>
  return (
    <Form onSubmit={() => void fork()} actions={<><button type="button" className="sa-btn" onClick={() => setOpen(false)}>Cancel</button><button className="sa-btn sa-btn--primary">Make the agent</button></>}>
      <Field label="The new agent's title"><input id="sa-fork-title" className="sa-input" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus required /></Field>
    </Form>
  )
}

/** What the session's agent (its composer) did, as it does it: the raw work, for whoever administers the project. The
 *  log reaches only the session's owner, so this shows the work of one's own sessions. */
type WorkEvent = { id: string; kind: string; text?: string; output?: string; title?: string; done?: boolean }
function AgentWork({ session, send, subscribeLive }: { session: string; send: (p: Record<string, unknown>) => void; subscribeLive: (fn: (m: any) => void) => () => void }) {
  const [open, setOpen] = useState(false)
  const [events, setEvents] = useState<WorkEvent[]>([])
  useEffect(() => {
    if (!open) return
    send({ t: 'log:attach', channel: 'composer-log', session })
    const off = subscribeLive((m) => {
      if (m?.sid !== session || m?.lane !== 'composer') return
      if (m.t === 'agent:event' && m.ev && typeof m.ev.id === 'string') {
        const ev = m.ev as WorkEvent
        setEvents((list) => { const i = list.findIndex((e) => e.id === ev.id); if (i < 0) return [...list, ev].slice(-300); const next = list.slice(); next[i] = { ...next[i], ...ev }; return next })
      } else if (m.t === 'agent:chunk' && typeof m.text === 'string') {
        setEvents((list) => { const last = list[list.length - 1]; return last?.kind === 'output' ? [...list.slice(0, -1), { ...last, text: ((last.text ?? '') + m.text).slice(-20000) }] : [...list, { id: `out-${list.length}`, kind: 'output', text: m.text }].slice(-300) })
      }
    })
    return () => { off(); send({ t: 'log:detach', channel: 'composer-log' }) }
  }, [open, session, send, subscribeLive])
  if (!open) return <button className="sa-btn sa-btn--link sa-artifacts__make" title="The session agent's own work: its tool calls and output, as it works" onClick={() => setOpen(true)}>Watch the agent work</button>
  return (
    <div className="sa-agentwork">
      <div className="sa-agentwork__head"><span>The agent's work</span><button type="button" className="sa-btn sa-btn--link" onClick={() => setOpen(false)}>Hide</button></div>
      {events.length === 0
        ? <div className="sa-agentwork__empty">Shown from the next question on.</div>
        : <ol className="sa-agentwork__list">{events.map((e) => (
            <li key={e.id} data-kind={e.kind}><span className="sa-agentwork__kind">{e.title || e.kind}</span>{(e.text || e.output) && <pre>{String(e.text || e.output).slice(-4000)}</pre>}</li>
          ))}</ol>}
    </div>
  )
}

type Pending = { kind: 'new'; from: string | null; label: string; beats?: { text: string; at: number }[] } | { kind: 'edit'; block: string }

/** A thread of steps, whichever home it has: a session (the platform's) or an agent's view (this browser's). */
function ThreadSteps({ source, session, request, fetchFile, agentOf, viewAgent, viewStart, onArtifacts, artifactsTick, onUsed, onKept }: {
  source: ThreadSource; session: string | null; request: Request; fetchFile: FetchFile; agentOf: (id: string) => WorkAgent
  viewAgent: string | null; viewStart: string | null
  onArtifacts: (a: Artifact[]) => void; artifactsTick: number; onUsed: () => void; onKept: (session: string, msg: SessionMsg | null) => void
}) {
  const [msg, setMsg] = useState<SessionMsg | null>(() => (session ? opened.get(session) ?? null : null))
  const [refused, setRefused] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [paths, setPaths] = useState<Record<string, Recognised | null>>({})
  const [deciding, setDeciding] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const seq = useRef(0)
  const view = msg?.view
  const agent = agentOf(view?.agent ?? viewAgent ?? '')

  // A reply is shown once it is ready to show whole; a later reply wins over an earlier one still getting ready.
  const accept = useCallback(async (m: SessionMsg) => {
    const n = ++seq.current
    if (m?.t === 'session:refused') { setRefused(m.reason ?? 'The engine refused that.'); return }
    if (m?.t !== 'session:view' || !m.view || m.result?.stale) return
    const recognised = await ready(m, fetchFile, source)
    if (n !== seq.current) return
    setRefused(''); setMsg(m)
    if (recognised !== undefined) setPaths((p) => ({ ...p, [m.view!.leaf]: recognised }))
  }, [fetchFile, source])

  useEffect(() => {
    // A session just kept from a view arrives with what was shown; the hand-over is dropped a moment later.
    if (session && opened.get(session)) { setTimeout(() => opened.delete(session), 5000); return }
    void source.load().then(accept)
  }, [session, source, accept])
  // A view's steps are in the history: Back and Forward bring its thread back as it was there.
  useEffect(() => {
    if (source.kind !== 'view') return
    const on = (e: PopStateEvent) => { if (viewFromHistory(e.state)) void source.load().then(accept) }
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [source, accept])
  // Paths from a step reached without them (going back to a step, a branch).
  useEffect(() => {
    if (!view?.leaf || view.leaf in paths) return
    const leaf = view.leaf
    void source.paths(view, leaf).then((m) => setPaths((p) => ({ ...p, [leaf]: m?.t === 'decision:paths' ? m : null })), () => setPaths((p) => ({ ...p, [leaf]: null })))
  }, [view, source, paths])

  const loadArtifacts = useCallback(() => (!session ? Promise.resolve(onArtifacts([])) : request({ t: 'artifact:list', session }).then((m) => {
    const blocks = view?.blocks ?? []
    onArtifacts((Array.isArray(m?.artifacts) ? m.artifacts : []).map((a: any) => ({ id: a.id, kind: a.kind, title: a.title, at: a.at, by: a.by, version: a.version, status: a.status,
      summary: a.body?.reasoning ? `${a.body.reasoning}` : undefined, step: a.block ? { block: a.block, step: pathOf(blocks as any, view?.leaf ?? '').indexOf(a.block) + 1 || 0 } : undefined })))
  })), [request, session, onArtifacts, view])
  useEffect(() => { if (view) void loadArtifacts() }, [view?.id, view?.blocks.length, artifactsTick])   // eslint-disable-line react-hooks/exhaustive-deps

  // An intent: from the current step and to it, the step changes in place (dimmed while it works); otherwise a new step
  // appears at once where it will stand, as a skeleton, and the answer fills it.
  const intent = useCallback(async (payload: Record<string, unknown>, label: string) => {
    if (pending || !view) return
    const block = String(payload.block ?? view.leaf)
    const opens = payload.to === 'new' || block !== view.leaf
    setPending(opens ? { kind: 'new', from: block, label } : { kind: 'edit', block })
    if (opens) setTimeout(() => revealBlock('pending'), 30)
    const m = await source.intent(payload)
    await accept(m)
    setPending(null)
    if (m?.t === 'session:view' && session) onUsed()
    if (opens && m?.view?.leaf) setTimeout(() => revealBlock(m.view!.leaf), 30)
  }, [pending, view, source, session, accept, onUsed])
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
    // Asking the agent is talking to it: a view is kept as a session first (its path replayed), then asked.
    let m: SessionMsg | null = null, kept: string | undefined
    try {
      const r = await source.ask(t, block, (p) => {
        if (p?.t === 'narration' && p.text) setPending((x) => (x?.kind === 'new' ? { ...x, beats: [...(x.beats ?? []), { text: String(p.text), at: Date.now() }] } : x))
      })
      m = r.msg; kept = r.session
    } catch (e: any) { setRefused(e?.message ?? String(e)) }
    finally { setPending(null) }
    // Kept as a session: go to it — answered or not, the session is where the question now lives.
    if (kept) { if (m?.t === 'session:view') onKept(kept, m); else { notify(m?.reason ?? 'The question was not answered; it is kept in its session', 'refused'); onKept(kept, null) }; return }
    if (!m) return
    await accept(m)
    if (m?.t === 'session:view') onUsed()
    if (m.view?.leaf) setTimeout(() => revealBlock(m!.view!.leaf), 30)
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
            busy={editing} icon={asked ? 'solar:chat-round-dots-linear' : agent.look.icon} accent={asked ? 'var(--series-2)' : accentOf(agent.look.accent)}>
            {uis.filter((u) => u.head?.length).map((u) => <ProgramBlock key={`h:${u.hash}`} program={u} only={u.head} slice={view.states[id]?.[u.package]} state={view.states[id]} fetchFile={fetchFile} />)}
            <div className={`sa-stack${editing ? ' sa-busy' : ''}`}>
              {answer ? <Answer markdown={lead.rest} blocks={answer.blocks}
                onRow={rowPackage(id) ? (move, row) => void intent({ call: { package: rowPackage(id)!, fn: 'row', params: { move, row } }, to: 'new', block: id }, String(row[(move as any).label] ?? '')) : undefined} />
                : <p className="sa-note sa-section__empty">Nothing shown yet. Ask below.</p>}
              <Paths block={id} recognised={paths[id] ?? null} offered={isLeaf ? offered : []} onAsk={(t) => ask(t, id)} />
              {uis.map((u) => { const body = u.blocks.filter((b) => !u.head?.includes(b)); return body.length ? <ProgramBlock key={`b:${u.hash}`} program={u} only={body} slice={view.states[id]?.[u.package]} state={view.states[id]} fetchFile={fetchFile} /> : null })}
              {isLeaf && (deciding === id
                ? <DecisionForm onCancel={() => setDeciding(null)} onRecord={async (body, approval) => {
                    // A decision rests on a kept step: a view is kept as a session first, and the decision recorded there.
                    const k = session ? { session, leaf: id, msg: null as SessionMsg | null } : await source.keep()
                    if (!session && k.msg?.t !== 'session:view') { notify(k.msg?.reason ?? 'The view could not be kept', 'refused'); return }
                    const m = await recordKept(request, k.session, { t: 'artifact:record', session: k.session, block: k.leaf, kind: 'decision', body, approval })
                    if (m?.t !== 'artifact:recorded') { notify(m?.reason ?? 'The decision was not recorded', 'refused'); return }
                    notify('Decision recorded', 'note'); setDeciding(null)
                    if (!session && k.msg) onKept(k.session, k.msg); else void loadArtifacts()
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
          cause={pending.beats ? undefined : pending.label} from={fromIdx >= 0 ? { id: path[fromIdx], step: fromIdx + 1, onPath: true } : undefined} onReveal={revealBlock}
          icon={pending.beats ? 'solar:chat-round-dots-linear' : agent.look.icon} accent={pending.beats ? 'var(--series-2)' : accentOf(agent.look.accent)}>
          {pending.beats ? <div className="sa-card" aria-busy="true" aria-live="polite"><BeatRows beats={pending.beats} live /></div> : <StepSkeleton />}
        </BlockFrame>
      ) })
    }
    return steps
  }, [view, msg, paths, pending, deciding, agent, fetchFile, request, session, loadArtifacts, intent])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={root} className="sa-work">
      {refused && <p className="sa-alert" role="alert"><span className="sa-alert__text">{refused}</span></p>}
      <Steps items={items} onSwitch={(b) => void source.goto(b).then(accept)}
        empty={!refused && (session ? <StepSkeleton label="Opening the session" /> : (
          <BlockFrame id="opening" step={1} label={agent.name} title={(viewStart && agent.starts.find((x) => x.key === viewStart)?.label) || agent.look.main?.label || agent.name}
            subtitle={agent.look.says} busy icon={agent.look.icon} accent={accentOf(agent.look.accent)}><StepSkeleton label="Opening" /></BlockFrame>
        ))}
        after={view && <AskBar onAsk={(t) => void ask(t)} busy={!!pending} placeholder="Ask about these numbers…" />} />
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
