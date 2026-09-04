import { useState, useEffect, useRef, useCallback, memo } from 'react'
import { renderInlineMd, renderAnswerBody, cellValue, cellText, cellId, cellEntity, colLabel, colSpec, formatNumber, isObj_display, type Cell, type Column, type ColumnSpec } from './format'
import { CodexEventLog, mergeEvent, type AgentEvent } from './agentEventLog'
import { useSession, SignIn, UserButton, useUser } from '@clerk/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './design.css'   // BUNDLED (hashed, loaded atomically with the app) — not a fragile separate <link href="/design.css">, which intermittently failed to attach and left the UI unstyled
import { useClaudeTerminal } from './useClaudeTerminal'
import { useQuestionNav } from './questionNav'
import { useLogNav } from './logNav'
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

  // ── The session cookie ──────────────────────────────────────────────────────
  // This app authenticates every call with a header, which is fine while its own JS is running. A plain
  // NAVIGATION carries no header — nothing of ours has run yet — so anything served as a page rather than
  // fetched by this app cannot be authorised at all. That is what a dashboard is.
  //
  // Handing the same token to the browser as a cookie closes it. Done on every load, not only when the token
  // is first minted: the cookie expires on its own schedule and a token kept in localStorage would otherwise
  // never renew it.
  //
  // `?next=` is how a gated page sends someone here to sign in. Once the cookie exists, go back to it.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    fetch('/api/auth/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      .then((r) => {
        if (cancelled || !r.ok) return
        const next = new URLSearchParams(location.search).get('next')
        // Only a path on this site — never an absolute URL, which would be an open redirect.
        if (!next || !next.startsWith('/') || next.startsWith('//')) return
        // ONCE. Being signed in is not the same as being allowed: someone with no access to this project would
        // otherwise bounce between the gated page and here for ever, each side doing exactly its job. One
        // attempt, then the gate's own 401 is left to speak.
        const tried = `sa-next:${next}`
        if (sessionStorage.getItem(tried)) return
        sessionStorage.setItem(tried, '1')
        location.replace(next)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token])

  if (!isSignedIn) return <div style={{ maxWidth: 420, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui' }}><h2>Superatom</h2><SignIn /></div>
  if (!projectId) return <div style={{ maxWidth: 480, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui', color: '#8a8276' }}>No project selected. Open this app with <code>?project=&lt;id&gt;</code>.</div>
  if (!token)     return <div style={{ maxWidth: 420, margin: '110px auto', textAlign: 'center', fontFamily: 'system-ui', color: '#8a8276' }}>Signing in…</div>
  return <App token={token} projectId={projectId} />
}

type View = 'chat' | 'analyst' | 'composer' | 'modeler'   // the tabs: chat (answers) + the two agent-log views
type FeedItem =
  | { id: string; type: 'user-msg'; text: string }
  | { id: string; type: 'step'; text: string }
  | { id: string; type: 'narrative'; text: string }
  | { id: string; type: 'component'; tag: string; vTag: string; code: string; data: any }
  | { id: string; type: 'answer'; category?: string; answer: any; timing?: { ms: number; classifyMs?: number; modelMs?: number }; qid?: string; at?: number }   // the analyst's structured result, rendered as a card (qid = the question id; at = when the answer arrived)
  | { id: string; type: 'analysis'; beats: string[]; secs?: number[]; qid?: string }   // the receptionist's beats (+ frozen per-beat seconds) — its OWN collapsed card, rendered EXACTLY like the live analysis
  | { id: string; type: 'followups'; items: string[]; qid?: string }   // suggested next questions — a DELAYED card below the answer; a chip FILLS the input (never auto-submits)
  | { id: string; type: 'error'; text: string }

// A ROLLING localStorage copy of an agent-log (last 6 sessions, ≤400 events each) so a RELOAD restores it — the DO
// deliberately doesn't store this heavy real-time log. Restore on mount only (never clobber live events). Shared by
// every agent-log view (analyst / composer) so they persist identically.
// ── localStorage, quota-safe ─────────────────────────────────────────────────────────────────────────────────
// The browser gives us ~5MB and THROWS once it's full — an uncaught QuotaExceededError breaks the render, which
// is how a long session took the UI down. Every write goes through here: on a quota failure we free space in
// least-precious-first order and retry, and give up quietly rather than throw.
//   1. agent LOGS of other sessions  — biggest by far, and replayable from the engine
//   2. FEEDS of other sessions       — the answers you're not looking at
// The current session's data is never evicted, so what's on screen survives.
const LOG_PREFIXES = ['sa-anlog-', 'sa-colog-', 'sa-molog-']
function safeSetItem(key: string, value: string, keepSuffix: string): boolean {
  const put = () => { try { localStorage.setItem(key, value); return true } catch { return false } }
  if (put()) return true
  const drop = (pred: (k: string) => boolean) => {
    const victims = Object.keys(localStorage).filter(k => k !== key && pred(k))
    victims.forEach(k => { try { localStorage.removeItem(k) } catch { /* ignore */ } })
    return victims.length > 0
  }
  if (drop(k => LOG_PREFIXES.some(p => k.startsWith(p)) && !k.endsWith(keepSuffix)) && put()) return true
  if (drop(k => k.startsWith('sa-feed:') && !k.endsWith(keepSuffix)) && put()) return true
  return false   // still full — skip this write; the app keeps running on in-memory state
}

// What gets PERSISTED is trimmed hard: command output is the bulk of a log and is only useful live, so keep a
// head of it. This is what stops the quota being reached in the first place.
const OUT_CAP = 1200
const slimForStorage = (evs: AgentEvent[]) => evs.slice(-200).map(e =>
  e.output && e.output.length > OUT_CAP ? { ...e, output: e.output.slice(0, OUT_CAP) + '\n… (truncated)' } : e)

function usePersistLog(prefix: string, sessionId: string, events: AgentEvent[], setEvents: React.Dispatch<React.SetStateAction<AgentEvent[]>>) {
  useEffect(() => {
    // Restore this session's saved log. Decide "is it empty?" from the CURRENT state inside the setter, not from
    // the `events` captured when this effect was created — that stale closure is why a log sometimes stayed blank
    // until you asked a question or reopened a chat (the effect saw a non-empty snapshot and bailed).
    try {
      const raw = localStorage.getItem(prefix + sessionId)
      if (raw) { const saved = JSON.parse(raw) as AgentEvent[]; if (saved?.length) setEvents(cur => cur.length ? cur : saved) }
    } catch { /* corrupt/oversized */ }
  }, [sessionId])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!events.length) return
    const t = setTimeout(() => {
      try {
        safeSetItem(prefix + sessionId, JSON.stringify(slimForStorage(events)), sessionId)
        const idx: string[] = [sessionId, ...(JSON.parse(localStorage.getItem(prefix + 'index') || '[]') as string[]).filter((s) => s !== sessionId)]
        while (idx.length > 4) { const drop = idx.pop(); if (drop) localStorage.removeItem(prefix + drop) }
        localStorage.setItem(prefix + 'index', JSON.stringify(idx))
      } catch { /* localStorage full/blocked — best-effort */ }
    }, 500)
    return () => clearTimeout(t)
  }, [events, sessionId])   // eslint-disable-line react-hooks/exhaustive-deps
}

