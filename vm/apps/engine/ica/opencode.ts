// ── opencode session — a clean, reusable module (SAME interface as ica/claude.ts) ──
// Runs the opencode SERVER headless (no TUI, no UI) and drives it with @opencode-ai/sdk.
// No terminal emulation and no idle-timeout: session.prompt() resolves when the turn is
// done and returns the final message, so completion is exact. A background SSE stream
// (client.event()) surfaces EVERY event; onEvent exposes the full raw event so the caller
// selects what to forward over the WS. Prompt-agnostic; knows nothing about the hub.
//
//   Subscription: providerID default 'opencode-go' (the logged-in OpenCode Go sub).
//   Override via opts / ICA_OC_PROVIDER + ICA_OC_MODEL.

import { createOpencode, createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk'
import type { AgentEvent } from './session.js'
import type { Session, RunHandlers, RunResult } from './session.js'   // the shared session interface
import { providersOn, isDisabled } from '../../../packages/agent-contract/contract.mjs'
import { profile } from '../config/index.js'

export interface OpencodeSessionOpts {
  cwd: string
  provider?: string   // default 'opencode-go'
  model?: string      // default: the profile's harnessModel.opencode
  // Connect to a STANDALONE `opencode serve` (recommended): one ~370MB server for the whole box,
  // shared by every engine — this harness then spawns nothing (client-only, ~0 extra RAM).
  // Set via opts.baseUrl or ICA_OC_URL (e.g. http://127.0.0.1:4096). If unset, spawns a private
  // server (createOpencode) — the ~370MB is then paid per engine.
  baseUrl?: string
  hostname?: string   // default '127.0.0.1' (only when spawning a private server)
  resumeId?: string   // a prior session id — opencode prompts BY id, so continuing one is just not creating one
  port?: number       // default 0 ephemeral (only when spawning a private server)
  noTools?: boolean   // disable ALL tools for this session (pure text completion — no tool schemas, no tool calls)
  system?: string     // REPLACE opencode's default coding system prompt with this one (for pure-LLM agents)
  systemReference?: string   // authoritative authoring reference → folded into the system prompt (for coding agents)
}

// ALL PERMISSIONS enabled — opencode gates edit/webfetch on "ask" by default, which HANGS a headless
// run (nobody answers). We AUTO-APPROVE every permission request in the event loop (see ensure()).
// (Passing a permission config to `opencode serve` crashes it, and wouldn't cover a server we merely
// connect to — auto-approve works in every case and needs no server config.)

// Best-effort text extraction from an opencode message's parts.
/** fetch with undici's idle-body deadline removed. A coding turn is a single long request with nothing on the
 *  wire until it finishes; Node's default 300s body timeout treats that as a stalled connection and aborts it.
 *  Falls back to plain fetch where the undici Agent is unavailable — a working request beats a tuned one. */
const noTimeoutFetch: any = async (input: any, init: any = {}) => {
  try {
    const { Agent } = await import('undici')
    return await (fetch as any)(input, { ...init, dispatcher: new Agent({ bodyTimeout: 0, headersTimeout: 0 }) })
  } catch {
    return await (fetch as any)(input, init)
  }
}

function partsText(parts: any[]): string {
  return (parts || []).filter(p => p?.type === 'text' && p.text).map(p => p.text).join('').trim()
}

// Turn one SSE event into a readable stream chunk. `seen` tracks how much of each text part we've
// already emitted, so assistant text streams incrementally (opencode sends the growing full text on
// every message.part.updated). Tool parts emit a one-line "→ tool …" when they start running.
function fmtEvent(e: any, seen: Map<string, number>, asst: Set<string>): string {
  if (e?.type !== 'message.part.updated') return ''
  const part = (e.properties || e)?.part
  if (!part) return ''
  if (part.type === 'text' && typeof part.text === 'string') {
    if (!asst.has(part.messageID)) return ''                       // skip the user prompt's text part — assistant only
    const prev = seen.get(part.id) || 0
    if (part.text.length <= prev) return ''
    seen.set(part.id, part.text.length)
    return part.text.slice(prev)                                   // only the new suffix
  }
  if (part.type === 'tool') {
    const name = part.tool || part.name
    const input = part.state?.input || part.input || {}
    const d = input.command || input.filePath || input.path || (input.sql ? String(input.sql).replace(/\s+/g, ' ').slice(0, 140) : '')
    const key = `tool:${part.id}`
    if ((part.state?.status === 'running' || part.state?.status === 'pending') && !seen.has(key)) {
      seen.set(key, 1)                                             // emit the tool line once
      return `→ ${name} ${d}`.trim() + '\r\n'
    }
  }
  return ''
}

// Normalize ONE opencode message part → AgentEvent for the UI event log (null = not rendered).
// FORMAT CONTRACT — @opencode-ai/sdk 1.18. NOTE: opencode's /event SSE stopped delivering message.part.updated
// since 1.14.42 (upstream bug anomalyco/opencode#27966), so we do NOT rely on the SSE for parts — we POLL
// session.messages (see below) and normalize the parts here. Parts: {type:'text', id, text} and
// {type:'tool', id, tool|name, state:{status, input, output}}. Stable part id → the UI updates a block in place.
function normPart(part: any): AgentEvent | null {
  if (!part) return null
  if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
    return { kind: 'message', id: part.id, text: part.text }
  }
  if (part.type === 'tool') {
    const name = part.tool || part.name || 'tool'
    const st = part.state || {}
    const input = st.input || part.input || {}
    const d = input.command || input.filePath || input.path || (input.sql ? String(input.sql).replace(/\s+/g, ' ').slice(0, 200) : '')
    const output = typeof st.output === 'string' ? st.output : (st.output ? JSON.stringify(st.output).slice(0, 4000) : '')
    const status = st.status
    return { kind: 'command', id: part.id, command: `${name}${d ? ' ' + d : ''}`.trim(), output, status, done: status === 'completed' || status === 'error' }
  }
  return null
}

