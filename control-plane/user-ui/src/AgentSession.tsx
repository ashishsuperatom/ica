// AN AGENT'S SESSION — its blocks on the agent's programs, drawn from the engine's session:view. A session's blocks are
// a tree; the screen shows one thread of it (the path down to the current block). Each block shows its
// answer with the one answer component (handed in) and the intents the agent's programs offer; a control is an
// <Intent>, and one listener sends whichever is pressed as session:intent. Changing an earlier block branches the
// session into another thread (the engine decides; this only names the block a control is in). The session id is kept
// per agent in this browser, so a reload lands on the same session.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Intent, listenIntents, Thread, type ScreenIntent } from '@superatom/ui'
import ProgramBlock, { type ProgramUI } from './ProgramBlock'
import './session.css'

/** What the engine sends for a session (vm/apps/engine/session-seam.ts). */
export interface SessionMsg {
  t: string
  reqId?: string
  reason?: string
  view?: { id: string; agent: string; leaf: string; blocks: { id: string; parent: string | null; answer: string | null; stateHash: string }[]; states?: Record<string, Record<string, unknown>> }
  uis?: ProgramUI[]
  hash?: string
  path?: string
  text?: string
  cards?: Record<string, unknown>
  actions?: { package: string; label: string; intent: ScreenIntent }[]
  result?: { block: string; opened: boolean; stale?: boolean }
}

export interface AgentSessionProps {
  /** The project and the person's token, to load programs' views from the platform. */
  projectId?: string
  token?: string | null
  agent: string
  agentName: string
  send: (payload: Record<string, unknown>) => void
  /** Thread messages as they arrive; returns a function that stops listening. */
  subscribe: (fn: (m: SessionMsg) => void) => () => void
  /** The answer component. */
  renderAnswer: (card: unknown) => ReactNode
}

const storeKey = (agent: string) => `sa-session:${location.host}:${agent}`
const newId = () => `ses-${crypto.randomUUID()}`
const readSaved = (agent: string) => { try { return localStorage.getItem(storeKey(agent)) } catch { return null } }
const save = (agent: string, sid: string) => { try { localStorage.setItem(storeKey(agent), sid) } catch { /* storage blocked */ } }

export default function AgentSession({ agent, agentName, send, subscribe, renderAnswer, projectId, token }: AgentSessionProps) {
  const [session, setSession] = useState<string>(() => readSaved(agent) ?? newId())
  const [msg, setMsg] = useState<SessionMsg | null>(null)
  const [refused, setRefused] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(new Map<string, 'get' | 'open' | 'intent' | 'goto'>())
  const files = useRef(new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>())
  const root = useRef<HTMLDivElement>(null)

  const ask = useCallback((kind: 'get' | 'open' | 'intent' | 'goto', payload: Record<string, unknown>) => {
    const reqId = `${kind}-${Math.random().toString(36).slice(2, 10)}`
    pending.current.set(reqId, kind)
    setBusy(kind !== 'get')
    send({ t: `session:${kind}`, ...payload, reqId })
  }, [send])

  // A different agent: its own saved session, or a new one.
  useEffect(() => { const sid = readSaved(agent) ?? newId(); setSession(sid); setMsg(null); setRefused('') }, [agent])
  useEffect(() => { ask('get', { session }) }, [session, ask])

  // A program's file, asked over the hub; answered by reqId.
  // A program's file: from the platform (R2, immutable by hash, the engine not needed), else from the engine over the hub.
  const fromEngine = useCallback((hash: string, path: string) => new Promise<string>((resolve, reject) => {
    const reqId = `file-${Math.random().toString(36).slice(2, 10)}`
    files.current.set(reqId, { resolve, reject })
    send({ t: 'session:file', hash, path, reqId })
  }), [send])
  const fetchFile = useCallback(async (hash: string, path: string) => {
    if (projectId) {
      const r = await fetch(`/api/projects/${encodeURIComponent(projectId)}/programs/${hash}/${path}`, { credentials: 'include', headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => null)
      if (r?.ok) return r.text()
    }
    return fromEngine(hash, path)
  }, [projectId, token, fromEngine])

  useEffect(() => subscribe((m) => {
    const f = m.reqId ? files.current.get(m.reqId) : undefined
    if (f) { files.current.delete(m.reqId!); if (typeof m.text === 'string') f.resolve(m.text); else f.reject(new Error(m.reason ?? 'the file did not come')); return }
    const kind = m.reqId ? pending.current.get(m.reqId) : undefined
    if (!kind) return
    pending.current.delete(m.reqId!)
    setBusy(false)
    if (m.t === 'session:refused') {
      // A session this browser remembered but the engine does not have (or a new id): start it.
      if (kind === 'get' && /^there is no session/.test(m.reason ?? '')) { ask('open', { session, agent }); return }
      setRefused(m.reason ?? 'The engine refused that.')
      return
    }
    if (m.t === 'session:view' && m.view?.id === session) {
      setRefused('')
      if (m.result?.stale) return   // a newer intent's answer is on its way
      setMsg(m)
      save(agent, session)
    }
  }), [subscribe, session, agent, ask])

  // The one listener for every control in this session.
  useEffect(() => {
    const el = root.current
    if (!el) return
    // A control inside a program's view does not know its block: the block it sits in is the one it means.
    return listenIntents(el, (i, at) => ask('intent', { session, ...i, block: i.block ?? at.closest('[data-block]')?.getAttribute('data-block') ?? undefined }))
  }, [session, ask])

  const view = msg?.view
  const renderBlock = (id: string) => {
    const block = view?.blocks.find((b) => b.id === id)
    const card = block?.answer ? msg?.cards?.[block.answer] : undefined
    return (
      <div className="sa-session-block">
        {card ? renderAnswer(card) : <p className="sa-session-empty">Nothing shown yet. Run it to see the answer.</p>}
        {msg?.uis?.filter((u) => u.blocks.length).map((u) => (
          <ProgramBlock key={u.hash} program={u} slice={view?.states?.[id]?.[u.package]} state={view?.states?.[id]} fetchFile={fetchFile} />
        ))}
        {!!msg?.actions?.length && (
          <div className="sa-session-actions">
            {msg.actions.map((a, n) => <Intent key={n} {...a.intent} block={id} className="sa-session-action">{a.label}</Intent>)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="sa-session" ref={root}>
      <header className="sa-session-head">
        <h1>{agentName}</h1>
        {busy && <span className="sa-session-busy" role="status">Working…</span>}
        <button type="button" className="sa-session-action" onClick={() => { const sid = newId(); setMsg(null); setSession(sid) }}>New session</button>
      </header>
      {refused && <p className="sa-session-refused" role="alert">{refused}</p>}
      {view ? <Thread session={view} renderBlock={renderBlock} onGoTo={(block) => ask('goto', { session, block })} />
        : !refused && <p className="sa-session-empty">Opening the session…</p>}
    </div>
  )
}
