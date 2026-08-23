import { useState, useEffect, useRef, useCallback } from 'react'
import { useSession, SignIn, UserButton, useUser } from '@clerk/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useClaudeTerminal } from './useClaudeTerminal'
import { ANSI, COLS, ROWS } from './termColors'

// Cloud mode: VITE_HUB_URL set (e.g. wss://superatom.site). The page is served at
// /u behind the worker; it logs in via Clerk, exchanges for our JWT, and connects to
// the hub at wss://<hub>/_ws/<projectId>?token=… with envelope-wrapped messages.
// Local dev: VITE_HUB_URL unset → talk straight to the code-engine, no auth/envelope.
// On *.superatom.site the worker injects window.__HUB_URL__ / __PROJECT_ID__ into the
// HTML (subdomain → projectId, resolved server-side). Those win; otherwise fall back to
// the build-time VITE_HUB_URL (superatom.site path) and ?project=.
const INJECTED_HUB = (globalThis as any).__HUB_URL__ as string | undefined
const HUB   = INJECTED_HUB ?? (import.meta.env.VITE_HUB_URL as string | undefined)
const CLOUD = !!HUB
const VM_WS  = import.meta.env.VITE_VM_WS  ?? 'ws://localhost:5050'
const VM_HTTP = VM_WS.replace('ws://', 'http://').replace('wss://', 'https://')