export function createOpencodeSession(opts: OpencodeSessionOpts): Session {
  const providerID = opts.provider ?? process.env.ICA_OC_PROVIDER ?? 'opencode-go'
  const modelID = opts.model ?? process.env.ICA_OC_MODEL ?? profile().harnessModel.opencode!
  // The system prompt sent per turn: an explicit `system` (pure-LLM agents) plus the authoritative authoring
  // reference (coding agents). Both fold into opencode's `system` field (which REPLACES its default coding prompt).
  const effSystem = [opts.system, opts.systemReference].filter(Boolean).join('\n\n') || undefined
  let client: any = null
  let server: any = null
  let ownsServer = false   // true ONLY when this harness spawned the server — we stop what we start, and never touch a server we merely connected to
  let managed: { stop: () => void } | null = null   // the standalone server WE started (to reap it)
  let sse: AbortController | null = null   // aborts OUR event subscription on stop (so closing a server doesn't ECONNRESET-reject)
  let sessionId = opts.resumeId ?? ''        // reuse a prior session when given one — see ensure()
  const rawSubs = new Set<(chunk: string) => void>()
  let buf = ''
  const eventLog: AgentEvent[] = []                 // structured events (the 'events' view), fed by POLLING (SSE is broken)
  const polled = new Map<string, string>()          // part id → last signature, so we emit only on change
  let running = false
  let activeHandler: RunHandlers | undefined
  const queue: { prompt: string; h?: RunHandlers; resolve: (r: RunResult) => void }[] = []

  async function ensure() {
    if (client) return
    // The MODULE owns the opencode-server lifecycle — the caller just picks harness=opencode.
    // Ensure ONE standalone `opencode serve` is up (probe a fixed port → start it if down → own it),
    // then connect client-only. Own only what we started; a server already running is left alone.
    const oc = await ensureOpencodeServer(opts.baseUrl ?? process.env.ICA_OC_URL, providerID)
    ownsServer = oc.owned
    managed = oc.owned ? oc : null
    // NO BODY TIMEOUT. `session.prompt()` is one POST that returns only when the whole turn is finished, and
    // undici aborts a request whose body has been idle for 300s by default. A turn that thinks for longer than
    // five minutes was killed mid-work, every time, at exactly 300s — caught into an error string, so it read
    // as an agent that had simply run out of things to say: no program, no escalation, no reason given.
    // Measured at 300s, 301s and 301s on three consecutive composer turns before the cause was found.
    client = createOpencodeClient({ baseUrl: oc.url, fetch: noTimeoutFetch })
    server = null
    if (ownsServer) {
      // Reap a server WE started on process termination. close() SIGTERMs the ~370MB binary but needs
      // the node process alive ~300ms to propagate — else the child orphans (ppid=1).
      const term = () => { try { managed?.stop() } catch {} ; setTimeout(() => process.exit(0), 300) }
      process.once('SIGINT', term); process.once('SIGTERM', term)
      process.once('exit', () => { try { managed?.stop() } catch {} })
    }
    // RESUME when we were handed one. opencode addresses a session by id on every prompt, so continuing a
    // conversation is simply not creating a new one — it had no resume path only because nobody wired it.
    if (!sessionId) {
      const created = await client.session.create({ body: { title: 'ica' }, query: { directory: opts.cwd } })
      sessionId = created?.data?.id ?? created?.id
    }
    // ONE background SSE consumer for the whole server; route events to the active turn.
    sse = new AbortController()
    const seen = new Map<string, number>()                               // per-part emitted length (incremental text)
    const asst = new Set<string>()                                       // message ids known to be from the assistant
    ;(async () => {
      try {
        const evres = await client.event.subscribe({ signal: sse!.signal })
        for await (const ev of evres.stream) {
          activeHandler?.onEvent?.(ev)                                   // FULL raw event — caller selects what to forward
          if (ev?.type === 'permission.asked' || ev?.type === 'permission.updated') {   // ALL PERMISSIONS: auto-approve
            const p = (ev.properties || ev) as any                       // method is on the client ROOT, not client.session
            if (p?.id && p?.sessionID) {
              client.postSessionIdPermissionsPermissionId?.({ path: { id: p.sessionID, permissionID: p.id }, body: { response: 'always' }, query: { directory: opts.cwd } })?.catch?.(() => {})
            }
          }
          if (ev?.type === 'message.updated') {                          // learn each message's role (parts carry no role)
            const m = (ev.properties || ev).info || (ev.properties || ev).message
            if (m?.role === 'assistant' && m.id) asst.add(m.id)
          }
          const chunk = fmtEvent(ev, seen, asst)
          if (chunk) {
            buf = (buf + chunk).slice(-64000); activeHandler?.onOutput?.(chunk)
            for (const cb of rawSubs) { try { cb(chunk) } catch { /* one bad watcher cannot break the rest */ } }
          }
        }
      } catch { /* aborted on stop() or stream closed — expected */ }
    })().catch(() => {})
  }

  // Emit one normalized event: update the block with the same id, else append; skip if unchanged since last poll.
  function emit(ne: AgentEvent, h?: RunHandlers) {
    const sig = `${ne.text?.length ?? 0}:${ne.output?.length ?? 0}:${ne.status ?? ''}:${ne.done ? 1 : 0}`
    if (ne.id && polled.get(ne.id) === sig) return
    if (ne.id) polled.set(ne.id, sig)
    if (ne.id) { const i = eventLog.findIndex(x => x.id === ne.id); if (i >= 0) eventLog[i] = ne; else eventLog.push(ne) }
    else eventLog.push(ne)
    if (eventLog.length > 600) eventLog.shift()
    h?.onEvent?.(ne)
  }
  // Poll the session's messages → normalize the assistant parts → emit changed events. This is the live event
  // source (opencode's SSE part stream is broken since 1.14.42, #27966), polled every ~1s during a turn.
  async function pollMessages(h?: RunHandlers) {
    try {
      const res: any = await client.session.messages({ path: { id: sessionId }, query: { directory: opts.cwd } })
      for (const m of (res?.data ?? res ?? [])) {
        const info = m.info ?? m
        if (info?.role !== 'assistant') continue
        // ONE opencode session multiplexes MANY questions (its history is the whole session). Attribute a message
        for (const part of (m.parts ?? info.parts ?? [])) {
          const ne = normPart(part); if (ne) emit(ne, h)
        }
      }
    } catch { /* transient — next poll retries */ }
  }

  async function pump() {
    if (running || !queue.length) return
    running = true
    const { prompt, h, resolve } = queue.shift()!
    await ensure()
    activeHandler = h
    const t0 = Date.now()
    let answer = ''
    const poll = setInterval(() => { void pollMessages(h) }, 1000)      // live events via polling (SSE parts broken)
    try {
      const res = await client.session.prompt({                         // resolves when the turn is DONE (exact completion)
        path: { id: sessionId },
        query: { directory: opts.cwd },
        // `system` REPLACES opencode's default coding prompt; `tools:{'*':false}` disables the whole toolset —
        // so a pure-LLM agent (narrator) pays for neither the agent scaffolding nor the tool schemas.
        body: { model: { providerID, modelID }, parts: [{ type: 'text', text: prompt }], ...(effSystem ? { system: effSystem } : {}), ...(opts.noTools ? { tools: { '*': false } } : {}) },
      })
      answer = partsText(res?.data?.parts ?? res?.parts ?? [])
      await pollMessages(h)                                            // final scan (part-id dedupe) — catch an event that landed after the last poll
      // Cost visibility: log this turn's token usage + $cost. The prompt prefix identifies the caller
      // (reflex vs narrator, etc.). opencode's message info carries tokens{input,output,reasoning,cache} + cost.
      try {
        const info: any = (res as any)?.data?.info ?? (res as any)?.info
        if (info) { const tk = info.tokens ?? {}
          console.log(`[oc-usage] ${modelID} in=${tk.input ?? '?'} out=${tk.output ?? '?'} reason=${tk.reasoning ?? 0} cacheR=${tk.cache?.read ?? 0} cacheW=${tk.cache?.write ?? 0} cost=$${info.cost ?? '?'} · "${String(prompt).slice(0, 26).replace(/\s+/g, ' ')}…"`) }
      } catch { /* usage logging is best-effort */ }
    } catch (e: any) { answer = `opencode error: ${e?.message ?? e}` }
    finally { clearInterval(poll); await pollMessages(h) }               // one final poll to catch the last state
    activeHandler = undefined
    running = false
    resolve({ lastLines: answer, ms: Date.now() - t0 })
    pump()
  }

  return {
    referencePlacement: opts.systemReference ? 'in-context' : 'file',   // folded into opencode's `system` when present
    async run(prompt, h) { return new Promise<RunResult>((resolve) => { queue.push({ prompt, h, resolve }); pump() }) },
    async compact() {                                                   // opencode summarizes its own context
      try { await client?.session?.summarize?.({ path: { id: sessionId }, query: { directory: opts.cwd } }) } catch {}
      return { lastLines: '(opencode summarized session context)', ms: 0 }
    },
    // Built BEFORE a question arrives, so the first one does not pay to start the server and open a session.
    async warmup() { await ensure() },

    // Throw the conversation away. The next turn opens a fresh session; this is the in-place recovery for a
    // wedged one, which otherwise needs the whole engine restarted.
    turnEnd: 'native' as const,   // the server reports the turn; doneWhen is never polled
    reset: () => { sessionId = ''; buf = ''; running = false },

    // Watch the live stream without owning it. Returns its own unsubscribe.
    onRaw: (cb: (chunk: string) => void) => { rawSubs.add(cb); return () => rawSubs.delete(cb) },

    // The session id, so the engine can persist it and resume this conversation later. It was held as a local
    // and never handed back, which is why opencode alone could not be resumed across a restart.
    sessionId: () => sessionId || undefined,

    // Text pushed into a turn already running. Fire and forget: the caller is a keystroke stream, and awaiting
    // a round trip per character would make typing unusable.
    input: (data: string) => { void client?.session?.prompt?.({ path: { id: sessionId }, query: { directory: opts.cwd }, body: { parts: [{ type: 'text', text: data }] } })?.catch?.(() => {}) },

    buffer: () => buf,
    events: () => eventLog,
    busy: () => running,
    // Clean up OUR session on the server either way; stop the SERVER only if we spawned it.
    // If we connected to a shared/standalone server, leave it running for everyone else.
    stop: () => {
      try { sse?.abort() } catch {}                                     // stop consuming events first
      if (ownsServer) {
        try { managed?.stop() } catch {}                                // our server → reap it; the session dies with it (no delete needed)
      } else if (sessionId) {
        // shared server → clean up only OUR session, then leave the server running for everyone else.
        // .catch swallows the async fetch rejection (the promise, not a sync throw).
        try { client?.session?.delete?.({ path: { id: sessionId }, query: { directory: opts.cwd } })?.catch?.(() => {}) } catch {}
      }
      client = null; server = null; managed = null; ownsServer = false; sse = null
    },
  }
}