export function App({ token, projectId = 'default' }: { token?: string | null; projectId?: string } = {}) {
  const [feed, setFeed]               = useState<FeedItem[]>([])
  const [suggestions, setSuggestions] = useState<{ title?: string; groups: Array<{ concept: string; questions: string[] }> }>({ groups: [] })
  const [busy, setBusy]               = useState(false)
  const [connected, setConnected]     = useState(false)
  const [status, setStatus]           = useState('')
  const [logOpen, setLogOpen]   = useState(true)   // Claude live-output drawer open by default
  const [hasLog, setHasLog]     = useState(false)
  // The main view lives in the URL PATH at ROOT (the subdomain serves the user app for ANY path): a chat is
  // /c/<id>, the other views are /analyst and /semantic. A reload / shared link lands on the same view.
  // `navigate` pushes a history entry; popstate syncs it back.
  const readView = (): View => {
    const seg = location.pathname.replace(/\/+$/, '').split('/').pop()
    return seg === 'analyst' || seg === 'composer' || seg === 'modeler' ? seg : 'chat'
  }
  const [view, setView] = useState<View>(readView)
  const navigate = useCallback((v: View) => {
    history.pushState(null, '', v === 'chat' ? `/c/${sidRef.current}${location.search}` : `/${v}`)
    setView(v)
  }, [])
  useEffect(() => {
    const onPop = () => setView(readView())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // Switching to CHAT → jump to the newest content (the page feed didn't move while you were away). The
  // analyst/semantic logs own their own open/follow/nav behaviour separately — see useLogNav below.
  useEffect(() => { if (view === 'chat') scroll(true) }, [view])   // eslint-disable-line react-hooks/exhaustive-deps

  // Chat feed: Shift+Up/Down jump between questions, scrolling the PAGE (see questionNav.ts).
  useQuestionNav(() => readView() === 'chat')
  // Analyst tab — the QA agent (classify → claude-code answers from the semantic model + units).
  const [anStatus, setAnStatus]     = useState('')
  const [anCategory, setAnCategory] = useState('')
  const [anQuestion, setAnQuestion] = useState('')
  const [anAnswer, setAnAnswer]     = useState<any>(null)   // structured out/answer.json
  const [anBusy, setAnBusy]         = useState(false)
  const [anProgress, setAnProgress] = useState('')   // clean live narration from the agent (no tool calls)
  const [narrationLog, setNarrationLog]     = useState<string[]>([])   // receptionist (narrator) beats for THIS question — ACCUMULATE (never overwrite)
  const narrationLogRef                 = useRef<string[]>([])     // latest beats, readable inside ws handlers (state is stale in closures)
  const narrationTimesRef               = useRef<number[]>([])     // arrival ms per beat — drives the per-step live timer (UI-only, nice-to-have)
  // WHERE each beat came from. The narrator's beats are a story about the work; a program's are the work
  // itself, and reading them as the same voice is how a three-minute query looked like the agent thinking.
  // `detail` carries the full text behind a truncated line (a query's SQL), revealed on click.
  const narrationMetaRef                = useRef<Array<{ kind: 'narrator' | 'program'; detail?: string }>>([])
  // Which collapsed runs of program beats the reader has opened, keyed by the first beat in the run.
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set())
  const [nowMs, setNowMs]           = useState(0)              // ticks every 1s while busy so the CURRENT beat's timer counts up
  // How to render the analyst's raw stream: 'pty' = a real terminal (claude-code) → xterm; 'events' =
  // discrete agent events (codex/SDK) → a plain event log (a terminal emulator makes no sense for these).
  const [anStreamKind, setAnStreamKind] = useState<'pty' | 'events'>('events')   // default = structured (claude via JSONL, codex); PTY is opt-in
  const anStreamKindRef = useRef<'pty' | 'events'>('events')
  const [anEvents, setAnEvents] = useState<AgentEvent[]>([])   // structured event log when kind === 'events' (codex)
  const [anHasPty, setAnHasPty] = useState(false)       // claude-code: a raw PTY terminal is also available (show the toggle)
  const [anTerminal, setAnTerminal] = useState(false)   // user opened the raw terminal → attach the PTY (lazily) and render xterm
  const [coEvents, setCoEvents] = useState<AgentEvent[]>([])   // COMPOSER log (composer-log channel) — its own view, separate from the analyst
  const [askTick, setAskTick] = useState(0)                    // bumps on every new question → useLogNav jumps each log view to it
  const anLogRef = useRef<HTMLDivElement>(null)
  const coLogRef = useRef<HTMLDivElement>(null)
  const [moEvents, setMoEvents] = useState<AgentEvent[]>([])   // CONCEPT MODELLER log (concept-log channel)
  const moLogRef = useRef<HTMLDivElement>(null)
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
  // Analyst agent panel — its OWN terminal (fixed 120-col claude PTY width).
  const anTermRef   = useRef<HTMLDivElement>(null)
  const anXtermRef  = useRef<Terminal | null>(null)

  // ── Chat sessions ──────────────────────────────────────────────────────────
  // Each chat is a session with id in the URL as /c/<id>. The engine stores nothing, so the chat LIST
  // and each chat's FEED are persisted client-side in localStorage — so a reload restores your chats
  // and their answers. (The engine separately re-syncs the LIVE terminal + in-flight run on reconnect.)
  // Keys are SCOPED BY PROJECT so switching projects doesn't show another project's chats/feeds/history.
  const SKEY = `sa-sessions:${projectId}`, fkey = (id: string) => `sa-feed:${projectId}:${id}`
  const loadSessions = (): { id: string; title: string; createdAt: number }[] => {
    // Chats already saved before this carried `updatedAt` (which selection kept bumping) — adopt it as the
    // creation stamp so existing lists keep a sensible order and stop moving from here on.
    try {
      const raw = JSON.parse(localStorage.getItem(SKEY) || '[]') as any[]
      return raw.map(s => ({ id: s.id, title: s.title, createdAt: s.createdAt ?? s.updatedAt ?? 0 }))
    } catch { return [] }
  }
  const loadFeed = (id: string): FeedItem[] => { try { return JSON.parse(localStorage.getItem(fkey(id)) || '[]') } catch { return [] } }
  const [sessions, setSessions] = useState(loadSessions)
  const [proj, setProj] = useState<{ id?: string; name?: string } | null>(null)   // read-only project info from the ProjectDO (welcome)
  const newId = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2))
  const readSid = () => (location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)/)?.[1] ?? '')
  // The session id comes from the URL (/c/<id>). Opening an agent tab directly (/composer, /analyst, /modeler) has
  // no /c/<id>, so falling straight to newId() would mint a FRESH session — and every per-session store (the logs,
  // the feed) would look up a key that has never existed and come back empty. Fall back to the most recent saved
  // session first, so a cold load on any tab lands on the chat you were actually in.
  const [sessionId, setSessionId] = useState<string>(() => readSid() || loadSessions()[0]?.id || newId())
  const sidRef = useRef(sessionId); sidRef.current = sessionId
  const vtagCtr = useRef(0)
  // Make sure the CHAT view's URL carries the session id — but don't clobber /analyst or /semantic on load.
  useEffect(() => { if (!readSid() && readView() === 'chat') history.replaceState(null, '', `/c/${sessionId}${location.search}`) }, [])   // keep ?project=
  // Restore THIS chat's feed on mount (reload survives) and jump straight to the bottom.
  useEffect(() => { const f = loadFeed(sessionId); if (f.length) { setFeed(f); scroll(true) } }, [])   // eslint-disable-line
  // Persist the feed + keep the chat in the sidebar list (title = first question) whenever it changes.
  useEffect(() => {
    if (!feed.length) return
    safeSetItem(fkey(sessionId), JSON.stringify(feed.slice(-100)), sessionId)
    const title = feed.find(i => i.type === 'user-msg')?.text?.slice(0, 60) || 'New chat'
    setSessions(prev => {
      // Order is CREATION order and nothing else. (This used to unshift the session to the front on every feed
      // change — and selecting a chat loads its feed, so merely clicking a chat reshuffled the list.) createdAt is
      // stamped once and never rewritten; the title can change, the position cannot.
      const existing = prev.find(s => s.id === sessionId)
      const createdAt = existing?.createdAt ?? Date.now()
      const next = [{ id: sessionId, title, createdAt }, ...prev.filter(s => s.id !== sessionId)]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))   // newest chat on top, stable
        .slice(0, 50)
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

  // The analyst's claude-code terminal goes through the shared module — parameterized by `which` +
  // `interactive`. Model-agnostic; codex/opencode would use their own view.
  useClaudeTerminal(anTermRef, anXtermRef, { which: 'analyst', interactive: true, send, autoAttach: false })   // default = structured; PTY attaches only on the Terminal toggle

  // The analyst + semantic logs each own their interactions SEPARATELY (open→bottom, follow-if-near-bottom,
  // Shift+Arrow between questions) — see logNav.ts. contentKey = a number that grows as the log grows.
  useLogNav(anLogRef,  view === 'analyst',  anEvents,  askTick)   // pass the ARRAY (new ref on every merge, incl. in-place streaming) — not .length; askTick = force-jump on a new question
  useLogNav(coLogRef,  view === 'composer', coEvents,  askTick)
  useLogNav(moLogRef,  view === 'modeler',  moEvents,  askTick)

  usePersistLog('sa-anlog-', sessionId, anEvents, setAnEvents)   // analyst + composer logs both survive a reload
  usePersistLog('sa-colog-', sessionId, coEvents, setCoEvents)
  usePersistLog('sa-molog-', sessionId, moEvents, setMoEvents)

  // Per-step timer (UI-only, nice-to-have): tick every second while busy so the CURRENT analysis beat counts up.
  useEffect(() => {
    if (!anBusy) return
    setNowMs(Date.now())
    const iv = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [anBusy])

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
        else { send({ t: 'analyst:sync' }); send({ t: 'sessions:list', projectId }); send({ t: 'session:load', sessionId: sidRef.current }); send({ t: 'suggestions:req', projectId }); send({ t: 'term:attach', which: 'analyst' }); attachLogs() }
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
          send({ t: 'analyst:sync' }); send({ t: 'sessions:list', projectId }); send({ t: 'session:load', sessionId: sidRef.current }); send({ t: 'suggestions:req', projectId }); send({ t: 'term:attach', which: 'analyst' })
          attachLogs()   // this console WATCHES the agents → subscribe to all agent-log channels for the whole session, so you never miss a question's log by attaching late
          send({ t: 'sync:req' })   // pull recent sessions + any answers we missed while offline, straight from the always-on DO (no engine wake)
          return
        }
        // Machine is being woken from suspend — that takes ~60s (wake + boot), so give the watchdog a long
        // window here so it doesn't false-fire before the engine even comes up.
        if (msg.t === 'machine:waking') { setStatus('Starting the engine…'); setAnStatus('Starting the engine…'); if (busyRef.current) armWatchdog(120000); return }
        if (msg.t === 'sessions:res') { if (msg.sessions?.length) setSessions(msg.sessions); return }   // engine stores none; keep our localStorage list
        // Durable recovery from the always-on DO: sessions we may not have locally + answers that landed while
        // we were offline (internet blip / machine asleep / app closed / another device). Merge (dedup by qid),
        // then ack so the DO stops re-pushing them.
        if (msg.t === 'sync:res') {
          if (msg.sessions?.length) mergeServerSessions(msg.sessions)
          for (const a of [...(msg.answers || [])].reverse()) mergeRecovered(a.qid, a.sessionId, a.question, a.answer, a.followups)   // reverse: DO sends newest-first, append oldest-first → top-down chronological
          const qids = (msg.answers || []).map((a: any) => a.qid).filter(Boolean)
          if (qids.length) send({ t: 'answer:ack', qids })
          return
        }
        if (msg.t === 'answer:res') {   // targeted pull for one qid
          if (msg.status === 'ready') { mergeRecovered(msg.qid, sidRef.current, msg.question, msg.answer, msg.followups); send({ t: 'answer:ack', qids: [msg.qid] }) }
          return
        }
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

        if (typeof msg.t === 'string' && msg.t.startsWith('agent:')) {
          // ── GENERIC AGENT-LANE PROTOCOL ─────────────────────────────────────────────────────────────────
          // ONE consumer for EVERY lane (composer / analyst / concept-modeller / any future agent). `lane` is
          // the routing key. The engine owns the vocabulary (agent:hello|event|events|status); the UI hardcodes
          // no agent name here — a new lane needs zero new handlers. (The raw-terminal byte stream keeps its own
          // `analyst:chunk` type below; the answer/narration are a different, user-facing protocol.)
          const verb = msg.t.slice(6)
          // LANE SCOPE. The composer is SESSION-scoped — the engine runs one per chat (composersBySession) — while
          // the analyst and modeller are PROJECT-scoped singletons. So a composer frame belongs to exactly one chat:
          // drop it unless it's this chat's, otherwise a second chat's composer streams into the view you're on.
          if (msg.lane === 'composer' && msg.sid && msg.sid !== sidRef.current) return
          const setEvents = msg.lane === 'composer' ? setCoEvents : msg.lane === 'modeler' ? setMoEvents : setAnEvents
          if (verb === 'event') {
            setEvents(evs => mergeEvent(evs, { ...msg.ev, agent: msg.lane }))   // merge by id → a streaming block updates in place
          } else if (verb === 'events') {
            // Replay repopulates an EMPTY log after a reload — it must never overwrite a log we already have.
            // The replay carries the harness transcript, which has no question boundaries, so replacing a live
            // log would delete the UI-synthesized [data-qlog] dividers (and with them the Shift+Arrow anchors).
            // The composer never gets a replay, which is why only the analyst lost its dividers.
            setEvents(evs => evs.length ? evs : (msg.events ?? []))
          } else if (verb === 'hello') {
            // A lane announces its render capabilities. Only the analyst has a raw PTY terminal today → wire the
            // Terminal toggle. (label/hue/interactive/controls ride along for a later fully-declarative sidebar.)
            if (msg.lane === 'analyst') { const k = msg.streamKind === 'pty' ? 'pty' : 'events'; anStreamKindRef.current = k; setAnStreamKind(k); setAnHasPty(!!msg.pty) }
          } else if (verb === 'status') {
            if (msg.lane === 'modeler') {
              // The modeller is project-level (no shared question header) — surface its status IN its own log.
              if (msg.text) setMoEvents(evs => mergeEvent(evs, { id: 'ms-' + Date.now(), kind: 'message', text: msg.text, agent: 'modeler', done: true }))
            } else if (msg.state === 'done') {
              setAnBusy(false); setAnStatus('Done ✓'); setAnProgress(''); setNarrationLog([]); narrationLogRef.current = []; narrationTimesRef.current = []; narrationMetaRef.current = []; setExpandedGroups(new Set()); setBusy(false); busyRef.current = false; clearWatchdog()
            } else {
              // Live turn state — the spinner is driven by the tick heartbeat (armWatchdog), never a flag we must
              // remember to clear, so a replayed/stale "answering" self-clears if no ticks follow.
              if (msg.question) setAnQuestion(msg.question)
              if (msg.category) setAnCategory(msg.category)
              if (msg.progress !== undefined) setAnProgress(msg.progress)   // clean prose narration → live progress line
              if (msg.text) { setAnBusy(true); setBusy(true); busyRef.current = true; setAnStatus(msg.text); armWatchdog() }
              else if (msg.category) setAnStatus(`Answering — ${msg.category}…`)
            }
          }
        } else if (msg.t === 'analyst:chunk') {
          // The agent's raw LIVE terminal (own byte stream, shared with the admin console — NOT a lane frame).
          // `replace` = a full repaint: the buffer replay the engine sends on term:attach, or a fresh session.
          if (msg.replace) anXtermRef.current?.clear()
          anXtermRef.current?.write(msg.text ?? '')
          rawStreamRef.current = msg.replace ? (msg.text ?? '') : (rawStreamRef.current + (msg.text ?? '')).slice(-400000)
        } else if (msg.t === 'followups') {
          // Suggested next questions — reveal as a card AFTER a delay, so the user reads the answer first.
          const items = Array.isArray(msg.items) ? msg.items.filter((x: any) => typeof x === 'string' && x.trim()).slice(0, 3) : []
          const fuSid = msg.sid, fuQid = msg.qid
          if (items.length && (!fuSid || fuSid === sidRef.current)) {
            setTimeout(() => {
              if (fuSid && fuSid !== sidRef.current) return   // user switched chats during the delay — skip
              setFeed(f => f.some(it => it.type === 'followups' && it.qid === fuQid) ? f : [...f, { id: crypto.randomUUID(), type: 'followups', items, qid: fuQid }])
            }, 3500)
          }
        } else if (msg.t === 'narration') {
          // Sent twice on purpose — once to this socket, once to the owner channel — so one of them survives a
          // reconnect. Keep the first arrival and ignore the echo.
          if (msg.text && !narrationLogRef.current.includes(msg.text)) { narrationLogRef.current = [...narrationLogRef.current, msg.text]; narrationTimesRef.current = [...narrationTimesRef.current, Date.now()]; narrationMetaRef.current = [...narrationMetaRef.current, { kind: 'narrator' }]; setNarrationLog(narrationLogRef.current); setNowMs(Date.now())   // append a beat + stamp its arrival (chat-view analysis card)
            setAnEvents(evs => [...evs, { id: 'narr-' + narrationTimesRef.current.length, kind: 'narration', text: msg.text, agent: 'narrator', done: true }]) }   // ALSO drop it into the analyst-tab stream so it interleaves by time with the agent's events
        } else if (msg.t === 'verb:event') {
          // A verb turn (explain:, check:) streams its own events straight to us — never gated on attaching to
          // an agent lane, because the user asked for this turn by name.
          //
          // WHAT WE RENDER is a CLIENT choice. By default only `message`, the agent's prose, which for an
          // explain IS the explanation; the tool calls and file reads arrive too and are dropped. A developer
          // can see all of it by setting the flag below — nothing is being hidden, it is just noise for the
          // person who asked a business question.
          const ev: any = (msg as any).ev
          const text = verbEventLine(ev)
          if (text && !narrationLogRef.current.includes(text)) {
            narrationLogRef.current = [...narrationLogRef.current, text]
            narrationTimesRef.current = [...narrationTimesRef.current, Date.now()]
            narrationMetaRef.current = [...narrationMetaRef.current, { kind: 'narrator' }]
            setNarrationLog(narrationLogRef.current); setNowMs(Date.now())
          }
        } else if (msg.t === 'program:event') {
          // THE PROGRAM ITSELF, not the story about it. These arrive whether the engine started the program or
          // the agent did from its own shell, so a long query no longer reads as the agent having stalled.
          const ev: any = (msg as any).ev
          const text = String(ev?.text ?? '').trim()
          if (text) {
            narrationLogRef.current = [...narrationLogRef.current, text]
            narrationTimesRef.current = [...narrationTimesRef.current, Date.now()]
            // A query's SQL is kept whole behind the line and shown on click — enough to recognise it at a
            // glance, all of it when that is not enough.
            narrationMetaRef.current = [...narrationMetaRef.current, { kind: 'program', detail: typeof ev?.sql === 'string' ? ev.sql : undefined }]
            setNarrationLog(narrationLogRef.current); setNowMs(Date.now())
          }
        } else if (msg.t === 'analyst:answer') {
          // NEVER surface the agent's raw terminal (lastLines) as an answer — that leaks internal logs.
          // The agent is expected to always produce an answer (incl. a plain-text reply for conversational
          // input); this neutral fallback only guards a true failure and is NOT a restriction on what it answers.
          const ans = msg.answer ?? { status: 'no_answer', answer: 'Something went wrong on that one — please try again.' }
          setAnAnswer(ans)                                                     // Analyst tab (always reflects the latest)
          // A REPLAY (reconnect) is already in the saved feed — don't duplicate it. A fresh answer gets
          // appended to its OWN chat: the visible feed if it's current, else that chat's saved feed.
          if (!msg.replay) {
            // The story becomes its OWN card, placed BETWEEN the question and the answer (collapsed accordion) —
            // rendered EXACTLY like the live analysis: separated rows + frozen per-beat seconds.
            const beats = narrationLogRef.current
            const times = narrationTimesRef.current, nowT = Date.now()
            const secs = beats.map((_, i) => { const end = i < beats.length - 1 ? (times[i + 1] ?? nowT) : nowT; return Math.max(1, Math.floor(Math.max(0, end - (times[i] ?? nowT)) / 1000) + 1) })
            const analysisCard: FeedItem | null = beats.length ? { id: crypto.randomUUID(), type: 'analysis', beats: [...beats], secs, qid: msg.qid } : null
            const card: FeedItem = { id: crypto.randomUUID(), type: 'answer', category: msg.category, answer: ans, timing: msg.timing, qid: msg.qid, at: Date.now() }
            const toAppend = analysisCard ? [analysisCard, card] : [card]
            // Keep the last question pinned at the top (question → analysis → answer read top-down).
            if (!msg.sid || msg.sid === sidRef.current) { setFeed(f => [...f, ...toAppend]); scroll() }
            else { const f = loadFeed(msg.sid); safeSetItem(fkey(msg.sid), JSON.stringify([...f, ...toAppend].slice(-100)), msg.sid) }
          }
          // Keep narrationLog as-is — the analyst-view mirror keeps showing it until the NEXT question starts (cleared in ask()).
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
  // Ask the engine to abandon the turn. The engine confirms with turn:stopped and emits the closing answer, so
  // nothing is assumed here — the card clears when the engine says it has actually stopped, not when clicked.
  function stopTurn() {
    send({ t: 'turn:stop', sessionId: sessionId || sidRef.current, reason: 'the user stopped it' })
  }

  function send(payload: any) {
    const ws = wsRef.current
    // A CLOSED SOCKET MUST NOT EAT THE MESSAGE SILENTLY. This returned quietly, so a question typed while the
    // socket was between reconnects was destroyed in the browser — never sent, never logged — while the UI
    // still flipped to "thinking" and the watchdog then blamed the engine 25s later. The engine was idle and
    // healthy the whole time. Say so instead.
    if (ws?.readyState !== 1) {
      console.warn('[ws] not open — dropping', payload?.t, '(readyState', ws?.readyState, ')')
      if (payload?.t === 'analyse') endTurn('Not connected — your question was not sent. Reconnecting…')
      return
    }
    ws.send(JSON.stringify(CLOUD ? { to: { type: 'code-engine' }, payload } : payload))
  }
  // Subscribe to every agent-log channel (called on connect). The DO forwards each only to THIS user's devices,
  // so the console always has the composer/analyst/semantic logs from the moment it connects — no missing a
  // question's log by attaching late. Stays for the connection's life (the DO drops it on WS close).
  // 'narration' is here for the same reason as the log channels: a channel is fanned to the QUESTION'S OWNER,
  // so it keeps arriving across a reconnect, whereas anything addressed to our old wsId is lost the moment we
  // reconnect. Beats used to travel only that second way, which is why a healthy turn could show an empty
  // analysis card for ten minutes.
  // 'program' carries the step-by-step detail of a running program. Attached by default because a long query
// looking like a hang is the problem this solves; a client that would rather not see it simply never attaches,
// and still gets the program started/finished/failed lines, which are sent to everyone.
const attachLogs = () => ['analyst-log', 'composer-log', 'concept-log', 'narration', 'program'].forEach((channel) => send({ t: 'log:attach', channel }))

  // Recover a full Q&A PAIR from the DO into the right session's feed. A qid is a pair, so we restore the
  // QUESTION card too — its id is the qid (matching how ask() writes it), so it dedups whether or not the
  // question is already there. `answerPayload` is the buffered analyst:answer message (.answer/.category/
  // .timing); `followupsPayload` is the buffered followups message (.items).
  function mergeRecovered(qid: string, sessionId: string, question: string, answerPayload: any, followupsPayload: any) {
    if (!qid) return
    const sid = sessionId || sidRef.current
    const qCard: FeedItem = { id: qid, type: 'user-msg', text: question || '' }
    const aCard: FeedItem = { id: crypto.randomUUID(), type: 'answer', category: answerPayload?.category, answer: answerPayload?.answer ?? answerPayload, timing: answerPayload?.timing, qid, at: Date.now() }
    const fuItems = followupsPayload?.items
    const fuCard: FeedItem | null = Array.isArray(fuItems) && fuItems.length ? { id: crypto.randomUUID(), type: 'followups', items: fuItems, qid } : null
    const add = (arr: FeedItem[]) => {
      if (arr.some(it => it.type === 'answer' && (it as any).qid === qid)) return arr   // pair already complete
      const hasQ = arr.some(it => it.id === qid)                                        // question already in the feed (same-device)?
      return [...arr, ...(!hasQ && question ? [qCard] : []), aCard, ...(fuCard ? [fuCard] : [])]
    }
    if (sid === sidRef.current) setFeed(f => add(f))
    else { const f = loadFeed(sid); safeSetItem(fkey(sid), JSON.stringify(add(f).slice(-100)), sid) }
  }

  // Merge the DO's recent-session snapshot into the local sidebar list (dedup by id, newest first, bounded 50).
  function mergeServerSessions(serverSessions: any[]) {
    setSessions(prev => {
      const byId = new Map(prev.map((s: any) => [s.id, s]))
      for (const s of serverSessions) {
        const id = s.sessionId || s.id; if (!id) continue
        const ex = byId.get(id)
        byId.set(id, { id, title: s.title || ex?.title || 'Untitled', updatedAt: Math.max(s.lastAt || 0, ex?.updatedAt || 0) })
      }
      const next = [...byId.values()].sort((a: any, b: any) => b.updatedAt - a.updatedAt).slice(0, 50)
      localStorage.setItem(SKEY, JSON.stringify(next))
      return next
    })
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

  // "Scroll to newest" = pin the LAST QUESTION to the top of the viewport (NOT the document bottom — that only
  // shows the tail of an answer). One behaviour for asking, answering, AND loading a chat: land on the last
  // question and read its analysis + answer downward from there. The tall spacer (while busy) gives the room for
  // the last question to actually reach the top. Best-effort — no question yet just no-ops.
  function scroll(instant = false) {
    const pin = () => {
      const qs = document.querySelectorAll('[data-role="q"]')
      const el = qs.length ? qs[qs.length - 1] as HTMLElement : null
      if (!el) return
      const y = el.getBoundingClientRect().top + window.scrollY - 12   // 12px breathing room above the question
      window.scrollTo({ top: y, behavior: instant ? 'auto' : 'smooth' })
    }
    if (!instant) { setTimeout(pin, 50); return }
    // instant (load): cards / web-components render ASYNC and grow the page after the first pin, so re-pin to
    // the question until the height settles (or a hard cap).
    let last = -1, stable = 0
    pin()
    const iv = setInterval(() => {
      const h = document.body.scrollHeight
      pin()
      if (h === last) { if (++stable >= 3) clearInterval(iv) } else { stable = 0; last = h }
    }, 60)
    setTimeout(() => clearInterval(iv), 3000)
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
    setAnBusy(false); setAnStatus(''); setAnProgress(''); setNarrationLog([]); narrationLogRef.current = []; narrationTimesRef.current = []; narrationMetaRef.current = []; setExpandedGroups(new Set())
    if (note) { setFeed(f => [...f, { id: crypto.randomUUID(), type: 'error', text: note }]); scroll() }
  }
  // Liveness: the engine ticks every ~8s while a turn runs; every incoming message re-arms this. If nothing
  // arrives for `ms`, the engine is gone (crashed / suspended / never came up) → end the turn. A machine
  // wake+boot legitimately takes ~60s, so `machine:waking` arms a longer window instead of false-firing.
  function armWatchdog(ms = 25000) {
    clearWatchdog()
    // Say what we ACTUALLY know. This fires when THIS BROWSER has heard nothing for `ms` — which is just as
    // often our own socket dropping as the engine stopping, and the engine frequently keeps working and lands
    // the answer afterwards. Blaming the engine sent us hunting a healthy process for hours.
    watchdog.current = setTimeout(() => endTurn(
      navigator.onLine === false
        ? 'You appear to be offline — reconnecting. Any answer already running will arrive when the connection is back.'
        : 'No updates received for a while. The engine may still be working — this page will show the answer if it arrives.'
    ), ms)
  }

  // A follow-up chip FILLS the input (editable) and focuses it — it does NOT submit, so the user can tweak it
  // and press Enter themselves.
  const fillInput = useCallback((text: string) => {
    const el = inputRef.current
    if (!el) return
    el.value = text; el.focus()
    try { el.setSelectionRange(text.length, text.length) } catch { /* not selectable */ }
  }, [])

  // Seconds shown next to a beat: the last (current) beat ticks via nowMs; past beats freeze at the gap until the
  // next beat arrived. Shows from 1 (never 0).
  const beatSecs = (i: number, total: number) => {
    const t = narrationTimesRef.current
    if (!t[i]) return 1
    const end = i < total - 1 ? (t[i + 1] ?? nowMs) : nowMs
    return Math.max(1, Math.floor(Math.max(0, end - t[i]) / 1000) + 1)
  }

  // Stable, so memo on a row actually holds — a fresh closure on every render would defeat it.
  const toggleBeatGroup = useCallback((head: number) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(head)) next.delete(head); else next.add(head)
      return next
    })
  }, [])

  // The rows to draw, flat and stably keyed. Consecutive PROGRAM beats become one row showing the latest,
  // unless the reader has opened that run. Recomputed when the beats, the clock or an expansion change — the
  // rows themselves are memoised, so a tick only re-renders the one row whose seconds actually moved.
  const beatRows = (() => {
    const groups: Array<{ prog: boolean; idxs: number[] }> = []
    narrationLog.forEach((_, i) => {
      const prog = narrationMetaRef.current[i]?.kind === 'program'
      const last = groups[groups.length - 1]
      if (last && last.prog && prog) last.idxs.push(i)
      else groups.push({ prog, idxs: [i] })
    })
    const rows: Array<{ key: string; text: string; secs: number; prog: boolean; past: boolean
                        detail?: string; chevron: 'none' | 'open' | 'closed'; count: number; head: number }> = []
    for (const g of groups) {
      const head = g.idxs[0]
      const open = expandedGroups.has(head)
      const many = g.prog && g.idxs.length > 1
      const shown = g.prog && !open ? [g.idxs[g.idxs.length - 1]] : g.idxs
      shown.forEach((i, n) => rows.push({
        key: `${head}:${i}`,
        text: narrationLog[i],
        secs: beatSecs(i, narrationLog.length),
        prog: g.prog,
        past: i !== narrationLog.length - 1,
        detail: open ? narrationMetaRef.current[i]?.detail : undefined,
        chevron: many && n === 0 ? (open ? 'open' : 'closed') : 'none',
        count: g.idxs.length,
        head,
      }))
    }
    return rows
  })()

  // Holds the CURRENT submit, so the listener below can be registered once and still call the live one.
  const submitRef = useRef<((preset?: string) => void) | null>(null)

  // CLICKING A THING IN A TABLE asks to look at it. One delegated listener rather than a handler threaded
  // through DataTable and every cell: the cells already carry what is needed on the element itself, and a
  // table of a thousand rows should not mean a thousand closures.
  //
  // It submits rather than filling the box, because this is not a question being composed — it is a key, and
  // the answer to it either exists already or is one build away.
  useEffect(() => {
    const onClick = (ev: MouseEvent) => {
      const el = (ev.target as HTMLElement | null)?.closest?.('.sa-ent') as HTMLElement | null
      if (!el) return
      const entity = el.dataset.entity, id = el.dataset.id
      if (!entity || !id) return                       // a cell with an id but no kind names nothing to open
      if (!window.getSelection()?.isCollapsed) return  // a click that ends a selection is someone copying
      ev.preventDefault()
      submitRef.current?.(`view: ${entity} ${id}`)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [])

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
    scroll()   // pin the new (now last) question to the top of the viewport
    setAnQuestion(text); setAnAnswer(null); setAnCategory(''); setAnStatus('Classifying…'); setAnBusy(true); setAnProgress(''); setNarrationLog([]); narrationLogRef.current = []; narrationTimesRef.current = []; narrationMetaRef.current = []; setExpandedGroups(new Set())
    anXtermRef.current?.clear()   // claude PTY: fresh TUI per question (harmless when the analyst is codex)
    // QUESTION-boundary divider (+ Shift+Arrow anchor) — shown optimistically in BOTH agent-log views. Keyed by
    // qid so the engine's authoritative boundary event (same id) MERGES with it rather than adding a second one.
    const qMarker: AgentEvent = { kind: 'user', id: qid, text, done: true }
    setAnEvents(l => [...l, qMarker]); setCoEvents(l => [...l, qMarker])
    setAskTick(t => t + 1)   // force each log view to jump to this newest question, even if it was scrolled up (see useLogNav jumpKey)
    setStatus('')
    setBusy(true); busyRef.current = true; armWatchdog()
    if (inputRef.current) { inputRef.current.value = ''; inputRef.current.style.height = 'auto' }
    setLiveSuggest(null); multilineRef.current = false; setMultiline(false)
    // userId is NOT sent — the hub stamps the authenticated userId onto `from` server-side (trusted).
    send({ t: 'analyse', question: text, projectId, role, sessionId: sidRef.current, questionId: qid })
    scroll()
  }, [busy, role])
  submitRef.current = submit   // keep the delegated entity-click listener pointed at the live submit

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

  // Standard ICA session controls for the analyst: a completely fresh session, or compact (shrink context).
  const sessionCtl = useCallback((action: 'new' | 'compact') => {
    if (wsRef.current?.readyState !== 1) return
    // The analyst's running session log resets ONLY here: a New session wipes it (a brand-new thread);
    // a compaction is marked with a divider (the thread continues with summarized context below it).
    setAnEvents(l => action === 'new' ? [] : [...l, { kind: 'turn' }])   // new: wipe; compact: a divider rule
    send({ t: action === 'new' ? 'session:new' : 'session:compact', role: 'analyst', projectId })
    setAnStatus(action === 'new' ? 'New session' : 'Compacting…')
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

  // ONE general agent view — composer, analyst, and concept-modeller are the SAME surface (header + a
  // scrollable question-segmented event log with identical accordion + Shift-Arrow nav). Only the per-view
  // extras differ (analyst adds a terminal toggle + input bar; the modeller is read-only). Everything shared
  // lives here so the three never drift; the differences ride in as `headerExtras` / `panels` / `footer` / `termRef`.
  const agentLane = (cfg: {
    key: Exclude<View, 'chat'>
    label: string
    desc: string
    events: AgentEvent[]
    logRef: React.RefObject<HTMLDivElement | null>
    question?: string            // header context line; defaults to the live question (modeller passes '')
    busy?: boolean
    claude?: boolean
    headerExtras?: React.ReactNode
    panels?: React.ReactNode
    termRef?: React.RefObject<HTMLDivElement | null>
    showTerm?: boolean
    footer?: React.ReactNode
  }) => (
    <div style={{ display: view === cfg.key ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={s.semHeader}>
        <button onClick={() => navigate('chat')} style={s.backBtn} title="Back to your chat">← Chat</button>
        <span style={{ color: '#bcd0be', fontSize: 13, fontWeight: 600 }}>◇ {cfg.label}</span>
        <span style={{ color: '#8a8276', fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {(cfg.question ?? anQuestion) || cfg.desc}
        </span>
        {cfg.busy && <Spinner />}
        {cfg.headerExtras}
      </div>
      {cfg.panels}
      <div ref={cfg.logRef} style={{ flex: 1, overflow: 'auto', background: 'transparent', padding: 12, paddingBottom: 110 }}>
        {cfg.termRef && <div ref={cfg.termRef} onMouseDown={() => anXtermRef.current?.focus()} style={{ display: cfg.showTerm ? 'block' : 'none' }} />}
        {!cfg.showTerm && <CodexEventLog events={cfg.events} busy={cfg.busy} claude={cfg.claude} />}
      </div>
      {cfg.footer}
    </div>
  )

  return (
    <div style={s.shell}>
      {/* Sidebar — sectioned menu (Model / Agent), like a product nav */}
      <aside style={s.sidebar}>
        <div style={{ padding: '10px 12px 6px', fontSize: 15, fontWeight: 700, color: '#cfe3d0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
             title={proj?.id || projectId}>
          {proj?.name || 'Superatom'}
        </div>
        <div style={s.navSection}>AGENT</div>
        <div onClick={() => navigate('composer')}
          style={{ ...s.sessionItem, ...(view === 'composer' ? s.sessionItemActive : {}) }}>
          ◇ Composer
        </div>
        <div onClick={() => navigate('analyst')}
          style={{ ...s.sessionItem, ...(view === 'analyst' ? s.sessionItemActive : {}) }}>
          ◇ Analyst
        </div>
        <div onClick={() => navigate('modeler')}
          style={{ ...s.sessionItem, ...(view === 'modeler' ? s.sessionItemActive : {}) }}>
          ◇ Concept Modeller
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

      {/* Composer — reuse-or-compose (escalates to the analyst). Per-session; always mounted so its log persists. */}
      {agentLane({
        key: 'composer', label: 'Composer', events: coEvents, logRef: coLogRef, busy,
        desc: 'The composer reuses a program or composes concepts — escalating to the analyst when needed.',
        // SESSION-scoped lane: there's one composer per chat, so name the chat this log belongs to — without it
        // the view silently changes meaning when you switch chats.
        headerExtras: <span style={s.catChip} title="This composer belongs to this chat">{sessions.find(se => se.id === sessionId)?.title || 'New chat'}</span>,
      })}

      {/* Analyst — the from-scratch agent. Adds the category chip, live status, a raw-terminal toggle, session
          controls, the buildable-gaps panel, the enriching banner, its PTY mount, and its own input bar. */}
      {agentLane({
        key: 'analyst', label: 'Analyst', events: anEvents, logRef: anLogRef, busy: anBusy, claude: anHasPty,
        desc: 'Ask a question below — it classifies, then answers from the semantic model.',
        termRef: anTermRef, showTerm: anTerminal || anStreamKind === 'pty',
        headerExtras: (
          <>
            {anCategory && <span style={s.catChip}>{anCategory.replace('_', ' ')}</span>}
            <span style={{ color: '#8a8276', fontSize: 12 }}>{anStatus}</span>
            {anHasPty && (
              <button
                onClick={() => {
                  const next = !anTerminal; setAnTerminal(next)
                  if (next) { send({ t: 'ui:resize', which: 'analyst', cols: COLS, rows: ROWS }); send({ t: 'term:attach', which: 'analyst' }) }
                  else send({ t: 'term:detach', which: 'analyst' })
                }}
                style={s.backBtn}
                title={anTerminal ? 'Back to the structured view' : 'Open the raw claude-code terminal'}>
                {anTerminal ? '≣ Structured' : '⌨ Terminal'}
              </button>
            )}
            <button onClick={() => sessionCtl('compact')} style={s.backBtn} title="Compact the session's context">⇊ Compact</button>
            <button onClick={() => sessionCtl('new')} style={s.backBtn} title="Start a completely fresh session">↻ New session</button>
          </>
        ),
      })}

      {/* Concept Modeller (System 4) — the OFFLINE consolidation agent that distils finished analyses into
          concepts. Read-only, project-level (no per-question input); same log surface as the other two. */}
      {agentLane({
        key: 'modeler', label: 'Concept Modeller', events: moEvents, logRef: moLogRef, claude: false, question: '',
        desc: 'Offline consolidation — distils finished analyses into reusable concepts.',
      })}

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
            {(() => {
              // Follow-up chips are only useful for the RECENT turns — keep the last two, hide older ones so
              // scrolling back through old Q&As isn't cluttered. UI-only; the backend still sends them all.
              const keepFu = new Set(feed.filter(i => i.type === 'followups').slice(-2).map(i => i.id))
              return feed.map(item => (item.type === 'followups' && !keepFu.has(item.id)) ? null : <FeedCard key={item.id} item={item} onPick={fillInput} />)
            })()}
            {/* Working indicator — no terminal; a details link goes to the Analyst tab. */}
            {anBusy && (
              <div className="sa-live">
                <div className="sa-live-h">
                  {/* What is actually running, not a fixed word. The engine says so as soon as it knows — for a
                      verb turn that is immediately, for a question it is the agent's own judgement, arriving a
                      little later. Until then "Working" is honest, where "Analysis" was a guess that was often
                      simply wrong. */}
                  <Spinner /><span>{anCategory ? anCategory.replace(/_/g, ' ') : 'Working'}</span>
                  <span className="lnk" onClick={() => navigate('analyst')}>details ↗</span>
                </div>
                {narrationLog.length > 0 && (
                  <div className="sa-beats">
                    {/* A RUN OF PROGRAM BEATS COLLAPSES TO ONE. A program emits a line per unit, per
                        decision and per query, so a real one buries the narrator's few sentences under thirty
                        of its own. Consecutive program lines show only their LATEST — each replacing the last,
                        which is what a progress line is for — with a chevron to open the rest.

                        The chevron expands, not the text: clicking the line would mean never being able to
                        select any of it. It shows on hover only, so a card at rest is quiet.

                        Built as a FLAT list of rows with stable keys, and each row memoised. Nested arrays
                        without keys made React remount the subtree on every tick, which is what destroyed a
                        selection the instant you made one. */}
                    {beatRows.map(r => (
                      <Beat key={r.key} text={r.text} secs={r.secs} prog={r.prog} past={r.past}
                            detail={r.detail} chevron={r.chevron} count={r.count} head={r.head}
                            onToggle={toggleBeatGroup} />
                    ))}
                  </div>
                )}
                {narrationLog.length === 0 && <div style={{ marginTop: 8, fontSize: 13.5, color: '#8a8276' }}>{anProgress || anStatus || 'Working…'}</div>}
              </div>
            )}
            {/* STOP — BELOW the card, not inside it. The card is the work; this is an action taken against the
                work, and putting it in there made it read like one more line of progress. Nothing is saved for
                a stopped question. */}
            {anBusy && (
              <div className="sa-stop-row">
                <button className="sa-stop" onClick={stopTurn} title="Stop this question">
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><rect width="10" height="10" rx="1.5" fill="currentColor" /></svg>
                  Stop
                </button>
              </div>
            )}
            {/* Reserve a screenful of scroll room after the last content so the LAST QUESTION can always reach the
                top of the viewport — on ask, on answer, and on loading a chat. */}
            <div aria-hidden style={{ minHeight: '58vh' }} />
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

function FeedCard({ item, onPick }: { item: FeedItem; onPick?: (t: string) => void }) {
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
    return <div data-qid={item.id} data-role="q" style={s.userMsg}>{item.text}</div>
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
  if (item.type === 'followups') {
    return (
      <div className="sa-fu">
        <div className="sa-fu-label">You could also ask</div>
        <div className="sa-fu-list">
          {item.items.map((q, i) => (
            <button key={i} className="sa-fu-chip" onClick={() => onPick?.(q)} title="Click to put this in the box — edit it, then press Enter">{q}</button>
          ))}
        </div>
      </div>
    )
  }
  if (item.type === 'analysis') {
    return (
      <details className="sa-analysis-card">
        <summary>Analysis · {item.beats.length} step{item.beats.length > 1 ? 's' : ''}</summary>
        <div className="sa-ac-body">
          {item.beats.map((b, i) => (
            <div key={i} className="sa-beat">
              <div className="sa-beat-b sa-md" dangerouslySetInnerHTML={{ __html: renderInlineMd(b) }} />
              {item.secs?.[i] != null && <div className="sa-beat-t">{item.secs[i]}s</div>}
            </div>
          ))}
        </div>
      </details>
    )
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
.sa-answer .sa-prose pre.sa-code{font-family:var(--mono);font-size:12.5px;color:var(--ink);background:var(--panel);border:1px solid var(--hair);padding:9px 11px;margin:9px 0;overflow-x:auto;line-height:1.5;white-space:pre}
.sa-answer .sa-prose pre.sa-code code{background:none;border:0;padding:0;font-size:inherit}
.sa-answer .sa-prose .sa-h{font-family:var(--grot);font-weight:700;color:var(--ink);font-size:14.5px;margin:14px 0 5px;letter-spacing:-.01em}
.sa-answer .sa-prose .sa-h.sm{font-size:13.5px;margin:11px 0 4px}
.sa-answer .sa-prose .sa-h:first-child{margin-top:0}
.sa-answer .sa-files{margin-top:10px}
.sa-answer .sa-files-tabs{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0 0}
.sa-answer .sa-file-tab{font-family:var(--mono);font-size:11.5px;color:var(--body);background:var(--panel);border:1px solid var(--hair);padding:3px 8px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sa-answer .sa-file-tab:hover{color:var(--ink)}
.sa-answer .sa-file-tab.on{color:var(--ink);background:var(--bg);border-color:var(--ink);font-weight:600}
.sa-answer .sa-file-src{font-family:var(--mono);font-size:12px;line-height:1.55;color:var(--ink);background:var(--panel);border:1px solid var(--hair);border-top:0;margin:0;padding:10px 12px;max-height:520px;overflow:auto;white-space:pre;tab-size:2}
.sa-answer .sa-file-note{font-size:11.5px;color:var(--body);margin-top:5px}
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
.sa-md{font-size:13px;line-height:1.55;color:#3a3a3a}
.sa-md strong{font-weight:700;color:#1a1a1a}
.sa-md ul.sa-list,.sa-md ol.sa-olist{margin:4px 0;padding-left:18px}
.sa-md ul.sa-list{list-style:disc}
.sa-md ol.sa-olist{list-style:decimal}
.sa-md li{margin:2px 0}
.sa-md code{font-family:monospace;font-size:12px;background:#f0ede8;padding:1px 4px;border-radius:3px}
.sa-mdtable{border-collapse:collapse;margin:6px 0;font-size:12.5px;font-variant-numeric:tabular-nums}
.sa-mdtable th,.sa-mdtable td{border:1px solid #e0dcd4;padding:3px 9px;text-align:left;white-space:nowrap}
.sa-mdtable th{background:#f3f1ec;font-weight:600}
/* ── Receptionist UI (feed = light): live analysis, analysis card, follow-ups, narrator mirror, per-step timer ── */
.sa-live{border:1px solid #e8e4de;border-radius:8px;background:#fbfaf8;padding:12px 14px;margin:4px 0}
.sa-live-h{display:flex;align-items:center;gap:10px;color:#6b6459;font-size:12.5px;font-weight:600}
.sa-stop-row{display:flex;justify-content:flex-end;margin-top:8px}
.sa-stop{display:inline-flex;align-items:center;gap:6px;font-family:var(--grot);font-size:12px;color:#6b6459;background:transparent;border:1px solid var(--hair);border-radius:999px;padding:4px 11px;cursor:pointer}
.sa-stop:hover{color:#a33;border-color:#a33}
.sa-live-h .lnk{margin-left:auto;font-weight:400;font-size:12px;color:#8a8276;cursor:pointer;text-decoration:underline}
.sa-beats{margin-top:8px;display:flex;flex-direction:column;gap:8px}
.sa-beat{display:flex;gap:12px;align-items:flex-start;border-top:1px solid #efece6;padding-top:8px}
.sa-beat:first-child{border-top:none;padding-top:0}
.sa-beat.past{opacity:.55}
.sa-beat .sa-beat-b{flex:1;min-width:0}
/* A PROGRAM's beat, not the narrator's. Typeface AND a very faint ground: once a beat greys out as a past one,
   the typeface alone stopped being enough to tell the two streams apart at a glance, which is the whole job.
   The tint is near-invisible in isolation and only reads as a band when several sit together. */
.sa-beat.prog{background:#f4f1ea;margin-left:-10px;margin-right:-10px;padding-left:10px;padding-right:10px}
.sa-beat.prog + .sa-beat.prog{border-top-color:#e7e2d8}
.sa-beat.prog .sa-beat-b{font-family:var(--mono);font-size:12px;color:#7d766a;letter-spacing:-.01em}
.sa-beat.clickable{cursor:pointer}
/* A number the program has told us reads well or badly. Tinted text, not a filled cell: a table of green and
   red blocks stops being readable, and the point is to draw the eye to the few that matter. */
.sa-fin td.up{color:#1f7a4d}
.sa-fin td.down{color:#a33}
/* An openable cell. Carried by COLOUR, not an underline: a dotted rule under every name in a column made the
   column harder to read than it was before, and the affordance is worth less than the reading. */
.sa-ent{color:#2f6f5e;cursor:pointer}
.sa-ent:hover{color:#1f7a4d;text-decoration:underline}
.sa-beat-x{opacity:0;transition:opacity .12s;background:transparent;border:0;padding:2px 4px;color:#9a9285;cursor:pointer;line-height:0;align-self:flex-start}
.sa-beat:hover .sa-beat-x{opacity:1}
.sa-beat-x:hover{color:var(--ink)}
.sa-beat-sql{font-family:var(--mono);font-size:12px;line-height:1.5;background:var(--panel);border:1px solid var(--hair);padding:8px 10px;margin:6px 0 0;overflow-x:auto;white-space:pre;color:var(--ink)}
.sa-beat .sa-beat-t{flex-shrink:0;font-size:11.5px;color:#a49a8c;font-variant-numeric:tabular-nums;padding-top:1px;min-width:26px;text-align:right}
.sa-analysis-card{border:1px solid #e8e4de;border-radius:10px;background:#fbfaf8;margin:2px 0 12px;font-size:13px}
.sa-analysis-card>summary{cursor:pointer;padding:10px 16px;color:#6b6459;font-weight:600;user-select:none}
.sa-analysis-card>.sa-ac-body{padding:0 16px 12px;display:flex;flex-direction:column;gap:8px}
.sa-fu{margin:2px 0 16px}
.sa-fu-label{font-size:12px;color:#8a8276;margin-bottom:8px;font-weight:600}
.sa-fu-list{display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.sa-fu-chip{text-align:left;border:1px solid #e0dcd4;background:#fff;border-radius:999px;padding:8px 15px;font-size:13.5px;color:#2a2a2a;cursor:pointer;max-width:100%;line-height:1.4}
.sa-fu-chip:hover{background:#f3f1ec}
.sa-narr{position:sticky;top:0;z-index:2;border:1px solid #cdd9c2;border-radius:8px;background:#eef4e6;padding:10px 12px;margin-bottom:12px;max-height:240px;overflow-y:auto;box-shadow:0 2px 8px rgba(0,0,0,.05)}
.sa-narr-h{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5a7a4a;margin-bottom:6px}
.sa-narr .sa-md{color:#3a4a2f}
.sa-narr .sa-nb{border-top:1px solid #d5e0c8;padding-top:6px;margin-top:6px}
.sa-narr .sa-nb:first-child{border-top:none;padding-top:0;margin-top:0}
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
}// Inject on LOAD, not when the first answer renders. This sheet does not only style answers: the live analysis
// indicator (.sa-live), its beats and the follow-up chips are all on screen BEFORE there is an answer to card.
// Hanging the injection off AnswerCard meant a page that loaded with a question already in flight showed the
// whole thing unstyled — the flex row collapsed, so "Analysis" and "details" ran together — and then silently
// corrected itself the moment an answer landed. A stylesheet the page needs from its first paint belongs here.
ensureAnswerCSS()


// ── Front-end-only helpers for the card actions (Copy / CSV) ─────────────────────────────────────────
// We HAVE the structured answer JSON here, so copy is built from it (clean), generic across the fields the
// card shows; paragraphs separated by blank lines, the table as TSV. Add a field to the card → add it here.
// meta (qid / timing / arrival time) is appended as a SEPARATE footer after the answer body, so a pasted
// answer carries its provenance (which question, how long, when) without cluttering the answer itself.
// ── Never hand React an object ───────────────────────────────────────────────
// The view-model is written by an AGENT, so any field can arrive in a shape the contract did not describe. A
// year-over-year answer put `period` — specified as a plain string — as
// `{current:{…}, previous:{…}, asOf:…}`, and rendering that threw React error #31 and took the whole card
// down. A wrong value should look wrong, never blank the page.
//
// Objects are rendered by their `label` where they have one (the shape `periods[]` already uses), else by the
// values a person would want to read. Anything else is dropped rather than stringified into "[object Object]".
function asText(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(' · ')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.label === 'string') return o.label + (typeof o.detail === 'string' ? ` — ${o.detail}` : '')
    const parts = Object.values(o).map(asText).filter(Boolean)
    return parts.length ? parts.join(' · ') : ''
  }
  return ''
}

// DEVELOPER VIEW for verb turns. `null` = not looked up yet; read from localStorage once, on the first event
// that arrives, then remembered. Absent or anything but "1"/"true" means off, which is the normal case.
//
//   localStorage.setItem('sa-verb-events', '1')   → show every event, not just the prose
let showAllVerbEvents: boolean | null = null
function wantsAllVerbEvents(): boolean {
  if (showAllVerbEvents === null) {
    try { const v = localStorage.getItem('sa-verb-events'); showAllVerbEvents = v === '1' || v === 'true' }
    catch { showAllVerbEvents = false }   // private mode / blocked storage — the default is off anyway
  }
  return showAllVerbEvents
}

/** One chat line for a verb-turn event, or '' to drop it. Prose always; the machinery only when asked for. */
function verbEventLine(ev: any): string {
  if (!ev?.kind) return ''
  if (ev.kind === 'message') return typeof ev.text === 'string' ? ev.text.trim() : ''
  if (!wantsAllVerbEvents()) return ''
  if (ev.kind === 'command') return '$ ' + String(ev.command ?? '').replace(/\s+/g, ' ').slice(0, 300)
  if (ev.kind === 'file') return 'file · ' + String(ev.text ?? '').slice(0, 300)
  if (ev.kind === 'reasoning') return String(ev.text ?? '').trim().slice(0, 300)
  return ''   // 'turn' and anything a later harness adds: no line, rather than a mystery one
}

// ONE BEAT, memoised. The card ticks once a second so the CURRENT beat's timer can count up — but a past
// beat's seconds are the gap to the beat after it, which never changes again. Without memo every row
// re-rendered every second: wasted work, and it destroyed a text selection the moment you made one, because
// the row you were selecting was being rebuilt underneath you.
//
// Every prop here is a primitive except `onToggle`, which the parent must keep stable (useCallback) or memo
// buys nothing.
const Beat = memo(function Beat(props: {
  text: string; secs: number; prog: boolean; past: boolean
  detail?: string; chevron: 'none' | 'open' | 'closed'; count: number
  head: number; onToggle: (head: number) => void
}) {
  const { text, secs, prog, past, detail, chevron, count, head, onToggle } = props
  return (
    <div className={'sa-beat' + (past ? ' past' : '') + (prog ? ' prog' : '') + (chevron !== 'none' ? ' clickable' : '')}
         onClick={chevron === 'none' ? undefined : () => {
           // The ROW toggles, not just the chevron — a 11px target was a poor thing to have to hit. But a click
           // that ends a text selection is someone copying a line, not asking to collapse it, so that wins.
           if (!window.getSelection()?.isCollapsed) return
           onToggle(head)
         }}>
      <div className="sa-beat-b sa-md" dangerouslySetInnerHTML={{ __html: renderInlineMd(text) }} />
      {detail && <pre className="sa-beat-sql">{detail}</pre>}
      {chevron !== 'none' && (
        <button className="sa-beat-x" onClick={() => onToggle(head)}
                title={chevron === 'open' ? 'Collapse' : `Show all ${count} steps`}>
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
            <path d={chevron === 'open' ? 'M2.5 7.5L6 4l3.5 3.5' : 'M2.5 4.5L6 8l3.5-3.5'}
                  fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <div className="sa-beat-t">{secs}s</div>
    </div>
  )
})

function answerToText(a: any, cat: string, meta?: { qid?: string; at?: number; timing?: { ms: number; classifyMs?: number; modelMs?: number } }): string {
  const out: string[] = []
  if (cat) out.push(cat.toUpperCase())
  const prose = typeof a.answer === 'string' || Array.isArray(a.answer) ? a.answer : null   // never stringify an unwrapped envelope
  if (prose) out.push(Array.isArray(prose) ? prose.join('; ') : String(prose))
  if (a.periods?.length) out.push('Time filter: ' + a.periods.map((p: any) => `${p.label}${p.detail ? ' — ' + p.detail : ''}`).join(' · '))
  else if (a.period) out.push('Time filter: ' + asText(a.period))
  const figs = Array.isArray(a.figures) && a.figures.length ? a.figures : a.headline?.display ? [{ label: a.headline.label, display: a.headline.display, sub: a.headline.sub }] : []
  if (figs.length) out.push(figs.map((f: any) => `${f.label}: ${f.display}${f.sub ? ` (${f.sub})` : ''}`).join('\n'))
  if (a.table?.columns) out.push([a.table.columns.map(colLabel).join('\t'), ...(a.table.rows || []).map((r: any[]) => r.map(cellText).join('\t'))].join('\n'))
  if (Array.isArray(a.sections)) for (const s of a.sections) {   // report blocks → readable text, in order
    if (s?.title) out.push(String(s.title).toUpperCase())
    if (s?.kind === 'text' && s.body) out.push(String(s.body))
    else if (s?.kind === 'kpis' && Array.isArray(s.items)) out.push(s.items.map((f: any) => `${f.label}: ${f.display}${f.sub ? ` (${f.sub})` : ''}`).join('\n'))
    else if (s?.kind === 'table' && Array.isArray(s.columns)) out.push([s.columns.map(colLabel).join('\t'), ...(s.rows || []).map((r: any[]) => r.map(cellText).join('\t'))].join('\n'))
    // Copy takes the WHOLE program, not just the file on screen — you copy it to paste it somewhere, and a
    // program is only useful entire.
    else if (s?.kind === 'files' && Array.isArray(s.files)) out.push(s.files.map((f: any) => `--- ${f?.path ?? ''} ---\n${f?.text ?? ''}`).join('\n\n'))
  }
  if (a.caveat) out.push('Note: ' + (Array.isArray(a.caveat) ? a.caveat.join('; ') : a.caveat))
  if (a.scope) out.push('Scope: ' + asText(a.scope))
  if (a.source) out.push('Source: ' + asText(a.source))
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
function tableToCSV(cols: Column[], rows: Cell[][], total?: any[]): string {
  const esc = (v: any) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  // An id column is added beside any entity column: the export is the place someone takes the data elsewhere,
  // and a name without its id is the thing they cannot join back.
  const spec = cols.map(colSpec)
  const header = spec.flatMap(c => c.entity ? [c.label, `${c.label} id`] : [c.label])
  const line = (r: Cell[]) => r.flatMap((cell, i) => spec[i]?.entity ? [cellText(cell), cellId(cell) ?? ''] : [cellText(cell)])
  const lines = [header.map(esc).join(','), ...rows.map(r => line(r).map(esc).join(','))]
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
function numColsOf(cols: Column[], rows: Cell[][]): boolean[] {
  return cols.map((_, ci) => rows.length > 0 && rows.every(r => {
    const v = cellValue(r[ci]); if (v == null) return true
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
  if (s.kind === 'files') return <FileBrowser title={s.title} files={Array.isArray(s.files) ? s.files : []} />
  return null
}

// The source of a program, from `program:`. A path list and one pane — you came to read the code, so the code
// gets the room. Paths are relative (the engine never sends anything else).
//
// Deliberately not syntax highlighted. Most answers are not programs, so shipping a highlighter in the bundle
// would be paying for it on every page load to serve the rare one. If colour is wanted later: inject Prism
// core + the typescript/json/sql components from a CDN on first use, once, and leave the plain <pre> standing
// if the injection fails.
function FileBrowser({ title, files }: { title?: string; files: any[] }) {
  const [sel, setSel] = useState(0)
  if (!files.length) return null
  const cur = files[Math.min(sel, files.length - 1)] ?? files[0]
  return (
    <div className="sa-sec sa-files">
      {title && <div className="sa-sec-title">{title}</div>}
      <div className="sa-files-tabs">
        {files.map((f: any, i: number) => (
          <button key={i} className={`sa-file-tab${i === sel ? ' on' : ''}`} onClick={() => setSel(i)} title={String(f?.path ?? '')}>
            {String(f?.path ?? `file ${i + 1}`)}
          </button>
        ))}
      </div>
      <pre className="sa-file-src"><code>{String(cur?.text ?? '')}</code></pre>
      {cur?.truncated && <div className="sa-file-note">This file was shortened to keep the message a sensible size.</div>}
    </div>
  )
}

// ── Codex event log — the 'events'-kind analyst view (the structured counterpart of the xterm 'pty' view) ──
// Renders the normalized AgentEvent stream (mirror of the engine's ica/session.ts AgentEvent) the way the
// native codex client does: command runs with collapsed output, assistant messages, reasoning, turn rules.
// One small component per event kind; events are keyed by id so a streaming block updates itself in place.
// 'user' is UI-synthesized (the question you asked) — the engine's stream vocabulary is the rest.

// The ONE table renderer — used by both the flat answer table AND each report section, so both get the same
// features: numeric right-alignment, a total/summary footer, "show more" pagination, CSV download, and the honest
// ONE CELL. Everything it can be is decided by the column's declaration plus the value itself — nothing here
// guesses. A plain column with a plain value renders exactly as it always did.
function Td({ cell, spec, numeric, peak }: { cell: Cell; spec: ColumnSpec; numeric: boolean; peak: number }) {
  const v = cellValue(cell)
  const n = typeof v === 'number' ? v : null
  const id = cellId(cell)
  const entity = cellEntity(cell, spec.entity)

  // The column says how the figure reads. A raw toLocaleString gave "686.769" for hours — three decimals of
  // precision the data never had — because nothing had said what the number was.
  const text = isObj_display(cell) ? cellText(cell)
             : n != null ? formatNumber(n, spec)
             : cellText(cell)

  // GOOD OR BAD is the program's call, never ours. `good` says which direction is favourable and `mid` is the
  // line it turns on — 0 by default, which is what a delta column wants. No declaration, no colour: a number
  // confidently shaded the wrong way is worse than one left alone.
  const tone = spec.good && n != null
    ? (n === (spec.mid ?? 0) ? '' : ((n > (spec.mid ?? 0)) === (spec.good === 'high') ? ' up' : ' down'))
    : ''

  return (
    // THE BAR IS THE CELL'S OWN BACKGROUND, filling from the right behind a right-aligned figure. It was a rule
    // UNDER the number, which read as an underline belonging to nothing, pushed every row taller and widened
    // the table — a table's whole value is being compact. A shaded ground costs no space at all.
    <td className={(numeric ? 'r fig' : '') + tone} title={id ? `${entity ?? 'id'} ${id}` : undefined}
        style={spec.bar && n != null && peak > 0
          ? { backgroundImage: `linear-gradient(to left, ${tone === ' down' ? 'rgba(163,51,51,.13)' : 'rgba(31,122,77,.13)'} ${Math.min(100, (Math.abs(n) / peak) * 100)}%, transparent 0)` }
          : undefined}>
      {id ? <span className="sa-ent" data-entity={entity} data-id={id}>{text}</span> : text}
    </td>
  )
}

// "N of TOTAL matching rows" count. Each instance owns its own pagination + download state.
function DataTable({ columns, rows, total, totalRows, title, note, csvName }: {
  columns: Column[]; rows: Cell[][]; total?: any[]; totalRows?: number; title?: string; note?: string; csvName?: string
}) {
  const [shown, setShown] = useState(PAGE)
  const [downloaded, setDownloaded] = useState(false)
  const spec = columns.map(colSpec)
  const numc = numColsOf(columns, rows)
  const visible = rows.slice(0, shown)
  // The largest magnitude per column, for the in-cell bar. Computed from the data because a bar is only
  // meaningful against the column it sits in — nothing to declare, and nothing to keep in step.
  const peak = spec.map((c, ci) => c.bar ? Math.max(0, ...rows.map(r => { const v = cellValue(r[ci]); return typeof v === 'number' ? Math.abs(v) : 0 })) : 0)
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
          <thead><tr>{columns.map((c, i) => <th key={i} className={numc[i] ? 'r' : ''}>{colLabel(c)}</th>)}</tr></thead>
          <tbody>{visible.map((r, ri) => (
            <tr key={ri}>{r.map((cell, ci) => (
              <Td key={ci} cell={cell} spec={spec[ci]} numeric={!!numc[ci]} peak={peak[ci]} />
            ))}</tr>))}</tbody>
          {Array.isArray(total) && total.length > 0 && (
            <tfoot><tr className="sa-total">{columns.map((_, i) => {
              const v = cellValue(total[i])
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
      {/* Prose only. `answer` is also the unit envelope's key one level up, so an output that was never
          unwrapped lands here as the whole view-model — and String()ing it printed "[object Object]" to a user
          while the KPI and tables silently vanished. Render it when it IS prose; an object is a bug upstream,
          not something to stringify. */}
      {(typeof a.answer === 'string' || Array.isArray(a.answer)) &&
        <div className="sa-prose" dangerouslySetInnerHTML={{ __html: renderAnswerBody(a.answer) }} />}
      {(a.periods?.length > 0 || a.period) && (
        <div className="sa-period"><span className="pk">Time filter</span>
          {a.periods?.length > 0
            ? a.periods.map((p: any, i: number) => <span key={i}><b>{asText(p.label ?? p)}</b>{p.detail ? ` — ${asText(p.detail)}` : ''}{i < a.periods.length - 1 ? '   ·   ' : ''}</span>)
            : <b>{asText(a.period)}</b>}
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
      {/* Section-format results (the current format). */}
      {Array.isArray(a.sections) && a.sections.map((s: any, i: number) => <SectionBlock key={i} s={s} />)}
      {/* Backward-compat: programs built in the OLDER format (and reused since) emit a flat top-level `table`
          instead of a `table` section. Render it too — dropping it stranded every pre-format program (e.g. all
          of TotalGroup's), silently losing real rows. */}
      {a.table?.columns && (!Array.isArray(a.sections) || !a.sections.some((s: any) => s?.kind === 'table')) && (
        <DataTable columns={a.table.columns} rows={a.table.rows ?? []} total={a.table.total} totalRows={a.table.totalRows} title={a.table.title} note={a.table.note} csvName={a.table.title} />
      )}
      {a.caveat && <div className="sa-caveat" dangerouslySetInnerHTML={{ __html: renderAnswerBody(a.caveat) }} />}
      {a.scope && <div className="sa-src"><b>Scope:</b> {asText(a.scope)}</div>}
      {a.source && <div className="sa-src"><b>Source:</b> {asText(a.source)}</div>}
      {a.missing && <div className="sa-caveat">No source in the data: {asText(a.missing)}</div>}
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