// Cloud auth gate — only rendered inside <ClerkProvider> (main.tsx). Logs in, exchanges
// the Clerk session for our JWT, reads the project from ?project=, then renders <App>.
export function CloudGate() {
  const { isSignedIn, session } = useSession()
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('sa-token'))
  const projectId = (globalThis as any).__PROJECT_ID__ ?? new URLSearchParams(location.search).get('project') ?? ''
  useEffect(() => {
    if (token || !session) return
    session.getToken().then(async (ct: string | null) => {
      try {
        const r = await fetch('/api/auth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clerkToken: ct }) })
        if (!r.ok) return
        const { token: t } = await r.json(); localStorage.setItem('sa-token', t); setToken(t)
      } catch {}
    })
  }, [session, token])

  if (!isSignedIn) return <div style={{ maxWidth: 420, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui' }}><h2>Superatom</h2><SignIn /></div>
  if (!projectId) return <div style={{ maxWidth: 480, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui', color: '#8a8276' }}>No project selected. Open this app with <code>?project=&lt;id&gt;</code>.</div>
  if (!token)     return <div style={{ maxWidth: 420, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui', color: '#8a8276' }}>Signing in…</div>
  return <App token={token} projectId={projectId} />
}

type FeedItem =
  | { id: string; type: 'user-msg'; text: string }
  | { id: string; type: 'step'; text: string }
  | { id: string; type: 'narrative'; text: string }
  | { id: string; type: 'component'; tag: string; vTag: string; code: string; data: any }
  | { id: string; type: 'answer'; category?: string; answer: any; timing?: { ms: number; classifyMs?: number; modelMs?: number }; qid?: string; at?: number }   // the analyst's structured result, rendered as a card (qid = the question id; at = when the answer arrived)
  | { id: string; type: 'error'; text: string }

export function App({ token, projectId = 'default' }: { token?: string | null; projectId?: string } = {}) {
  const [feed, setFeed]               = useState<FeedItem[]>([])
  const [suggestions, setSuggestions] = useState<{ title?: string; groups: Array<{ concept: string; questions: string[] }> }>({ groups: [] })
  const [busy, setBusy]               = useState(false)
  const [connected, setConnected]     = useState(false)
  const [status, setStatus]           = useState('')
  const [logOpen, setLogOpen]   = useState(true)   // Claude live-output drawer open by default
  const [hasLog, setHasLog]     = useState(false)
  const [semHasLog, setSemHasLog] = useState(false)
  const [semStatus, setSemStatus] = useState('')
  const [semBusy, setSemBusy] = useState(false)   // modeler running (drives the codex "thinking" indicator)
  // The main view lives in the URL PATH at ROOT (the subdomain serves the user app for ANY path): a chat is
  // /c/<id>, the other views are /analyst and /semantic. A reload / shared link lands on the same view.
  // `navigate` pushes a history entry; popstate syncs it back.
  const readView = (): 'chat' | 'semantic' | 'analyst' => {
    const seg = location.pathname.replace(/\/+$/, '').split('/').pop()
    return seg === 'analyst' || seg === 'semantic' ? seg : 'chat'
  }
  const [view, setView] = useState<'chat' | 'semantic' | 'analyst'>(readView)
  const navigate = useCallback((v: 'chat' | 'semantic' | 'analyst') => {
    history.pushState(null, '', v === 'chat' ? `/c/${sidRef.current}${location.search}` : `/${v}`)
    setView(v)
  }, [])
  useEffect(() => {
    const onPop = () => setView(readView())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // Switching view → jump to the newest content (the feed/log didn't move while you were away). Chat scrolls
  // the page; the analyst/semantic event logs are their own scroll containers, so pin those to the bottom.
  useEffect(() => {
    if (view === 'chat') { scroll(true); return }
    const ref = view === 'analyst' ? anLogRef : view === 'semantic' ? semLogRef : null
    if (ref) { const pin = () => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight }; requestAnimationFrame(pin); setTimeout(pin, 60) }
  }, [view])   // eslint-disable-line react-hooks/exhaustive-deps
  // Analyst tab — the QA agent (classify → claude-code answers from the semantic model + units).
  const [anStatus, setAnStatus]     = useState('')
  const [anCategory, setAnCategory] = useState('')
  const [anQuestion, setAnQuestion] = useState('')
  const [anAnswer, setAnAnswer]     = useState<any>(null)   // structured out/answer.json
  const [anBusy, setAnBusy]         = useState(false)
  const [anEnriching, setAnEnriching] = useState<{ need: string; basis?: string } | null>(null)
  const [anProgress, setAnProgress] = useState('')   // clean live narration from the agent (no tool calls)
  // How to render the analyst's raw stream: 'pty' = a real terminal (claude-code) → xterm; 'events' =
  // discrete agent events (codex/SDK) → a plain event log (a terminal emulator makes no sense for these).
  const [anStreamKind, setAnStreamKind] = useState<'pty' | 'events'>('events')   // default = structured (claude via JSONL, codex); PTY is opt-in
  const anStreamKindRef = useRef<'pty' | 'events'>('events')
  const [anEvents, setAnEvents] = useState<AgentEvent[]>([])   // structured event log when kind === 'events' (codex)
  const [anHasPty, setAnHasPty] = useState(false)       // claude-code: a raw PTY terminal is also available (show the toggle)
  const [anTerminal, setAnTerminal] = useState(false)   // user opened the raw terminal → attach the PTY (lazily) and render xterm
  const [semStreamKind, setSemStreamKind] = useState<'pty' | 'events'>('events')   // default = structured; PTY is opt-in
  const [semEvents, setSemEvents] = useState<AgentEvent[]>([])
  const [semHasPty, setSemHasPty] = useState(false)       // modeler is claude → a raw terminal is available (show the toggle)
  const [semTerminal, setSemTerminal] = useState(false)   // user opened the raw terminal → attach the PTY lazily
  const anLogRef = useRef<HTMLDivElement>(null)
  const semLogRef = useRef<HTMLDivElement>(null)
  const [gaps, setGaps]             = useState<{ question: string; need: string; basis?: string; status: 'building' | 'done' }[]>([])
  const [role, setRole]         = useState<'user' | 'developer'>('developer')   // for now: everyone is developer (sees the agents)
  // Live as-you-type suggestions from the fast-router (optional; absent if not configured).
  const [liveSuggest, setLiveSuggest] = useState<{ items: any[]; intent?: any } | null>(null)
  const [multiline, setMultiline] = useState(false)   // composer layout: single row vs text-over-controls
  const multilineRef = useRef(false)
  const inputId       = useRef<string | null>(null)   // fresh per input focus → routes replies to this box
  const suggestSeq    = useRef(0)                      // per-keystroke; drop-stale
  const lastSuggestSeq = useRef(-1)
  const suggestTimer  = useRef<any>(null)
  const inputRef    = useRef<HTMLTextAreaElement>(null)
  const historyRef  = useRef<string[]>(
    (() => { try { return JSON.parse(localStorage.getItem(`sa-hist:${projectId}`) || '[]') } catch { return [] } })()
  )
  const historyIdx  = useRef(-1)
  const busyRef     = useRef(false)            // mirror of `busy` for use inside ws closures
  const watchdog    = useRef<any>(null)        // fires if the engine goes silent mid-turn
  const feedRef   = useRef<HTMLDivElement>(null)
  const termRef   = useRef<HTMLDivElement>(null)
  const xtermRef  = useRef<Terminal | null>(null)
  const fitRef    = useRef<FitAddon | null>(null)
  const wsRef     = useRef<WebSocket | null>(null)
  // The agent's RAW terminal stream is captured here for later use (debugging/telemetry) but is NEVER
  // rendered to the end user — the user-facing app shows only clean status, progress narration, and answers.
  const rawStreamRef = useRef('')
  // Semantic-model agent panel — its OWN terminal (a different agent than the QA/answer flow).
  const semTermRef  = useRef<HTMLDivElement>(null)
  const semXtermRef = useRef<Terminal | null>(null)
  // Analyst agent panel — its OWN terminal (fixed 120-col claude PTY width).
  const anTermRef   = useRef<HTMLDivElement>(null)
  const anXtermRef  = useRef<Terminal | null>(null)

  // ── Chat sessions ──────────────────────────────────────────────────────────
  // Each chat is a session with id in the URL as /c/<id>. The engine stores nothing, so the chat LIST
  // and each chat's FEED are persisted client-side in localStorage — so a reload restores your chats
  // and their answers. (The engine separately re-syncs the LIVE terminal + in-flight run on reconnect.)
  // Keys are SCOPED BY PROJECT so switching projects doesn't show another project's chats/feeds/history.
  const SKEY = `sa-sessions:${projectId}`, fkey = (id: string) => `sa-feed:${projectId}:${id}`
  const loadSessions = (): { id: string; title: string; updatedAt: number }[] => {
    try { return JSON.parse(localStorage.getItem(SKEY) || '[]') } catch { return [] }
  }
  const loadFeed = (id: string): FeedItem[] => { try { return JSON.parse(localStorage.getItem(fkey(id)) || '[]') } catch { return [] } }
  const [sessions, setSessions] = useState(loadSessions)
  const [proj, setProj] = useState<{ id?: string; name?: string } | null>(null)   // read-only project info from the ProjectDO (welcome)
  const newId = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2))
  const readSid = () => (location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)/)?.[1] ?? '')
  const [sessionId, setSessionId] = useState<string>(() => readSid() || newId())
  const sidRef = useRef(sessionId); sidRef.current = sessionId
  const vtagCtr = useRef(0)
  // Make sure the CHAT view's URL carries the session id — but don't clobber /analyst or /semantic on load.
  useEffect(() => { if (!readSid() && readView() === 'chat') history.replaceState(null, '', `/c/${sessionId}${location.search}`) }, [])   // keep ?project=
  // Restore THIS chat's feed on mount (reload survives) and jump straight to the bottom.
  useEffect(() => { const f = loadFeed(sessionId); if (f.length) { setFeed(f); scroll(true) } }, [])   // eslint-disable-line
  // Persist the feed + keep the chat in the sidebar list (title = first question) whenever it changes.
  useEffect(() => {
    if (!feed.length) return
    localStorage.setItem(fkey(sessionId), JSON.stringify(feed.slice(-100)))
    const title = feed.find(i => i.type === 'user-msg')?.text?.slice(0, 60) || 'New chat'
    setSessions(prev => {
      const rest = prev.filter(s => s.id !== sessionId)
      const next = [{ id: sessionId, title, updatedAt: Date.now() }, ...rest].slice(0, 50)
      localStorage.setItem(SKEY, JSON.stringify(next))
      return next
    })
  }, [feed, sessionId])

  // Fetch config (Mapbox token etc.) and set on globals
  useEffect(() => {
    fetch(`${VM_HTTP}/config`)
      .then(r => r.json())
      .then(cfg => {
        if (cfg.mapboxToken && (window as any).mapboxgl) {
          (window as any).mapboxgl.accessToken = cfg.mapboxToken
          if ((window as any).__libs?.mapboxgl) {
            (window as any).__libs.mapboxgl.accessToken = cfg.mapboxToken
          }
        }
      })
      .catch(() => {})
  }, [])

  // xterm setup
  useEffect(() => {
    const term = new Terminal({
      cursorBlink: false, fontSize: 12, convertEol: false, scrollback: 2000,
      theme: { background: '#1a1a1a', foreground: '#e6e2da', ...ANSI }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (termRef.current) {
      term.open(termRef.current)
      fit.fit()
    }
    xtermRef.current = term
    fitRef.current   = fit
    const ro = new ResizeObserver(() => fit.fit())
    if (termRef.current) ro.observe(termRef.current)
    return () => { ro.disconnect(); term.dispose() }
  }, [])

  // Both claude-code agent terminals (modeler + analyst) go through ONE shared module — same code path,
  // parameterized by `which` + `interactive`. Model-agnostic; codex/opencode would use their own view.
  useClaudeTerminal(semTermRef, semXtermRef, { which: 'semantic', interactive: true, send, autoAttach: false })   // default = structured; PTY attaches only on the Terminal toggle
  useClaudeTerminal(anTermRef, anXtermRef, { which: 'analyst', interactive: true, send, autoAttach: false })   // default = structured; PTY attaches only on the Terminal toggle

  // Keep the event log (SDK harnesses) pinned to the newest line as it streams.
  useEffect(() => {
    if (anStreamKind === 'events' && anLogRef.current) anLogRef.current.scrollTop = anLogRef.current.scrollHeight
  }, [anEvents, anStreamKind])

  // WS connection — direct to code-engine (local) or via the worker hub (cloud).
  useEffect(() => {
    if (CLOUD && !token) return   // wait for auth in cloud mode
    let closed = false
    function connect() {
      const url = CLOUD ? `${HUB}/_ws/${projectId}?token=${encodeURIComponent(token!)}` : VM_WS
      const ws = new WebSocket(url)
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        if (CLOUD) ws.send(JSON.stringify({ type: 'hello', token, role: 'runtime' }))
        else { send({ t: 'sessions:list', projectId }); send({ t: 'session:load', sessionId: sidRef.current }); send({ t: 'suggestions:req', projectId }); send({ t: 'term:attach', which: 'analyst' }) }
      }
      ws.onclose = () => {
        setConnected(false); setBusy(false); setStatus(''); clearWatchdog(); busyRef.current = false
        if (!closed) setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
      ws.onmessage = (e) => {
        const raw = JSON.parse(e.data)
        // Cloud: hub wraps payloads as { from, to, payload }. Unwrap to the code-engine
        // message; swallow hub control frames (welcome / machine waking).
        const msg = CLOUD ? raw.payload : raw
        if (!msg) return
        if (busyRef.current) armWatchdog()   // any message = engine alive → reset the watchdog
        if (msg.t === 'tick') return          // liveness ping only; nothing to render
        if (msg.t === 'welcome') {
          // Read-only project info from THIS project's DO (never the org DO). Extensible: more fields later.
          if (msg.project) { setProj(msg.project); if (msg.project.name) document.title = msg.project.name }
          // A (re)connect means any in-flight turn is gone — end it. If the engine is genuinely still
          // answering, the resync below re-sends analyst:status and the spinner comes back; we never keep a
          // stale one.
          if (busyRef.current) endTurn()
          send({ t: 'sessions:list', projectId }); send({ t: 'session:load', sessionId: sidRef.current }); send({ t: 'suggestions:req', projectId }); send({ t: 'term:attach', which: 'analyst' }); return
        }
        // Machine is being woken from suspend — that takes ~60s (wake + boot), so give the watchdog a long
        // window here so it doesn't false-fire before the engine even comes up.
        if (msg.t === 'machine:waking') { setStatus('Starting the engine…'); setAnStatus('Starting the engine…'); if (busyRef.current) armWatchdog(120000); return }
        if (msg.t === 'sessions:res') { if (msg.sessions?.length) setSessions(msg.sessions); return }   // engine stores none; keep our localStorage list
        if (msg.t === 'suggestions:res') { if (msg.suggestions?.groups) setSuggestions(msg.suggestions); return }
        if (msg.t === 'suggestions') {   // fast-router (as-you-type) — drop stale + ignore other input boxes
          if (typeof msg.seq === 'number' && msg.seq < lastSuggestSeq.current) return
          if (msg.inputId && inputId.current && msg.inputId !== inputId.current) return
          lastSuggestSeq.current = typeof msg.seq === 'number' ? msg.seq : lastSuggestSeq.current
          setLiveSuggest({ items: msg.items ?? [], intent: msg.intent })
          return
        }
        if (msg.t === 'session:load:res') {
          if (msg.sessionId !== sidRef.current) return
          const items = (msg.items ?? []).map((it: any) => {
            if (it.kind === 'user') return { id: crypto.randomUUID(), type: 'user-msg' as const, text: it.payload?.text ?? '' }
            if (it.kind === 'ui:text') return { id: crypto.randomUUID(), type: 'narrative' as const, text: it.payload?.text ?? '' }
            if (it.kind === 'ui:component') { const vt = `${it.payload.tag}-r${++vtagCtr.current}`; const code = String(it.payload.code).split(it.payload.vTag).join(vt); return { id: crypto.randomUUID(), type: 'component' as const, tag: it.payload.tag, vTag: vt, code, data: it.payload.data } }
            return null
          }).filter(Boolean) as FeedItem[]
          setFeed(items); scroll(true); return
        }

        if (msg.t === 'analysis:status') {
          setStatus(msg.text)
        } else if (msg.t === 'analysis:chunk') {
          rawStreamRef.current = (rawStreamRef.current + (msg.text ?? '')).slice(-400000)   // capture only — never shown
        } else if (msg.t === 'semantic:status') {
          setSemHasLog(true); setSemStatus(msg.text)
        } else if (msg.t === 'semantic:stream') {
          setSemStreamKind(msg.kind === 'pty' ? 'pty' : 'events')
          setSemHasPty(!!msg.pty)
        } else if (msg.t === 'semantic:event') {
          setSemHasLog(true); setSemEvents(evs => mergeEvent(evs, msg.ev))   // codex structured event (live)
        } else if (msg.t === 'semantic:events') {
          setSemEvents(msg.events ?? [])                                     // codex event-log replay (reconnect)
        } else if (msg.t === 'semantic:chunk') {
          setSemHasLog(true); if (msg.replace) semXtermRef.current?.clear(); semXtermRef.current?.write(msg.text)   // raw claude terminal → Semantic model panel
        } else if (msg.t === 'semantic:done') {
          setSemStatus('Semantic model built ✓'); setSemBusy(false)
        } else if (msg.t === 'analyst:status') {
          // "Answering" is a LIVE state: it lives only while ticks keep arriving. Arm the watchdog NOW so that
          // a replayed/stale "answering" (e.g. from a reconnect after the engine restarted) self-clears if no
          // ticks follow — the spinner is driven by the heartbeat, never by a flag we have to remember to clear.
          setAnBusy(true); setBusy(true); busyRef.current = true; setAnStatus(msg.text); if (msg.question) setAnQuestion(msg.question); armWatchdog()
        } else if (msg.t === 'analyst:category') {
          setAnCategory(msg.category); setAnStatus(`Answering — ${msg.category}…`)
        } else if (msg.t === 'analyst:stream') {
          const k = msg.kind === 'pty' ? 'pty' : 'events'
          anStreamKindRef.current = k; setAnStreamKind(k)
          setAnHasPty(!!msg.pty)   // claude-code also has a raw PTY terminal → offer the "Terminal" toggle
          // Do NOT clear the log here — the agent thread persists across questions, so the event log
          // ACCUMULATES the whole session (cleared only on New session; a divider marks a compaction).
        } else if (msg.t === 'analyst:chunk') {
          // Render the agent's LIVE terminal in the Analyst view (the operator surface — the main chat feed
          // still shows only clean answer cards), and keep capturing the raw stream for later use. `replace`
          // = a full repaint: the buffer replay the engine sends on attach (so the warm terminal shows up
          // immediately when you open the tab) or a fresh session.
          if (msg.replace) anXtermRef.current?.clear()
          anXtermRef.current?.write(msg.text ?? '')
          rawStreamRef.current = msg.replace ? (msg.text ?? '') : (rawStreamRef.current + (msg.text ?? '')).slice(-400000)
        } else if (msg.t === 'analyst:event') {
          // 'events'-kind harness (codex): one normalized AgentEvent. Merge by id so a streaming command/message
          // updates its own block in place (started → updated → completed); id-less events (turn) append.
          setAnEvents(evs => mergeEvent(evs, msg.ev))
        } else if (msg.t === 'analyst:events') {
          setAnEvents(msg.events ?? [])   // reconnect: full event-log replay (replace)
        } else if (msg.t === 'analyst:progress') {
          setAnProgress(msg.text || '')   // clean prose narration → live progress line
        } else if (msg.t === 'analyst:gap') {
          // The structured gap → its own card in the conversation; the final answer lands below it.
          const g = msg.answer ?? { status: 'gap', answer: 'Not in the model yet.' }
          const card: FeedItem = { id: crypto.randomUUID(), type: 'answer', category: msg.category, answer: g }
          if (!msg.sid || msg.sid === sidRef.current) { setFeed(f => [...f, card]); scroll() }
          else { const f = loadFeed(msg.sid); localStorage.setItem(fkey(msg.sid), JSON.stringify([...f, card].slice(-100))) }
        } else if (msg.t === 'analyst:enriching') {
          setAnEnriching({ need: msg.need, basis: msg.basis })
          setAnStatus(`Learning: ${msg.need}…`); setAnAnswer(null)
          setGaps(gs => [{ question: msg.question, need: msg.need, basis: msg.basis, status: 'building' as const }, ...gs].slice(0, 20))
        } else if (msg.t === 'analyst:enriched') {
          setAnEnriching(null); setAnStatus('Model updated — answering…')
          setGaps(gs => gs.map((g, i) => i === 0 ? { ...g, status: 'done' as const } : g))
        } else if (msg.t === 'analyst:answer') {
          setAnEnriching(null)
          // NEVER surface the agent's raw terminal (lastLines) as an answer — that leaks internal logs.
          // The agent is expected to always produce an answer (incl. a plain-text reply for conversational
          // input); this neutral fallback only guards a true failure and is NOT a restriction on what it answers.
          const ans = msg.answer ?? { status: 'no_answer', answer: 'Something went wrong on that one — please try again.' }
          setAnAnswer(ans)                                                     // Analyst tab (always reflects the latest)
          // A REPLAY (reconnect) is already in the saved feed — don't duplicate it. A fresh answer gets
          // appended to its OWN chat: the visible feed if it's current, else that chat's saved feed.
          if (!msg.replay) {
            const card: FeedItem = { id: crypto.randomUUID(), type: 'answer', category: msg.category, answer: ans, timing: msg.timing, qid: msg.qid, at: Date.now() }
            if (!msg.sid || msg.sid === sidRef.current) { setFeed(f => [...f, card]); scroll() }
            else { const f = loadFeed(msg.sid); localStorage.setItem(fkey(msg.sid), JSON.stringify([...f, card].slice(-100))) }
          }
        } else if (msg.t === 'analyst:done') {
          setAnBusy(false); setAnStatus('Done ✓'); setAnProgress(''); setBusy(false); busyRef.current = false; clearWatchdog()
        } else if (msg.t === 'analysis:step') {
          setFeed(f => [...f, { id: crypto.randomUUID(), type: 'step', text: msg.text }])
          scroll()
        } else if (msg.t === 'analysis:done') {
          setStatus('Generating UI…')
        } else if (msg.t === 'ui:status') {
          setStatus(msg.text)
        } else if (msg.t === 'ui:text') {
          setFeed(f => [...f, { id: crypto.randomUUID(), type: 'narrative', text: msg.text }])
          scroll()
        } else if (msg.t === 'ui:component') {
          setFeed(f => [...f, { id: crypto.randomUUID(), type: 'component',
                                tag: msg.tag, vTag: msg.vTag, code: msg.code, data: msg.data }])
          scroll()
        } else if (msg.t === 'error') {
          clearWatchdog(); busyRef.current = false
          setFeed(f => [...f, { id: crypto.randomUUID(), type: 'error', text: `[${msg.source}] ${msg.message}` }])
          setStatus('')
          setBusy(false)
        } else if (msg.t === 'done') {
          clearWatchdog(); busyRef.current = false
          setStatus('')
          setBusy(false)
          send({ t: 'sessions:list', projectId })   // refresh sidebar (new session + title)
        }
      }
    }
    connect()
    return () => { closed = true; wsRef.current?.close() }
  }, [token, projectId])

  // Send a code-engine payload. Cloud: wrap in the hub envelope addressed to the
  // code-engine role. Local: send the raw payload directly.
  function send(payload: any) {
    const ws = wsRef.current
    if (ws?.readyState !== 1) return
    ws.send(JSON.stringify(CLOUD ? { to: { type: 'code-engine' }, payload } : payload))
  }

  function newChat() {
    // New CHAT (fresh answer surface) — but NOT a new agent session: the analyst thread persists, so the
    // running session log stays (it clears only on "New session").
    const id = newId(); sidRef.current = id; setSessionId(id); setFeed([]); setAnAnswer(null); setAnBusy(false)
    history.pushState(null, '', `/c/${id}${location.search}`)   // keep ?project=
    setView('chat')   // selecting/creating a chat returns to the chat view (e.g. from the analyst view)
    inputRef.current?.focus()
  }
  function openSession(id: string) {
    if (id === sidRef.current) return
    sidRef.current = id; setSessionId(id); setFeed(loadFeed(id)); setAnAnswer(null)   // restore that chat's saved feed
    history.pushState(null, '', `/c/${id}${location.search}`)   // keep ?project=
    setView('chat')   // selecting a chat returns to the chat view
    scroll(true)   // jump straight to the bottom (instant) instead of landing at the top
  }

  function scroll(instant = false) {
    // Live updates animate smoothly. For an INSTANT (load) scroll the trick is that charts / web-components
    // render ASYNChronously AFTER the feed sets, growing the page after a single scroll fires — which is why
    // it used to strand you at the top. So we RE-PIN to the bottom until the height stops growing (or a hard
    // cap), instantly, no animation — the page settles already scrolled to the newest message.
    if (!instant) { setTimeout(() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }), 50); return }
    let last = -1, stable = 0
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' })
    const iv = setInterval(() => {
      const h = document.body.scrollHeight
      window.scrollTo({ top: h, behavior: 'auto' })
      if (h === last) { if (++stable >= 3) clearInterval(iv) } else { stable = 0; last = h }   // settled for ~180ms → stop
    }, 60)
    setTimeout(() => clearInterval(iv), 3000)   // hard cap so we never pin forever
  }

  // Liveness watchdog: the engine sends a `tick` every 8s while a turn runs. We re-arm on every
  // message; if nothing arrives for 25s while busy, the engine likely restarted/crashed or the
  // connection dropped — stop the fake spinner and tell the user to re-ask.
  function clearWatchdog() { if (watchdog.current) { clearTimeout(watchdog.current); watchdog.current = null } }
  // The SINGLE "no longer answering" transition — heartbeat-driven, never a flag we must remember to clear.
  // Clears the WHOLE answering state (input `busy` AND the analyst spinner/status), plus the watchdog. `note`
  // = why (engine went silent / restarted), shown once in the feed. This is what was missing before: the old
  // watchdog cleared only `busy`, so `anStatus` ("Classifying…") lived on forever when the engine vanished.
  function endTurn(note?: string) {
    clearWatchdog()
    busyRef.current = false; setBusy(false); setStatus('')
    setAnBusy(false); setAnStatus(''); setAnProgress('')
    if (note) { setFeed(f => [...f, { id: crypto.randomUUID(), type: 'error', text: note }]); scroll() }
  }
  // Liveness: the engine ticks every ~8s while a turn runs; every incoming message re-arms this. If nothing
  // arrives for `ms`, the engine is gone (crashed / suspended / never came up) → end the turn. A machine
  // wake+boot legitimately takes ~60s, so `machine:waking` arms a longer window instead of false-firing.
  function armWatchdog(ms = 25000) {
    clearWatchdog()
    watchdog.current = setTimeout(() => endTurn('The engine went silent — it may have restarted or is still starting. Please ask again.'), ms)
  }

  const submit = useCallback((preset?: string) => {
    const text = (typeof preset === 'string' ? preset : inputRef.current?.value)?.trim()
    if (!text || busy || wsRef.current?.readyState !== 1) return
    const next = [text, ...historyRef.current.filter(q => q !== text)].slice(0, 100)
    historyRef.current = next
    historyIdx.current = -1
    localStorage.setItem(`sa-hist:${projectId}`, JSON.stringify(next))
    // ONE id, minted HERE (client-generated, like an idempotency key): the same qid is the feed key,
    // is sent to the engine, becomes ./out/<qid>.json, and the DB row — so a reload lines everything up.
    const qid = newId()
    // Ask in New chat (the end-user surface): show the question here, answer renders here as a clean
    // card. The Analyst tab keeps the raw terminal for when you WANT to look under the hood.
    setFeed(f => [...f, { id: qid, type: 'user-msg', text }])
    setAnQuestion(text); setAnAnswer(null); setAnCategory(''); setAnStatus('Classifying…'); setAnBusy(true); setAnEnriching(null); setAnProgress('')
    anXtermRef.current?.clear()   // claude PTY: fresh TUI per question (harmless when the analyst is codex)
    if (anStreamKindRef.current === 'events') setAnEvents(l => [...l, { kind: 'user', text }])   // codex: the question as a user turn in the log
    setStatus('')
    setBusy(true); busyRef.current = true; armWatchdog()
    if (inputRef.current) { inputRef.current.value = ''; inputRef.current.style.height = 'auto' }
    setLiveSuggest(null); multilineRef.current = false; setMultiline(false)
    // userId is NOT sent — the hub stamps the authenticated userId onto `from` server-side (trusted).
    send({ t: 'analyse', question: text, projectId, role, sessionId: sidRef.current, questionId: qid })
    scroll()
  }, [busy, role])

  // Developer-only: trigger System-4 consolidation. Auto-opens the live-output drawer
  // since the whole point is to watch Claude Code consolidate.
  const consolidate = useCallback(() => {
    if (busy || wsRef.current?.readyState !== 1) return
    setFeed(f => [...f, { id: crypto.randomUUID(), type: 'user-msg', text: '⚙︎ Consolidate library (System 4)' }])
    xtermRef.current?.clear()
    setHasLog(true)
    setLogOpen(true)
    setStatus('Consolidating…')
    setBusy(true); busyRef.current = true; armWatchdog()
    send({ t: 'consolidate', role: 'developer' })
    scroll()
  }, [busy])

  // Developer-only: trigger the semantic-model agent (its own panel). Streams the raw claude
  // terminal to the "Semantic model" panel so the build is watchable.
  const buildSemantic = useCallback(() => {
    if (wsRef.current?.readyState !== 1) return
    navigate('semantic'); setSemHasLog(true); setSemStatus('Starting…'); setSemBusy(true)
    semXtermRef.current?.clear()
    send({ t: 'semantic:build', projectId })
  }, [projectId])

  // Standard ICA session controls, per agent: a completely fresh session, or compact (shrink context).
  const sessionCtl = useCallback((role: 'analyst' | 'semantic', action: 'new' | 'compact') => {
    if (wsRef.current?.readyState !== 1) return
    // The analyst's running session log resets ONLY here: a New session wipes it (a brand-new thread);
    // a compaction is marked with a divider (the thread continues with summarized context below it).
    if (role === 'analyst') setAnEvents(l => action === 'new' ? [] : [...l, { kind: 'turn' }])   // new: wipe; compact: a divider rule
    send({ t: action === 'new' ? 'session:new' : 'session:compact', role, projectId })
    ;(role === 'semantic' ? setSemStatus : setAnStatus)(action === 'new' ? 'New session' : 'Compacting…')
  }, [projectId])

  // ── Composer (ChatGPT-style: auto-growing textarea, attach, send) ──
  const autoGrow = (el: HTMLTextAreaElement | null) => { if (!el) return; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 200) + 'px' }
  const onComposerInput = () => {
    const el = inputRef.current
    autoGrow(el)
    const m = !!el && el.scrollHeight > 46   // > one line → text-over-controls layout
    if (m !== multilineRef.current) { multilineRef.current = m; setMultiline(m) }
    clearTimeout(suggestTimer.current)
    suggestTimer.current = setTimeout(() => {
      if (!inputId.current) inputId.current = crypto.randomUUID()
      send({ t: 'suggest', projectId, inputId: inputId.current, seq: ++suggestSeq.current, text: inputRef.current?.value ?? '' })
    }, 120)
  }
  const composer = () => {
    const plus = (
      <button key="plus" style={s.attachBtn} title="Attach a file" onClick={() => { /* attach — not wired yet */ }}>
        <svg width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    )
    const send = (
      <button key="send" onClick={() => submit()} disabled={busy || !connected} title="Send"
        style={{ ...s.sendCircle, background: busy || !connected ? '#e2ddd4' : '#1a1a1a', cursor: busy || !connected ? 'default' : 'pointer' }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20V6M6 12l6-6 6 6"/></svg>
      </button>
    )
    const textarea = (
      <textarea key="ta" ref={inputRef} rows={1} style={{ ...s.composerTextarea, ...(multiline ? { width: '100%' } : { flex: 1 }) }}
        placeholder="Ask about your data…"
        onFocus={() => { if (!inputId.current) { inputId.current = crypto.randomUUID(); suggestSeq.current = 0; lastSuggestSeq.current = -1 } }}
        onInput={onComposerInput}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); return }
          if ((inputRef.current?.value ?? '').includes('\n')) return   // multi-line: let arrows move the caret
          const h = historyRef.current
          if (e.key === 'ArrowUp' && h.length > 0) {
            e.preventDefault(); historyIdx.current = Math.min(historyIdx.current + 1, h.length - 1)
            if (inputRef.current) { inputRef.current.value = h[historyIdx.current]; autoGrow(inputRef.current) }
          }
          if (e.key === 'ArrowDown') {
            e.preventDefault(); historyIdx.current -= 1
            if (inputRef.current) { inputRef.current.value = historyIdx.current < 0 ? '' : h[historyIdx.current]; autoGrow(inputRef.current) }
          }
        }} />
    )
    // Single line → one centered row (+ text send). Multi-line → text on top, +/send in a bottom strip.
    return multiline ? (
      <div style={{ ...s.composer, flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        {textarea}
        <div key="strip" style={s.bottomStrip}>{plus}{send}</div>
      </div>
    ) : (
      <div style={{ ...s.composer, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        {plus}{textarea}{send}
      </div>
    )
  }
  const liveSuggestBlock = () => (liveSuggest && liveSuggest.items.length > 0) ? (
    <div style={{ margin: '0 0 8px' }}>
      {liveSuggest.items.slice(0, 6).map((it: any, i: number) => (
        <div key={i} onMouseDown={e => {
            e.preventDefault()   // put the suggestion in the box (editable); DON'T submit — the user edits + presses Enter
            const el = inputRef.current
            if (el) { el.value = it.question || it.label; autoGrow(el); const m = el.scrollHeight > 46; if (m !== multilineRef.current) { multilineRef.current = m; setMultiline(m) }; el.focus() }
            setLiveSuggest(null)
          }}
          style={s.suggestRow}
          onMouseEnter={e => (e.currentTarget.style.borderColor = '#d8c9b8')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = '#e8e4de')}>{it.question || it.label}</div>
      ))}
    </div>
  ) : null

  // Buildable-gap queue — questions the analyst couldn't answer because the model lacked a concept,
  // now being (or already) modeled. Shown on BOTH the Analyst and Semantic-model views.
  const gapsPanel = gaps.length ? (
    <div style={{ padding: '8px 14px', borderBottom: '1px solid #23281f', background: '#14180f' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#9db29e', letterSpacing: 0.5, marginBottom: 6 }}>BUILDABLE GAPS</div>
      {gaps.map((g, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12, padding: '2px 0' }}>
          <span style={{ color: g.status === 'done' ? '#7fae82' : '#e0b070' }}>{g.status === 'done' ? '✓' : '◷'}</span>
          <span style={{ color: '#cfe3d0' }}>{g.need}</span>
          <span style={{ color: '#6f7a68', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>— {g.question}</span>
        </div>
      ))}
    </div>
  ) : null

  return (
    <div style={s.shell}>
      {/* Sidebar — sectioned menu (Model / Agent), like a product nav */}
      <aside style={s.sidebar}>
        <div style={{ padding: '10px 12px 6px', fontSize: 15, fontWeight: 700, color: '#cfe3d0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
             title={proj?.id || projectId}>
          {proj?.name || 'Superatom'}
        </div>
        {role === 'developer' && (
          <>
            <div style={s.navSection}>MODEL</div>
            <div onClick={() => navigate('semantic')}
              style={{ ...s.sessionItem, ...(view === 'semantic' ? s.sessionItemActive : {}) }}>
              ◈ Semantic model
            </div>
          </>
        )}
        <div style={s.navSection}>AGENT</div>
        <div onClick={() => navigate('analyst')}
          style={{ ...s.sessionItem, ...(view === 'analyst' ? s.sessionItemActive : {}) }}>
          ◇ Analyst
        </div>
        <button style={s.newChat} onClick={() => { navigate('chat'); newChat() }}>+ New chat</button>
        <div style={s.sessionList}>
          {sessions.map(se => (
            <div key={se.id} onClick={() => { navigate('chat'); openSession(se.id) }} title={se.title || 'New chat'}
              style={{ ...s.sessionItem, display: 'flex', alignItems: 'center', gap: 6, ...(view === 'chat' && se.id === sessionId ? s.sessionItemActive : {}) }}>
              {anBusy && se.id === sessionId && <span title="running" style={{ flexShrink: 0 }}><Spinner /></span>}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{se.title || 'New chat'}</span>
            </div>
          ))}
          {sessions.length === 0 && <div style={s.sessionEmpty}>No chats yet</div>}
        </div>
        {/* Account — real Clerk user, pinned to the sidebar bottom; click the avatar for the Clerk popup */}
        {CLOUD ? <AccountSection /> : (
          <div style={s.acct}>
            <div style={s.avatar}>D</div>
            <div style={{ flex: 1, minWidth: 0 }}><div style={s.acctName}>Local</div><div style={s.acctPlan}>dev</div></div>
          </div>
        )}
      </aside>

    <div style={s.page}>
      {/* Sticky header: topbar + Claude live-output drawer pinned to the top */}
      <div style={s.stickyHeader}>
      {/* Floating controls — top-right, non-scrolling (no header bar) */}
      <div style={s.floatControls}>
        {status && <span style={s.statusChip}><Spinner />{status}</span>}
        <div style={{ ...s.dot, background: connected ? '#059669' : '#d1cec9' }} title={connected ? 'Connected' : 'Offline'} />
      </div>
      </div>

      {/* Semantic-model view — always mounted so xterm keeps its DOM node; shown when selected */}
      <div style={{ display: view === 'semantic' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={s.semHeader}>
          <button onClick={() => navigate('chat')} style={s.backBtn} title="Back to your chat">← Chat</button>
          <button onClick={buildSemantic} style={s.consolidateBtn} title="Run the semantic-model agent (claude-code)">◈ Build / refresh model</button>
          <span style={{ color: '#8a8276', fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{semStatus || 'The semantic-model agent — builds the model; never answers questions.'}</span>
          {semHasPty && (
            <button
              onClick={() => {
                const next = !semTerminal; setSemTerminal(next)
                if (next) { send({ t: 'ui:resize', which: 'semantic', cols: COLS, rows: ROWS }); send({ t: 'term:attach', which: 'semantic' }) }
                else send({ t: 'term:detach', which: 'semantic' })
              }}
              style={s.backBtn}
              title={semTerminal ? 'Back to the structured view' : 'Open the raw claude-code terminal'}>
              {semTerminal ? '≣ Structured' : '⌨ Terminal'}
            </button>
          )}
          <button onClick={() => sessionCtl('semantic', 'compact')} style={s.backBtn} title="Compact the session's context">⇊ Compact</button>
          <button onClick={() => sessionCtl('semantic', 'new')} style={s.backBtn} title="Start a completely fresh session">↻ New session</button>
        </div>
        {gapsPanel}
        <div ref={semLogRef} style={{ flex: 1, overflow: 'auto', background: 'transparent', padding: 12, paddingBottom: 110 }}>
          {/* Raw claude terminal (PTY) — shown only when opened via the toggle, or a pure-pty agent. */}
          <div ref={semTermRef} onMouseDown={() => semXtermRef.current?.focus()} style={{ display: (semTerminal || semStreamKind === 'pty') ? 'block' : 'none' }} />
          {/* DEFAULT: the structured event log (modeler via JSONL, codex via events). */}
          {!(semTerminal || semStreamKind === 'pty') && <CodexEventLog events={semEvents} busy={semBusy} claude={semHasPty} />}
        </div>
      </div>

      {/* Analyst view — always mounted so xterm keeps its buffer; shown when selected. */}
      <div style={{ display: view === 'analyst' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div style={s.semHeader}>
          <button onClick={() => navigate('chat')} style={s.backBtn} title="Back to your chat">← Chat</button>
          <span style={{ color: '#bcd0be', fontSize: 13, fontWeight: 600 }}>◇ Analyst</span>
          {anCategory && <span style={s.catChip}>{anCategory.replace('_', ' ')}</span>}
          <span style={{ color: '#8a8276', fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {anQuestion || 'Ask a question below — it classifies, then answers from the semantic model.'}
          </span>
          {anBusy && <Spinner />}
          <span style={{ color: '#8a8276', fontSize: 12 }}>{anStatus}</span>
          {anHasPty && (
            <button
              onClick={() => {
                const next = !anTerminal; setAnTerminal(next)
                if (next) { send({ t: 'ui:resize', which: 'analyst', cols: COLS, rows: ROWS }); send({ t: 'term:attach', which: 'analyst' }) }   // lazy: open the PTY only now
                else send({ t: 'term:detach', which: 'analyst' })   // switching back → stop the PTY stream
              }}
              style={s.backBtn}
              title={anTerminal ? 'Back to the structured view' : 'Open the raw claude-code terminal'}>
              {anTerminal ? '≣ Structured' : '⌨ Terminal'}
            </button>
          )}
          <button onClick={() => sessionCtl('analyst', 'compact')} style={s.backBtn} title="Compact the session's context">⇊ Compact</button>
          <button onClick={() => sessionCtl('analyst', 'new')} style={s.backBtn} title="Start a completely fresh session">↻ New session</button>
        </div>
        {gapsPanel}
        {/* Enriching banner — the model didn't cover it; the model-builder is filling the gap, then we re-ask. */}
        {anEnriching && (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #33402f', background: '#241d12' }}>
            <div style={{ color: '#e0b070', fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
              <Spinner /> I don't have this in the model yet — the model-builder is adding it, then I'll answer.
              <span onClick={() => navigate('semantic')} style={{ marginLeft: 'auto', fontSize: 12, textDecoration: 'underline', cursor: 'pointer' }}>watch in Semantic model ↗</span>
            </div>
            <div style={{ color: '#c9a86e', fontSize: 12, marginTop: 4 }}>Modeling: {anEnriching.need}</div>
            {anEnriching.basis && <div style={{ color: '#8a8276', fontSize: 12, marginTop: 2 }}>Basis: {anEnriching.basis}</div>}
          </div>
        )}
        {/* Structured answer (from out/answer.json) */}
        {anAnswer && (() => {
          const warn = anAnswer.status === 'unknowable' || anAnswer.status === 'cannot_answer' || anAnswer.status === 'gap'
          return (
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #23281f', background: warn ? '#2a2118' : '#181d16' }}>
            <div style={{ color: warn ? '#e0b070' : '#cfe3d0', fontSize: 14, marginBottom: anAnswer.value != null || anAnswer.table ? 8 : 0 }}>
              {warn ? '⚠ Cannot answer' : ''} {anAnswer.answer}
            </div>
            {anAnswer.value != null && <div style={{ fontSize: 24, fontWeight: 700, color: '#bcd0be' }}>{typeof anAnswer.value === 'number' ? anAnswer.value.toLocaleString() : anAnswer.value}</div>}
            {anAnswer.scope && <div style={{ color: '#8a8276', fontSize: 12, marginTop: 4 }}>Scope: {anAnswer.scope}</div>}
            {anAnswer.missing && <div style={{ color: '#e0b070', fontSize: 12, marginTop: 4 }}>No source in the data: {anAnswer.missing}</div>}
            {anAnswer.gap?.need && <div style={{ color: '#e0b070', fontSize: 12, marginTop: 4 }}>Needs modeling: {anAnswer.gap.need}</div>}
            {anAnswer.table && (
              <div style={{ overflowX: 'auto', marginTop: 8 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 12, color: '#cfe3d0' }}>
                  <thead><tr>{anAnswer.table.columns?.map((c: string, i: number) => <th key={i} style={{ textAlign: 'left', padding: '4px 12px 4px 0', borderBottom: '1px solid #33402f', color: '#9db29e' }}>{c}</th>)}</tr></thead>
                  <tbody>{anAnswer.table.rows?.slice(0, 100).map((r: any[], ri: number) => <tr key={ri}>{r.map((v, ci) => <td key={ci} style={{ padding: '3px 12px 3px 0', fontVariantNumeric: 'tabular-nums' }}>{typeof v === 'number' ? v.toLocaleString() : String(v ?? '')}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
        )})()}
        <div ref={anLogRef} style={{ flex: 1, overflow: 'auto', background: 'transparent', padding: 12, paddingBottom: 110 }}>
          {/* Raw claude-code terminal (PTY) — shown only when the user opened it via the toggle, or for a
              pure-pty agent. Kept mounted so its buffer survives view switches. */}
          <div ref={anTermRef} onMouseDown={() => anXtermRef.current?.focus()} style={{ display: (anTerminal || anStreamKind === 'pty') ? 'block' : 'none' }} />
          {/* DEFAULT: the STRUCTURED event log — claude-code (from its JSONL transcript) AND codex, same view. */}
          {!(anTerminal || anStreamKind === 'pty') && <CodexEventLog events={anEvents} busy={anBusy} claude={anHasPty} />}
        </div>
        {view === 'analyst' && (
          <div style={s.bottomBar}>
            <div style={{ width: '100%', maxWidth: 720, margin: '0 auto' }}>{composer()}</div>
          </div>
        )}
      </div>

      {/* Chat/answer view */}
      {view === 'chat' && (feed.length === 0 && !busy ? (
        <div style={s.centerStage}>
          <div style={{ width: '100%', maxWidth: 720 }}>
            {composer()}
            {liveSuggestBlock()}
          </div>
        </div>
      ) : (
        <>
          <div ref={feedRef} style={s.feed}>
            {feed.map(item => <FeedCard key={item.id} item={item} />)}
            {/* Working indicator — no terminal; a details link goes to the Analyst tab. */}
            {anBusy && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 2px', color: '#8a8276', fontSize: 14 }}>
                <Spinner />
                <span>{anEnriching ? `Learning this part of your data: ${anEnriching.need}` : (anProgress || anStatus || 'Analyzing…')}</span>
                <span onClick={() => navigate('analyst')} style={{ marginLeft: 'auto', fontSize: 12, color: '#8a8276', cursor: 'pointer', textDecoration: 'underline' }}>
                  details ↗
                </span>
              </div>
            )}
          </div>
          <div style={s.bottomBar}>
            <div style={{ width: '100%', maxWidth: 720, margin: '0 auto' }}>
              {liveSuggestBlock()}
              {composer()}
            </div>
          </div>
        </>
      ))}
    </div>
    </div>
  )
}

// The signed-in Clerk user, pinned to the sidebar bottom. Clicking the avatar opens Clerk's account
// popup (manage account / sign out). Only rendered in cloud mode (inside <ClerkProvider>).
function AccountSection() {
  const { user } = useUser()
  return (
    <div style={s.acct}>
      <UserButton afterSignOutUrl="/" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={s.acctName}>{user?.fullName || user?.username || 'Account'}</div>
        <div style={s.acctPlan}>{user?.primaryEmailAddress?.emailAddress || ''}</div>
      </div>
    </div>
  )
}

// Progressive disclosure for long tables: show TABLE_PAGE rows, then a "Show more" button that reveals
// TABLE_PAGE more per click. Pure frontend — the component still receives ALL rows; we only change how
// many are visible so a long table isn't tedious to scroll. Runs on every .sa-table after mount, so it
// covers generated, cached, and hand-authored components uniformly without any of them implementing it.
const TABLE_PAGE = 25
function enhanceTables(root: HTMLElement) {
  const tables = Array.from(root.querySelectorAll('table.sa-table')) as HTMLElement[]
  for (const table of tables) {
    if ((table as any)._saPaged) continue
    let rows = Array.from(table.querySelectorAll(':scope > tbody > tr')) as HTMLElement[]
    if (!rows.length) rows = Array.from(table.querySelectorAll(':scope > tr')) as HTMLElement[]
    if (rows.length <= TABLE_PAGE) continue
    ;(table as any)._saPaged = true
    const total = rows.length
    let shown = TABLE_PAGE
    const btn = document.createElement('button')
    btn.className = 'sa-showmore'
    const sync = () => {
      rows.forEach((r, i) => { r.style.display = i < shown ? '' : 'none' })
      const remaining = total - shown
      if (remaining <= 0) { btn.remove(); return }
      btn.textContent = `Show ${Math.min(TABLE_PAGE, remaining)} more  ·  ${shown} of ${total}`
    }
    btn.addEventListener('click', () => { shown = Math.min(total, shown + TABLE_PAGE); sync() })
    table.insertAdjacentElement('afterend', btn)
    sync()
  }
}

function FeedCard({ item }: { item: FeedItem }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (item.type !== 'component') return
    try {
      // Only define the custom element if this tag isn't already registered — re-defining throws
      // ("already defined") and would blank the component. (Tags are globally unique now, but this
      // keeps it safe across reloads / repeats.)
      if (!customElements.get(item.vTag)) {
        // eslint-disable-next-line no-eval
        eval(item.code)
      }
      const el = document.createElement(item.vTag) as any
      el._data = item.data
      el.style.cssText = 'display:block;width:100%'
      ref.current?.appendChild(el)
      enhanceTables(el)   // custom elements render synchronously on append, so rows exist now
    } catch(e) {
      console.error('[component eval]', e)
    }
  }, [])

  if (item.type === 'user-msg') {
    return <div style={s.userMsg}>{item.text}</div>
  }
  if (item.type === 'step') {
    return <div style={s.step}>{item.text}</div>
  }
  if (item.type === 'narrative') {
    return <div style={s.narrative} dangerouslySetInnerHTML={{ __html: renderInlineMd(item.text) }} />
  }
  if (item.type === 'component') {
    return <div ref={ref} className="sa-ui" style={s.componentSlot} />
  }
  if (item.type === 'error') {
    return <div style={{ ...s.narrative, borderColor: '#fca5a5', color: '#b91c1c' }}>{item.text}</div>
  }
  if (item.type === 'answer') {
    return <AnswerCard answer={item.answer} category={item.category} timing={item.timing} qid={item.qid} at={item.at} />
  }
  return null
}

// ── Answer card — the "exhibit" standard from the TotalGroup/Fusion5 benchmark.html ──────────────────
// Editorial financial-report look: uppercase navy type label, serif lead, thick ink rule, a KPI "figs"
// strip, rigorous fin-tables (uppercase head, ink rules, right-aligned tabular figures), a red-accent
// caveat, and a source line. Theme-aware (light/dark) with real contrast. The program's view-model drives
// it: `headline` (single KPI) or `figures[]` (a strip), `table`, `period`/`periods`, `caveat`, `scope`,
// `source`. Injected once; scoped under `.sa-answer` so nothing leaks into the rest of the app.
const ANSWER_CSS = `
.sa-answer{--navy:#15385c;--red:#9c2b23;--neg:#8a5a12;--ink:#161719;--body:#33373c;--muted:#6c7075;--rule:#c9ccd1;--hair:#e2e4e8;--panel:#f6f7f9;--page:#fff;
  --serif:Georgia,"Times New Roman",serif;--grot:"Helvetica Neue",Helvetica,Arial,system-ui,sans-serif;--mono:"SFMono-Regular",Consolas,Menlo,monospace;
  background:var(--page);color:var(--body);font-family:var(--grot);border:1px solid var(--rule);border-radius:3px;padding:20px 22px;margin:2px 0 12px;font-size:14px;line-height:1.6}
@media (prefers-color-scheme:dark){.sa-answer:not([data-theme="light"]){--navy:#7ba7d4;--red:#d98a84;--neg:#caa24a;--ink:#e7e5e0;--body:#c2c4c8;--muted:#8b8f95;--rule:#333840;--hair:#262a30;--panel:#1c1f24;--page:#15171b}}
.sa-answer[data-theme="dark"]{--navy:#7ba7d4;--red:#d98a84;--neg:#caa24a;--ink:#e7e5e0;--body:#c2c4c8;--muted:#8b8f95;--rule:#333840;--hair:#262a30;--panel:#1c1f24;--page:#15171b}
.sa-answer.warn{border-color:var(--rule)}
.sa-answer *{box-sizing:border-box}
.sa-answer .num,.sa-answer table,.sa-answer .sa-figs{font-variant-numeric:lining-nums tabular-nums;font-feature-settings:"lnum" 1,"tnum" 1}
.sa-answer .sa-type{font-family:var(--grot);font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:800;color:var(--navy)}
.sa-answer .sa-type.warn{color:var(--muted)}
.sa-answer .sa-prose{font-family:var(--grot);font-size:15px;font-weight:400;color:var(--body);line-height:1.62;margin:9px 0 14px}
.sa-answer .sa-prose b,.sa-answer .sa-prose strong{color:var(--ink);font-weight:700}
.sa-answer .sa-prose em{font-style:italic}
.sa-answer .sa-prose code{font-family:var(--mono);font-size:12.5px;color:var(--ink);background:var(--panel);padding:1px 4px;border:1px solid var(--hair)}
.sa-answer .sa-prose ul.sa-list,.sa-answer .sa-caveat ul.sa-list{margin:7px 0 4px;padding-left:2px;list-style:none}
.sa-answer .sa-prose ul.sa-list li,.sa-answer .sa-caveat ul.sa-list li{position:relative;padding-left:18px;margin:3px 0;line-height:1.55}
.sa-answer .sa-prose ul.sa-list li::before,.sa-answer .sa-caveat ul.sa-list li::before{content:"";position:absolute;left:4px;top:9px;width:4px;height:4px;background:var(--navy);border-radius:50%}
.sa-answer .sa-caveat ul.sa-list{margin:0}
.sa-answer .sa-period{font-family:var(--grot);font-size:11px;color:var(--body);margin:0 0 16px;display:flex;gap:9px;align-items:baseline;flex-wrap:wrap}
.sa-answer .sa-period .pk{font-size:9.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:800;color:var(--page);background:var(--navy);padding:2px 7px}
.sa-answer .sa-period b{color:var(--ink);font-weight:700}
.sa-answer .sa-figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(115px,1fr));border-top:1.5px solid var(--ink);border-bottom:1px solid var(--rule);margin:0 0 18px}
.sa-answer .sa-fig{padding:12px 16px 13px;border-left:1px solid var(--hair)}
.sa-answer .sa-fig:first-child{border-left:0;padding-left:0}
.sa-answer .sa-fig .k{font-family:var(--grot);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:700}
.sa-answer .sa-fig .v{font-family:var(--grot);font-size:23px;font-weight:700;color:var(--ink);line-height:1.15;margin-top:5px;letter-spacing:-.01em}
.sa-answer .sa-fig .v.neg{color:var(--neg)}
.sa-answer .sa-fig .s{font-size:11.5px;color:var(--muted);margin-top:2px}
.sa-answer .sa-scroll{overflow-x:auto;margin:0}
.sa-answer table.sa-fin{width:100%;border-collapse:collapse;font-size:13.5px}
.sa-answer table.sa-fin thead th{font-family:var(--grot);font-size:10.5px;letter-spacing:.05em;text-transform:uppercase;font-weight:700;color:var(--body);text-align:left;padding:0 18px 8px 18px;border-bottom:1.5px solid var(--ink);white-space:nowrap}
.sa-answer table.sa-fin th.r,.sa-answer table.sa-fin td.r{text-align:right}
.sa-answer table.sa-fin tbody td{padding:8px 18px;border-bottom:1px solid var(--hair);vertical-align:baseline;color:var(--body);white-space:nowrap}
.sa-answer table.sa-fin th:first-child,.sa-answer table.sa-fin td:first-child{padding-left:0}
.sa-answer table.sa-fin th:last-child,.sa-answer table.sa-fin td:last-child{padding-right:0}
.sa-answer table.sa-fin tbody tr:hover{background:var(--panel)}
.sa-answer table.sa-fin td.rk{color:var(--muted);width:22px;padding-right:8px}
.sa-answer table.sa-fin td.fig{color:var(--ink);font-weight:700}
.sa-answer .sa-caveat{font-size:12.5px;color:var(--body);background:var(--panel);border:1px solid var(--hair);border-radius:3px;padding:11px 16px;margin:0 0 12px;line-height:1.6}
.sa-answer .sa-src{font-size:11.5px;color:var(--muted);margin-top:6px}.sa-answer .sa-src b{color:var(--body)}
.sa-answer .sa-foot{display:flex;justify-content:flex-end;gap:12px;margin-top:12px;padding-top:8px;border-top:1px solid var(--hair);font-size:11px;color:var(--muted)}
.sa-answer{position:relative}
.sa-answer .sa-actions{position:absolute;top:12px;right:14px;display:flex;gap:6px;opacity:0;transition:opacity .12s;z-index:2}
.sa-answer:hover .sa-actions,.sa-answer:fullscreen .sa-actions{opacity:1}
.sa-answer .sa-ic{display:inline-flex;align-items:center;justify-content:center;width:27px;height:27px;color:var(--muted);background:var(--page);border:1px solid var(--rule);border-radius:5px;cursor:pointer;padding:0}
.sa-answer .sa-ic:hover{color:var(--navy);border-color:var(--navy)}
/* native fullscreen: the card element itself fills the screen (no portal) */
.sa-answer:fullscreen{width:100vw;height:100vh;max-width:none;margin:0;border:0;border-radius:0;overflow:auto;padding:30px clamp(20px,4vw,64px) 64px;background:var(--page)}
.sa-answer:-webkit-full-screen{width:100vw;height:100vh;max-width:none;margin:0;border:0;border-radius:0;overflow:auto;padding:30px clamp(20px,4vw,64px) 64px;background:var(--page)}
.sa-answer table.sa-fin tfoot td{border-bottom:0}
.sa-answer table.sa-fin tr.sa-total td{border-top:1.5px solid var(--ink);color:var(--ink);font-weight:700;padding:8px 18px}
.sa-answer table.sa-fin tr.sa-total td:first-child{padding-left:0}
.sa-answer table.sa-fin tr.sa-total td:last-child{padding-right:0}
.sa-answer .sa-tbar{display:flex;justify-content:flex-end;margin:0 0 6px}
/* "show more" keeps the row look (top+bottom border, centered) but sits OUTSIDE the horizontal scroll, so it
   stays centred in the viewport no matter how wide the table is (it no longer scrolls off with the columns) */
.sa-answer .sa-more{border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);text-align:center;padding:12px 8px;cursor:pointer;font-family:var(--grot);font-size:12px;font-weight:700;color:var(--navy);letter-spacing:.03em;text-transform:uppercase;user-select:none}
.sa-answer .sa-more:hover{background:var(--panel)}
.sa-answer .sa-tblsec{margin:0 0 20px}   /* gap between the table block and whatever card follows */
.sa-answer .sa-count{font-family:var(--grot);font-size:10.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-top:8px}
/* multi-block report sections: a titled block (table / kpis / text), stacked top-to-bottom. Every section has
   the SAME vertical rhythm (title gap, body, bottom margin) so tables with a note read no taller than ones
   without — the row padding itself is the shared .sa-fin value, identical across all of them. */
.sa-answer .sa-sec{margin:0 0 18px}
.sa-answer .sa-sec.sa-tblsec{margin:0 0 18px}   /* combined class: keep the SAME bottom gap as any other section */
.sa-answer .sa-sec:last-child{margin-bottom:0}
.sa-answer .sa-sec .sa-count{margin-top:6px}    /* the note sits tight under its table, not a floating gap */
.sa-answer .sa-sec-title{font-family:var(--grot);font-size:12px;letter-spacing:.04em;text-transform:uppercase;font-weight:800;color:var(--ink);margin:0 0 10px;padding-bottom:5px;border-bottom:1px solid var(--hair)}
/* table header row: title (left) + download (right) on ONE line — the download reveals on hover of the table */
.sa-answer .sa-tbl-head{display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--hair);padding-bottom:6px;margin:0 0 10px;min-height:24px}
.sa-answer .sa-tbl-head .sa-sec-title{margin:0;padding:0;border:0}
.sa-answer .sa-dl{opacity:0;transition:opacity .12s;flex:none}
.sa-answer .sa-tblsec:hover .sa-dl,.sa-answer:fullscreen .sa-dl{opacity:1}
`
let _cssInjected = false
function ensureAnswerCSS() {
  if (_cssInjected || typeof document === 'undefined') return
  _cssInjected = true
  const el = document.createElement('style'); el.id = 'sa-answer-css'; el.textContent = ANSWER_CSS
  document.head.appendChild(el)
}

// ── Front-end-only helpers for the card actions (Copy / CSV) ─────────────────────────────────────────
// We HAVE the structured answer JSON here, so copy is built from it (clean), generic across the fields the
// card shows; paragraphs separated by blank lines, the table as TSV. Add a field to the card → add it here.
// meta (qid / timing / arrival time) is appended as a SEPARATE footer after the answer body, so a pasted
// answer carries its provenance (which question, how long, when) without cluttering the answer itself.
function answerToText(a: any, cat: string, meta?: { qid?: string; at?: number; timing?: { ms: number; classifyMs?: number; modelMs?: number } }): string {
  const out: string[] = []
  if (cat) out.push(cat.toUpperCase())
  if (a.answer) out.push(Array.isArray(a.answer) ? a.answer.join('; ') : String(a.answer))
  if (a.periods?.length) out.push('Time filter: ' + a.periods.map((p: any) => `${p.label}${p.detail ? ' — ' + p.detail : ''}`).join(' · '))
  else if (a.period) out.push('Time filter: ' + a.period)
  const figs = Array.isArray(a.figures) && a.figures.length ? a.figures : a.headline?.display ? [{ label: a.headline.label, display: a.headline.display, sub: a.headline.sub }] : []
  if (figs.length) out.push(figs.map((f: any) => `${f.label}: ${f.display}${f.sub ? ` (${f.sub})` : ''}`).join('\n'))
  if (a.table?.columns) out.push([a.table.columns.join('\t'), ...(a.table.rows || []).map((r: any[]) => r.map(v => v == null ? '' : String(v)).join('\t'))].join('\n'))
  if (Array.isArray(a.sections)) for (const s of a.sections) {   // report blocks → readable text, in order
    if (s?.title) out.push(String(s.title).toUpperCase())
    if (s?.kind === 'text' && s.body) out.push(String(s.body))
    else if (s?.kind === 'kpis' && Array.isArray(s.items)) out.push(s.items.map((f: any) => `${f.label}: ${f.display}${f.sub ? ` (${f.sub})` : ''}`).join('\n'))
    else if (s?.kind === 'table' && Array.isArray(s.columns)) out.push([s.columns.join('\t'), ...(s.rows || []).map((r: any[]) => r.map((v: any) => v == null ? '' : String(v)).join('\t'))].join('\n'))
  }
  if (a.caveat) out.push('Note: ' + (Array.isArray(a.caveat) ? a.caveat.join('; ') : a.caveat))
  if (a.scope) out.push('Scope: ' + a.scope)
  if (a.source) out.push('Source: ' + a.source)
  if (a.missing) out.push('No source in the data: ' + a.missing)
  if (meta) {   // provenance footer — separated from the answer
    const fmt = (m: number) => m >= 1000 ? `${(m / 1000).toFixed(1)}s` : `${m}ms`
    const lines: string[] = []
    if (meta.qid) lines.push(`Question ID: ${meta.qid}`)
    if (meta.timing?.ms != null && meta.at) lines.push(`Initiated: ${new Date(meta.at - meta.timing.ms).toLocaleString()}`)
    if (meta.at) lines.push(`Answered: ${new Date(meta.at).toLocaleString()}`)
    if (meta.timing?.ms != null) {
      const sub = [meta.timing.classifyMs != null ? `classify ${fmt(meta.timing.classifyMs)}` : '', meta.timing.modelMs != null ? `model ${fmt(meta.timing.modelMs)}` : ''].filter(Boolean).join(' · ')
      lines.push(`Took: ${fmt(meta.timing.ms)}${sub ? ` (${sub})` : ''}`)
    }
    if (lines.length) out.push('—\n' + lines.join('\n'))
  }
  return out.join('\n\n')
}
function tableToCSV(cols: string[], rows: any[][], total?: any[]): string {
  const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const lines = [cols.map(esc).join(','), ...rows.map(r => r.map(esc).join(','))]
  if (Array.isArray(total) && total.length) lines.push(total.map(esc).join(','))   // the agent's total row, if any
  return lines.join('\n')
}
function downloadText(text: string, filename: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type: mime }); const url = URL.createObjectURL(blob)
  const el = document.createElement('a'); el.href = url; el.download = filename; document.body.appendChild(el); el.click(); el.remove(); URL.revokeObjectURL(url)
}

// Small inline icons (no icon dependency) — Feather-style, inherit currentColor. Tooltips come from the
// button's title/aria-label. Reused as shared immutable React elements.
const IC = {
  copy: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>,
  expand: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>,
  close: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>,
  download: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>,
}

const PAGE = 25   // tables show this many rows at a time; "show more" reveals another page (CSV exports ALL rows)

// Which columns read as numeric (so they right-align + get the figure weight). Same rule as the main table.
function numColsOf(cols: string[], rows: any[][]): boolean[] {
  return cols.map((_, ci) => rows.length > 0 && rows.every(r => {
    const v = r[ci]; if (v == null) return true
    return typeof v === 'number' || (typeof v === 'string' && /^[₹$€£]?\s?-?[\d,.\s]+%?$/.test(v.trim()) && /\d/.test(v))
  }))
}

// One block of a multi-block report. The answer view-model may carry `sections: Section[]`; each renders with
// the SAME visual primitives as the flat card (KPI strip, fin-table, prose) so a report is just several of them
// stacked. Kinds: 'kpis' (a labelled KPI strip), 'table' (a titled fin-table, optional `total`/`note`), 'text'
// (a titled prose block, e.g. stand-outs). Unknown kinds render nothing (forward-compatible).
function SectionBlock({ s }: { s: any }) {
  if (!s || !s.kind) return null
  if (s.kind === 'text') {
    if (!s.body) return null
    return <div className="sa-sec">{s.title && <div className="sa-sec-title">{s.title}</div>}
      <div className="sa-prose" dangerouslySetInnerHTML={{ __html: renderInlineMd(String(s.body)) }} /></div>
  }
  if (s.kind === 'kpis') {
    const items: any[] = Array.isArray(s.items) ? s.items : []
    if (!items.length) return null
    return <div className="sa-sec">{s.title && <div className="sa-sec-title">{s.title}</div>}
      <div className="sa-figs">{items.map((f: any, i: number) => (
        <div className="sa-fig" key={i} title={f.value != null ? String(f.value) : undefined}>
          <div className="k">{f.label}</div><div className={`v${f.neg ? ' neg' : ''}`}>{f.display}</div>
          {f.sub && <div className="s">{f.sub}</div>}
        </div>))}</div></div>
  }
  if (s.kind === 'table') return <DataTable columns={s.columns ?? []} rows={s.rows ?? []} total={s.total} totalRows={s.totalRows} title={s.title} note={s.note} csvName={s.title} />
  return null
}

// ── Codex event log — the 'events'-kind analyst view (the structured counterpart of the xterm 'pty' view) ──
// Renders the normalized AgentEvent stream (mirror of the engine's ica/session.ts AgentEvent) the way the
// native codex client does: command runs with collapsed output, assistant messages, reasoning, turn rules.
// One small component per event kind; events are keyed by id so a streaming block updates itself in place.
// 'user' is UI-synthesized (the question you asked) — the engine's stream vocabulary is the rest.
type AgentEvent = { kind: 'command' | 'message' | 'reasoning' | 'file' | 'turn' | 'user'; id?: string; text?: string; command?: string; output?: string; status?: string; done?: boolean }

// Merge one live event into the log: update the block with the same id (started→updated→completed), else append.
function mergeEvent(evs: AgentEvent[], e: AgentEvent): AgentEvent[] {
  if (e.id) { const i = evs.findIndex(x => x.id === e.id); if (i >= 0) { const n = evs.slice(); n[i] = e; return n } }
  return [...evs, e]
}

// A command's output, collapsed to the first few lines with a +N-lines toggle (matches the native client).
// Find the first BALANCED json object/array in a string that actually parses (string-escape aware), so a JSON
// blob embedded in a run's mixed text output can be lifted out and pretty-printed separately from the trace.
function findJsonSpan(text: string): { start: number; end: number; value: any } | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue
    let depth = 0, inStr = false, esc = false
    for (let j = i; j < text.length; j++) {
      const c = text[j]
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
      if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') { if (--depth === 0) { try { const v = JSON.parse(text.slice(i, j + 1)); if (v && typeof v === 'object') return { start: i, end: j + 1, value: v } } catch { /* not this one */ } break } }
    }
  }
  return null
}
const CODE_PRE: React.CSSProperties = { margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#54634f', fontSize: 12, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', background: '#ece8de', border: '1px solid #e0dacd', borderRadius: 4, padding: '6px 9px' }
const TRACE_TXT: React.CSSProperties = { color: '#8a8f86', fontSize: 11.5, lineHeight: 1.5, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '2px 0' }

function CmdOutput({ text, claude }: { text: string; claude?: boolean }) {
  const [open, setOpen] = useState(false)
  const raw = text.replace(/\s+$/, '')
  // claude-only: lift an embedded JSON blob out of mixed output → pretty-print it apart from the run trace.
  const span = claude ? findJsonSpan(raw) : null
  const pre = span ? raw.slice(0, span.start).trim() : ''
  const post = span ? raw.slice(span.end).trim() : ''
  let main = span ? JSON.stringify(span.value, null, 2) : raw
  if (!span && claude) { const t = raw.trim(); if (/^[[{]/.test(t)) { try { main = JSON.stringify(JSON.parse(t), null, 2) } catch { /* node-inspect etc. → as-is */ } } }
  const lines = main.split('\n')
  const CAP = 12, hidden = lines.length - CAP
  const shown = open || hidden <= 0 ? lines : lines.slice(0, CAP)
  return (
    <div style={{ marginTop: 4 }}>
      {pre && <div style={TRACE_TXT}>{pre}</div>}
      {main.trim() && <pre style={CODE_PRE}>{shown.join('\n')}</pre>}
      {post && <div style={TRACE_TXT}>{post}</div>}
      {hidden > 0 && <span onClick={() => setOpen(o => !o)} style={{ cursor: 'pointer', color: '#8a7a3a', fontSize: 11, userSelect: 'none' }}>{open ? '▲ show less' : `▾ +${hidden} lines`}</span>}
    </div>
  )
}

function CodexEvent({ e, claude }: { e: AgentEvent; claude?: boolean }) {
  const mono = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' as const }
  if (e.kind === 'turn') return <div style={{ borderTop: '1px solid #ddd6ca', margin: '14px 0' }} />
  if (e.kind === 'user') return (
    <div style={{ margin: '16px 0 10px', paddingTop: 12, borderTop: '1px solid #ddd6ca', color: '#1a1a1a', fontSize: 13.5, fontWeight: 600 }}>
      <span style={{ color: '#9aa79b' }}>›</span> {e.text}
    </div>
  )
  if (e.kind === 'command') return (
    <div style={{ margin: '9px 0' }}>
      <div style={{ color: '#2f3d2c', fontSize: 12.5, ...mono }}>
        <span style={{ color: e.status === 'in_progress' ? '#b07d1a' : '#3a7d3a' }}>●</span>{' '}
        <span style={{ color: '#6b7a6c' }}>Ran</span> {e.command}
      </div>
      {e.output ? <CmdOutput text={e.output} claude={claude} /> : null}
    </div>
  )
  if (e.kind === 'file') return (
    <div style={{ margin: '9px 0' }}>
      <div style={{ color: '#2f3d2c', fontSize: 12.5, ...mono }}>
        <span style={{ color: '#3a7d3a' }}>●</span> <span style={{ color: '#6b7a6c' }}>Edited</span> {(e.text || '').split('/').slice(-3).join('/')}
      </div>
      {e.output ? <CmdOutput text={e.output} claude={claude} /> : null}
    </div>
  )
  const muted = e.kind === 'reasoning'   // reasoning is subdued; a message is the prominent prose
  const color = muted ? '#7a857c' : '#263124'
  // claude-only: a long PROSE message reads better broken into sentences (never applied to command OUTPUT,
  // which can be code). Only split when there's genuinely more than one sentence.
  if (claude && !muted && e.text) {
    const parts = e.text.split(/(?<=[.!?])\s+(?=[A-Z(])/).map((s) => s.trim()).filter(Boolean)
    if (parts.length > 1) return (
      <div style={{ margin: '9px 0', color: '#263124', fontSize: 13, lineHeight: 1.55 }}>
        {parts.map((p, i) => <div key={i} style={{ margin: '3px 0' }} dangerouslySetInnerHTML={{ __html: renderInlineMd(p) }} />)}
      </div>
    )
  }
  return <div style={{ margin: '9px 0', color, fontSize: 13, lineHeight: 1.55, fontStyle: muted ? 'italic' : 'normal' }}
    dangerouslySetInnerHTML={{ __html: renderInlineMd(e.text ?? '') }} />
}

// Codex reasons SILENTLY before its next action (no event streams during that phase), so a turn can look
// stuck. Show a "thinking…" line whenever the turn is busy but nothing is actively streaming (the last event
// has completed / there's no event yet) — the fact it's working, without exposing the reasoning content.
function ThinkingLine() {
  const [n, setN] = useState(1)
  useEffect(() => { const t = setInterval(() => setN(x => (x % 3) + 1), 420); return () => clearInterval(t) }, [])
  return <div style={{ color: '#9a7b1a', fontSize: 12.5, fontStyle: 'italic', margin: '9px 0' }}>◐ agent is thinking{'.'.repeat(n)}</div>
}

function CodexEventLog({ events, busy, claude }: { events: AgentEvent[]; busy?: boolean; claude?: boolean }) {
  const last = events[events.length - 1]
  const streaming = !!last && last.done === false && (last.kind === 'command' || last.kind === 'message' || last.kind === 'reasoning')
  const thinking = !!busy && !streaming   // busy but nothing actively streaming ⇒ reasoning between steps
  if (!events.length && !thinking) return null
  return <div>
    {events.map((e, i) => <CodexEvent key={e.id ?? `turn${i}`} e={e} claude={claude} />)}
    {thinking && <ThinkingLine />}
  </div>
}

// The ONE table renderer — used by both the flat answer table AND each report section, so both get the same
// features: numeric right-alignment, a total/summary footer, "show more" pagination, CSV download, and the honest
// "N of TOTAL matching rows" count. Each instance owns its own pagination + download state.
function DataTable({ columns, rows, total, totalRows, title, note, csvName }: {
  columns: string[]; rows: any[][]; total?: any[]; totalRows?: number; title?: string; note?: string; csvName?: string
}) {
  const [shown, setShown] = useState(PAGE)
  const [downloaded, setDownloaded] = useState(false)
  const numc = numColsOf(columns, rows)
  const visible = rows.slice(0, shown)
  const doDownload = () => { downloadText(tableToCSV(columns, rows, total), `${(csvName || 'table').trim().replace(/\s+/g, '-') || 'table'}.csv`); setDownloaded(true); setTimeout(() => setDownloaded(false), 1600) }
  return (
    <div className="sa-tblsec">
      {/* title + download on ONE row; the download reveals on hover (no dead space, no always-on button) */}
      <div className="sa-tbl-head">
        <div className="sa-sec-title">{title || ''}</div>
        <button className="sa-ic sa-dl" onClick={doDownload} title={downloaded ? 'Downloaded' : 'Download CSV'} aria-label="Download CSV">{downloaded ? IC.check : IC.download}</button>
      </div>
      <div className="sa-scroll">
        <table className="sa-fin num">
          <thead><tr>{columns.map((c, i) => <th key={i} className={numc[i] ? 'r' : ''}>{c}</th>)}</tr></thead>
          <tbody>{visible.map((r, ri) => (
            <tr key={ri}>{r.map((v, ci) => (
              <td key={ci} className={numc[ci] ? 'r fig' : ''}>{typeof v === 'number' ? v.toLocaleString() : String(v ?? '')}</td>
            ))}</tr>))}</tbody>
          {Array.isArray(total) && total.length > 0 && (
            <tfoot><tr className="sa-total">{columns.map((_, i) => {
              const v = total[i]
              return <td key={i} className={numc[i] ? 'r' : ''}>{typeof v === 'number' ? v.toLocaleString() : String(v ?? '')}</td>
            })}</tr></tfoot>)}
        </table>
      </div>
      {shown < rows.length && (
        <div className="sa-more" onClick={() => setShown(s => Math.min(s + PAGE, rows.length))}>Show more data ({(rows.length - shown).toLocaleString()} more)</div>
      )}
      <div className="sa-count">
        {totalRows != null && totalRows > rows.length
          ? `${rows.length.toLocaleString()} of ${totalRows.toLocaleString()} matching rows`
          : `${rows.length.toLocaleString()} row${rows.length === 1 ? '' : 's'}`}{note ? ` · ${note}` : ''}
      </div>
    </div>
  )
}

function AnswerCard({ answer: a, category, timing, qid, at }: { answer: any; category?: string; timing?: { ms: number; classifyMs?: number; modelMs?: number }; qid?: string; at?: number }) {
  ensureAnswerCSS()
  const cardRef = useRef<HTMLDivElement>(null)
  const hoverRef = useRef(false)   // is the pointer over THIS card? drives the "F = toggle fullscreen" hotkey
  const scrollYRef = useRef(0)     // page scroll captured on ENTER fullscreen, restored on EXIT (browser loses it)
  const wasFullRef = useRef(false) // was THIS card the fullscreen element last event? so only it restores scroll
  const [full, setFull] = useState(false)
  const [copied, setCopied] = useState(false)
  // Native fullscreen: the card element itself goes full screen (no portal) — the table is then crisp.
  useEffect(() => {
    const onFs = () => {
      const nowFull = document.fullscreenElement === cardRef.current
      // Exiting fullscreen: the browser drops the page scroll (crawls up to a different card). Put it back where
      // the user was — on the next frame, after the browser has finished restoring the normal document.
      if (wasFullRef.current && !nowFull) { const y = scrollYRef.current; requestAnimationFrame(() => window.scrollTo(0, y)) }
      wasFullRef.current = nowFull
      setFull(nowFull)
    }
    document.addEventListener('fullscreenchange', onFs)
    return () => document.removeEventListener('fullscreenchange', onFs)
  }, [])
  // Press "F" while hovering a card to toggle its fullscreen (Escape / F again exits — native). We ignore the
  // key when typing (an input/textarea/contenteditable is focused, or a browser find via Cmd/Ctrl+F) so it
  // still types an "f" there. hoverRef (not state) keeps this bound once with no stale closure.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key !== 'f' && e.key !== 'F') || e.metaKey || e.ctrlKey || e.altKey || !hoverRef.current) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
      e.preventDefault()
      const el = cardRef.current; if (!el) return
      if (document.fullscreenElement === el) document.exitFullscreen?.()
      else { scrollYRef.current = window.scrollY; el.requestFullscreen?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  if (!a) return null
  const isTerminal = a.status === 'unknowable' || a.status === 'cannot_answer'  // genuinely can't answer
  const cat = (category || '').replace(/_/g, ' ')
  const secs = (m?: number) => m == null ? '' : m >= 1000 ? `${(m / 1000).toFixed(1)}s` : `${m}ms`
  const figs: any[] = Array.isArray(a.figures) && a.figures.length ? a.figures
    : a.headline?.display ? [{ label: a.headline.label, display: a.headline.display, sub: a.headline.sub, value: a.headline.value, neg: a.headline.neg }]
    : []
  const doCopy = () => { try { navigator.clipboard.writeText(answerToText(a, cat, { qid, at, timing })); setCopied(true); setTimeout(() => setCopied(false), 1400) } catch { /* clipboard blocked */ } }
  const toggleFull = () => { const el = cardRef.current; if (!el) return; if (document.fullscreenElement === el) document.exitFullscreen?.(); else { scrollYRef.current = window.scrollY; el.requestFullscreen?.() } }

  return (
    <div ref={cardRef} data-qid={qid} className={`sa-answer num${isTerminal ? ' warn' : ''}`}
      onMouseEnter={() => { hoverRef.current = true }} onMouseLeave={() => { hoverRef.current = false }}>
      {/* hover actions — small icon buttons, top-right (tooltips via title); always visible in fullscreen */}
      <div className="sa-actions">
        <button className="sa-ic" onClick={doCopy} title={copied ? 'Copied' : 'Copy'} aria-label="Copy">{copied ? IC.check : IC.copy}</button>
        <button className="sa-ic" onClick={toggleFull} title={full ? 'Exit full screen' : 'Full screen'} aria-label="Full screen">{full ? IC.close : IC.expand}</button>
      </div>
      <div className={`sa-type${isTerminal ? ' warn' : ''}`}>{isTerminal ? "Can't answer" : (cat || 'Answer')}</div>
      {a.answer && <div className="sa-prose" dangerouslySetInnerHTML={{ __html: renderAnswerBody(a.answer) }} />}
      {(a.periods?.length > 0 || a.period) && (
        <div className="sa-period"><span className="pk">Time filter</span>
          {a.periods?.length > 0
            ? a.periods.map((p: any, i: number) => <span key={i}><b>{p.label}</b>{p.detail ? ` — ${p.detail}` : ''}{i < a.periods.length - 1 ? '   ·   ' : ''}</span>)
            : <b>{a.period}</b>}
        </div>
      )}
      {figs.length > 0 && (
        <div className="sa-figs">
          {figs.map((f: any, i: number) => (
            <div className="sa-fig" key={i} title={f.value != null ? String(f.value) : undefined}>
              <div className="k">{f.label}</div>
              <div className={`v${f.neg ? ' neg' : ''}`}>{f.display}</div>
              {f.sub && <div className="s">{f.sub}</div>}
            </div>
          ))}
        </div>
      )}
      {/* All tabular/blocked results render through `sections` (the ONE format). The old flat top-level `table`
          renderer was removed — the analyst now emits a `table` section even for a single table. */}
      {Array.isArray(a.sections) && a.sections.map((s: any, i: number) => <SectionBlock key={i} s={s} />)}
      {a.caveat && <div className="sa-caveat" dangerouslySetInnerHTML={{ __html: renderAnswerBody(a.caveat) }} />}
      {a.scope && <div className="sa-src"><b>Scope:</b> {a.scope}</div>}
      {a.source && <div className="sa-src"><b>Source:</b> {a.source}</div>}
      {a.missing && <div className="sa-caveat">No source in the data: {a.missing}</div>}
      {timing?.ms != null && (
        <div className="sa-foot">
          {timing.modelMs ? <span>model build {secs(timing.modelMs)}</span> : null}
          {timing.classifyMs != null ? <span>classify {secs(timing.classifyMs)}</span> : null}
          <span title="total wall time">total {secs(timing.ms)}</span>
        </div>
      )}
    </div>
  )
}

// Minimal, safe inline markdown: escape HTML first, then bold/italic/code + breaks.
// Inline-only emphasis applied WITHIN one line \u2014 bold and code ONLY (italics deliberately not parsed: it
// reads oddly in these cards, and the model is told not to use it).
function inlineMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}
// Light block markdown for answer/section prose: bold/italic/code inline, PLUS a run of lines that start with
// "- " (or "\u2022 ") becomes a real bulleted list. Everything else is plain paragraph text with <br/> line breaks.
// Not full markdown \u2014 just enough that a list-shaped takeaway reads as bullets and key figures can be bolded.
function renderInlineMd(text: string): string {
  const clean = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, '').replace(/ {2,}/g, ' ')
  const esc = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out: string[] = []
  let para: string[] = [], bullets: string[] = [], numbers: string[] = []
  const flushPara = () => { if (para.length) { out.push(para.join('<br/>')); para = [] } }
  const flushBul = () => { if (bullets.length) { out.push(`<ul class="sa-list">${bullets.join('')}</ul>`); bullets = [] } }
  const flushNum = () => { if (numbers.length) { out.push(`<ol class="sa-olist">${numbers.join('')}</ol>`); numbers = [] } }
  const flushAll = () => { flushPara(); flushBul(); flushNum() }
  for (const ln of esc.split('\n')) {
    const b = ln.match(/^\s*[-\u2022]\s+(.*)/)
    const n = ln.match(/^\s*\d+[.)]\s+(.*)/)   // "1. " / "2) " \u2192 a real numbered list (needs a . or ) right after the digits, so "1338 lanes" is NOT a list item)
    if (b) { flushPara(); flushNum(); bullets.push(`<li>${inlineMd(b[1])}</li>`) }
    else if (n) { flushPara(); flushBul(); numbers.push(`<li>${inlineMd(n[1])}</li>`) }
    else if (ln.trim() === '') { flushAll() }
    else { flushBul(); flushNum(); para.push(inlineMd(ln)) }
  }
  flushAll()
  return out.join('')
}

// A takeaway (answer/caveat) is EITHER a string (a paragraph) OR an array of item strings (a list) — the
// program returns one or the other; the UI decides how it renders. A string, or an array of ONE item, is
// plain text (no bullet). Only an array of MORE THAN ONE item becomes a list.
function renderAnswerBody(answer: unknown): string {
  if (Array.isArray(answer)) {
    if (answer.length <= 1) return renderInlineMd(String(answer[0] ?? ''))   // single item → plain text, no bullet
    return renderInlineMd(answer.map((it) => `- ${String(it)}`).join('\n'))   // several → a list
  }
  return renderInlineMd(String(answer ?? ''))
}

function Spinner() {
  return (
    <div style={{ width: 12, height: 12, border: '2px solid #e8e4de', borderTopColor: '#e55a1f',
                  borderRadius: '50%', animation: 'spin .8s linear infinite', flexShrink: 0 }} />
  )
}

const s: Record<string, React.CSSProperties> = {
  shell:       { display: 'flex', minHeight: '100vh', background: '#f5f3ef' },
  sidebar:     { width: 260, flexShrink: 0, background: '#fbfaf8', color: '#1a1a1a',
                 borderRight: '1px solid #e8e4de', display: 'flex', flexDirection: 'column',
                 height: '100vh', position: 'sticky', top: 0 },
  newChat:     { margin: 12, padding: '9px 12px', borderRadius: 8, border: '1px solid #e8e4de',
                 background: '#fff', color: '#1a1a1a', fontSize: 13, fontWeight: 600, cursor: 'pointer', textAlign: 'left' },
  sessionList: { flex: 1, overflowY: 'auto', padding: '0 8px 12px' },
  sessionItem: { padding: '9px 10px', borderRadius: 8, fontSize: 13, cursor: 'pointer', color: '#3a3a3a',
                 whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginBottom: 2 },
  sessionItemActive: { background: '#efece7', color: '#1a1a1a', fontWeight: 600 },
  navSection:  { padding: '14px 14px 4px', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', color: '#a49e93' },
  semHeader:   { display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', borderBottom: '1px solid #eee7dd', flexShrink: 0 },
  catChip:     { fontSize: 11, fontWeight: 600, color: '#7fae82', background: '#1e2a1f', border: '1px solid #33402f', borderRadius: 10, padding: '2px 8px', textTransform: 'capitalize' as const },
  catChipLight:{ fontSize: 11, fontWeight: 600, color: '#5a7a5c', background: '#eef3ec', border: '1px solid #dbe6db', borderRadius: 10, padding: '2px 8px', textTransform: 'capitalize' as const },
  backBtn:     { fontSize: 12, fontWeight: 600, color: '#8a8276', background: 'transparent', border: '1px solid #3a4038', borderRadius: 8, padding: '3px 10px', cursor: 'pointer' },
  sessionEmpty: { padding: '10px', fontSize: 12, color: '#9a9285' },
  page:        { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: '100vh',
                 fontFamily: 'system-ui, sans-serif', background: '#f5f3ef' },
  stickyHeader:{ position: 'sticky', top: 0, zIndex: 20 },
  topbar:      { position: 'sticky', top: 0, zIndex: 10, display: 'flex', alignItems: 'center',
                 gap: 12, padding: '10px 24px', background: '#fff',
                 borderBottom: '1px solid #e8e4de', flexShrink: 0 },
  logo:        { fontWeight: 700, fontSize: 14 },
  statusChip:  { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12,
                 color: '#9a9285', background: '#f5f3ef', padding: '4px 10px', borderRadius: 20 },
  dot:         { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  roleToggle:  { display: 'flex', border: '1px solid #e8e4de', borderRadius: 20, overflow: 'hidden' },
  roleBtn:     { border: 'none', background: 'transparent', fontSize: 12, padding: '4px 12px',
                 cursor: 'pointer', color: '#9a9285' },
  roleBtnActive: { background: '#1a1a1a', color: '#fff' },
  consolidateBtn: { border: '1px solid #e8e4de', borderRadius: 20, background: '#fff', fontSize: 12,
                    padding: '4px 12px', cursor: 'pointer', color: '#6b6560' },
  logBar:      { background: '#1e1e1e', color: '#9a9285', fontSize: 12, fontFamily: 'monospace',
                 padding: '6px 24px', cursor: 'pointer', userSelect: 'none', flexShrink: 0 },
  logPanel:    { background: '#1a1a1a', color: '#c8c4be', fontFamily: 'monospace', fontSize: 12,
                 lineHeight: 1.6, padding: '10px 24px', maxHeight: 220, overflowY: 'auto',
                 flexShrink: 0 },
  feed:        { flex: 1, padding: '24px 16px 100px', display: 'flex', flexDirection: 'column',
                 gap: 14, maxWidth: 760, margin: '0 auto', width: '100%' },
  empty:       { color: '#9a9285', fontSize: 14, textAlign: 'center', marginTop: 60 },
  welcome:     { maxWidth: 760, margin: '40px auto 0', padding: '0 8px' },
  welcomeTitle:{ fontSize: 20, fontWeight: 700, color: '#3a352f', marginBottom: 22 },
  sgGroup:     { marginBottom: 18 },
  sgConcept:   { fontSize: 11, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: '#9a9285', marginBottom: 8 },
  sgChips:     { display: 'flex', flexWrap: 'wrap', gap: 8 },
  sgChip:      { background: '#fff', border: '1px solid #e2ddd4', borderRadius: 10, padding: '9px 13px',
                 fontSize: 13, color: '#4a453f', cursor: 'pointer', textAlign: 'left', lineHeight: 1.35,
                 transition: 'background 0.12s' },
  userMsg:     { background: '#1a1a1a', color: '#fff', borderRadius: 12, padding: '10px 16px',
                 fontSize: 14, alignSelf: 'flex-end', maxWidth: '80%' },
  narrative:   { background: '#fff', border: '1px solid #e8e4de', borderRadius: 12,
                 padding: '14px 18px', fontSize: 14, lineHeight: 1.65, color: '#1a1a1a' },
  step:        { fontSize: 12.5, color: '#9a9285', fontFamily: 'ui-monospace, monospace',
                 padding: '2px 6px', lineHeight: 1.5 },
  componentSlot: { minHeight: 60 },
  promptBar:   { position: 'fixed', bottom: 0, left: 260, right: 0, padding: '12px 24px',
                 background: '#fff', borderTop: '1px solid #e8e4de',
                 display: 'flex', gap: 10, flexShrink: 0 },
  input:       { flex: 1, background: '#f5f3ef', border: '1px solid #e8e4de', borderRadius: 8,
                 padding: '9px 14px', fontSize: 14, outline: 'none', fontFamily: 'inherit' },
  sendBtn:     { border: 'none', borderRadius: 8, padding: '9px 20px',
                 fontSize: 14, fontWeight: 600, cursor: 'pointer' },

  // Floating top-right controls (no header bar)
  floatControls: { position: 'fixed', top: 14, right: 20, zIndex: 30, display: 'flex',
                   alignItems: 'center', gap: 10 },

  // Account section pinned to the bottom of the sidebar
  acct:        { display: 'flex', alignItems: 'center', gap: 10, padding: 12, marginTop: 'auto',
                 borderTop: '1px solid #e8e4de' },
  avatar:      { width: 30, height: 30, borderRadius: '50%', background: '#e55a1f', color: '#fff',
                 fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  acctName:    { fontSize: 13, fontWeight: 600, color: '#2a2620', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  acctPlan:    { fontSize: 11.5, color: '#9a9285' },

  // ChatGPT-style composer
  centerStage: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                 justifyContent: 'center', padding: '0 24px 80px', width: '100%' },
  bottomBar:   { position: 'fixed', bottom: 0, left: 260, right: 0, padding: '8px 24px 18px',
                 display: 'flex', justifyContent: 'center', zIndex: 5,
                 background: 'linear-gradient(to top, #f5f3ef 62%, rgba(245,243,239,0))' },
  composer:    { width: '100%', background: '#fff', border: '1px solid #e6e1d8', borderRadius: 26,
                 boxShadow: '0 2px 14px rgba(70,55,30,0.06)', padding: '6px 10px', display: 'flex' },
  composerTextarea: { border: 'none', outline: 'none', resize: 'none', background: 'transparent',
                 fontFamily: 'inherit', fontSize: 15.5, lineHeight: 1.5, color: '#2a2620',
                 padding: '8px 4px', maxHeight: 200, overflowY: 'auto' },
  bottomStrip: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  attachBtn:   { border: 'none', background: 'transparent', color: '#6b6560', cursor: 'pointer',
                 padding: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  sendCircle:  { width: 36, height: 36, borderRadius: '50%', border: 'none', display: 'flex',
                 alignItems: 'center', justifyContent: 'center', padding: 0, flexShrink: 0 },
  suggestRow:  { padding: '9px 14px', background: '#fff', border: '1px solid #e8e4de', borderRadius: 10,
                 marginBottom: 6, cursor: 'pointer', fontSize: 14.5, color: '#3a3630', transition: 'border-color .12s' },
}