// ── ensure a standalone server ───────────────────────────────────────────────
// For the engine: make sure ONE `opencode serve` is up at `url` before we connect.
//   - already listening  → return { owned:false } (someone else runs it — leave it alone)
//   - not listening      → spawn `opencode serve` on that port, return { owned:true, stop } (we own it → reap it)
// Default url http://127.0.0.1:4096. The caller passes the returned url as baseUrl and calls
// stop() on shutdown (a no-op when we don't own it).
async function isOpencodeUp(url: string): Promise<boolean> {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true }   // any HTTP response (even 404) = listening
  catch { return false }                                                          // ECONNREFUSED / timeout = down
}

// ── POINTING THE SERVER AT OUR PROXY ─────────────────────────────────────────
// opencode resolves a provider from its OWN config and login, inside a process we spawn — so unlike pi there
// is no model object to rewrite from here. A box with no `opencode auth login` therefore had no credential
// for opencode-go, and the composer started, said nothing, and returned an empty answer.
//
// The lever is the config the server is launched with: a provider's baseURL and apiKey. Pointed at the proxy,
// the key we hand over is the PROJECT key — an identifier the proxy proves and swaps for the real one — so no
// provider secret exists on the machine to leak or to rotate.
//
// The SDK passes this config to the child in OPENCODE_CONFIG_CONTENT, an environment variable, so it is never
// written to disk: the same terms as pi's in-memory override and the vault's claude token.
function proxyConfig(provider: string): Record<string, any> | undefined {
  const platform = process.env.SUPERATOM_PLATFORM
  const project = process.env.ICA_PROJECT
  const key = process.env.ICA_KEY
  if (!platform || !project || !key || isDisabled(provider) || providersOn('tunnel').includes(provider)) return undefined
  const baseURL = `https://proxy.${platform}/p/${project}/${provider}`
  console.log(`[ica:oc] via proxy → ${baseURL}`)
  return { provider: { [provider]: { options: { baseURL, apiKey: key } } } }
}

