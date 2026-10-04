// THREADS — a session of blocks on one agent's programs, drawn from the engine's thread:view. Each block shows its
// answer with the one answer component (handed in) and the intents the agent's programs offer; a control is an
// <Intent>, and one listener sends whichever is pressed as thread:intent. Changing an earlier block branches the
// thread (the engine decides; this only names the block a control is in). The session id is kept per agent in this
// browser, so a reload lands on the same thread.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Intent, listenIntents, Thread, type ScreenIntent } from '@superatom/ui'
import './threads.css'

/** What the engine sends for a thread (vm/apps/engine/thread-seam.ts). */
export interface ThreadMsg {
  t: string
  reqId?: string
  reason?: string
  view?: { id: string; agent: string; leaf: string; blocks: { id: string; parent: string | null; answer: string | null; stateHash: string }[] }
  cards?: Record<string, unknown>
  actions?: { package: string; label: string; intent: ScreenIntent }[]
  result?: { block: string; opened: boolean; stale?: boolean }
}

export interface ThreadsProps {
  agent: string
  agentName: string
  send: (payload: Record<string, unknown>) => void
  /** Thread messages as they arrive; returns a function that stops listening. */
  subscribe: (fn: (m: ThreadMsg) => void) => () => void
  /** The answer component. */
  renderAnswer: (card: unknown) => ReactNode
}

const storeKey = (agent: string) => `sa-thread:${location.host}:${agent}`
const newId = () => `thr-${crypto.randomUUID()}`
const readSaved = (agent: string) => { try { return localStorage.getItem(storeKey(agent)) } catch { return null } }
const save = (agent: string, sid: string) => { try { localStorage.setItem(storeKey(agent), sid) } catch { /* storage blocked */ } }

export default function Threads({ agent, agentName, send, subscribe, renderAnswer }: ThreadsProps) {
  const [session, setSession] = useState<string>(() => readSaved(agent) ?? newId())
  const [msg, setMsg] = useState<ThreadMsg | null>(null)
  const [refused, setRefused] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(new Map<string, 'get' | 'open' | 'intent' | 'goto'>())
  const root = useRef<HTMLDivElement>(null)

  const ask = useCallback((kind: 'get' | 'open' | 'intent' | 'goto', payload: Record<string, unknown>) => {
    const reqId = `${kind}-${Math.random().toString(36).slice(2, 10)}`
    pending.current.set(reqId, kind)
    setBusy(kind !== 'get')
    send({ t: `thread:${kind}`, ...payload, reqId })
  }, [send])

  // A different agent: its own saved thread, or a new one.
  useEffect(() => { const sid = readSaved(agent) ?? newId(); setSession(sid); setMsg(null); setRefused('') }, [agent])
  useEffect(() => { ask('get', { session }) }, [session, ask])

  useEffect(() => subscribe((m) => {
    const kind = m.reqId ? pending.current.get(m.reqId) : undefined
    if (!kind) return
    pending.current.delete(m.reqId!)
    setBusy(false)
    if (m.t === 'thread:refused') {
      // A thread this browser remembered but the engine does not have (or a new id): start it.
      if (kind === 'get' && /^there is no session/.test(m.reason ?? '')) { ask('open', { session, agent }); return }
      setRefused(m.reason ?? 'The engine refused that.')
      return
    }
    if (m.t === 'thread:view' && m.view?.id === session) {
      setRefused('')
      if (m.result?.stale) return   // a newer intent's answer is on its way
      setMsg(m)
      save(agent, session)
    }
  }), [subscribe, session, agent, ask])

  // The one listener for every control on this thread.
  useEffect(() => {
    const el = root.current
    if (!el) return
    return listenIntents(el, (i) => ask('intent', { session, ...i }))
  }, [session, ask])

  const view = msg?.view
  const renderBlock = (id: string) => {
    const block = view?.blocks.find((b) => b.id === id)
    const card = block?.answer ? msg?.cards?.[block.answer] : undefined
    return (
      <div className="sa-thread-block">
        {card ? renderAnswer(card) : <p className="sa-thread-empty">Nothing shown yet. Run it to see the answer.</p>}
        {!!msg?.actions?.length && (
          <div className="sa-thread-actions">
            {msg.actions.map((a, n) => <Intent key={n} {...a.intent} block={id} className="sa-thread-action">{a.label}</Intent>)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="sa-threads" ref={root}>
      <header className="sa-threads-head">
        <h1>{agentName}</h1>
        {busy && <span className="sa-threads-busy" role="status">Working…</span>}
        <button type="button" className="sa-thread-action" onClick={() => { const sid = newId(); setMsg(null); setSession(sid) }}>New thread</button>
      </header>
      {refused && <p className="sa-threads-refused" role="alert">{refused}</p>}
      {view ? <Thread session={view} renderBlock={renderBlock} onGoTo={(block) => ask('goto', { session, block })} />
        : !refused && <p className="sa-thread-empty">Opening the thread…</p>}
    </div>
  )
}