export async function ensureOpencodeServer(url?: string, provider?: string): Promise<{ url: string; owned: boolean; stop: () => void }> {
  const target = url || 'http://127.0.0.1:4096'
  if (await isOpencodeUp(target)) return { url: target, owned: false, stop: () => {} }
  const u = new URL(target)
  const config = provider ? proxyConfig(provider) : undefined
  // waits until "listening"
  const server = await createOpencodeServer({ hostname: u.hostname, port: Number(u.port) || 4096, ...(config ? { config: config as any } : {}) })
  return { url: server.url, owned: true, stop: () => { try { server.close() } catch {} } }
}

// ── login scaffold ───────────────────────────────────────────────────────────
// Real interactive login (opencode auth login / claude-code) comes later; for now this
// only REPORTS what credentials opencode already has, so the caller can pick a provider.
export async function opencodeAuthStatus(): Promise<{ provider: string; type: string }[]> {
  const { client, server } = await createOpencode({ hostname: '127.0.0.1', port: 0 })
  try {
    const provs: any = await client.config.providers()
    const list = provs?.data?.providers ?? provs?.providers ?? []
    return (Array.isArray(list) ? list : []).map((p: any) => ({ provider: p.id, type: 'configured' }))
  } finally { try { server.close() } catch {} }
}

// TODO(login): interactive `opencode auth login <provider>` and claude-code OAuth — scaffold only.
export async function login(_provider: string): Promise<never> {
  throw new Error('login() not implemented yet — run `opencode auth login` in a terminal for now')
}
