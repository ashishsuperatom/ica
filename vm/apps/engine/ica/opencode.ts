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
import type { Session, RunHandlers, RunResult } from './session.js'   // the shared session interface

export interface OpencodeSessionOpts {
  cwd: string
  provider?: string   // default 'opencode-go'
  model?: string      // default 'glm-5.2'
  // Connect to a STANDALONE `opencode serve` (recommended): one ~370MB server for the whole box,
  // shared by every engine — this harness then spawns nothing (client-only, ~0 extra RAM).
  // Set via opts.baseUrl or ICA_OC_URL (e.g. http://127.0.0.1:4096). If unset, spawns a private
  // server (createOpencode) — the ~370MB is then paid per engine.
  baseUrl?: string
  hostname?: string   // default '127.0.0.1' (only when spawning a private server)
  port?: number       // default 0 ephemeral (only when spawning a private server)
}

// ALL PERMISSIONS enabled — opencode gates edit/webfetch on "ask" by default, which HANGS a headless
// run (nobody answers). We AUTO-APPROVE every permission request in the event loop (see ensure()).
// (Passing a permission config to `opencode serve` crashes it, and wouldn't cover a server we merely
// connect to — auto-approve works in every case and needs no server config.)

// Best-effort text extraction from an opencode message's parts.
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

export function createOpencodeSession(opts: OpencodeSessionOpts): Session {
  const providerID = opts.provider ?? process.env.ICA_OC_PROVIDER ?? 'opencode-go'
  const modelID = opts.model ?? process.env.ICA_OC_MODEL ?? 'glm-5.2'
  let client: any = null
  let server: any = null
  let ownsServer = false   // true ONLY when this harness spawned the server — we stop what we start, and never touch a server we merely connected to
  let managed: { stop: () => void } | null = null   // the standalone server WE started (to reap it)
  let sse: AbortController | null = null   // aborts OUR event subscription on stop (so closing a server doesn't ECONNRESET-reject)
  let sessionId = ''
  let buf = ''
  let running = false
  let activeHandler: RunHandlers | undefined
  const queue: { prompt: string; h?: RunHandlers; resolve: (r: RunResult) => void }[] = []

  async function ensure() {
    if (client) return
    // The MODULE owns the opencode-server lifecycle — the caller just picks harness=opencode.
    // Ensure ONE standalone `opencode serve` is up (probe a fixed port → start it if down → own it),
    // then connect client-only. Own only what we started; a server already running is left alone.
    const oc = await ensureOpencodeServer(opts.baseUrl ?? process.env.ICA_OC_URL)
    ownsServer = oc.owned
    managed = oc.owned ? oc : null
    client = createOpencodeClient({ baseUrl: oc.url })
    server = null
    if (ownsServer) {
      // Reap a server WE started on process termination. close() SIGTERMs the ~370MB binary but needs
      // the node process alive ~300ms to propagate — else the child orphans (ppid=1).
      const term = () => { try { managed?.stop() } catch {} ; setTimeout(() => process.exit(0), 300) }
      process.once('SIGINT', term); process.once('SIGTERM', term)
      process.once('exit', () => { try { managed?.stop() } catch {} })
    }
    const created = await client.session.create({ body: { title: 'ica' }, query: { directory: opts.cwd } })
    sessionId = created?.data?.id ?? created?.id
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
          if (chunk) { buf = (buf + chunk).slice(-64000); activeHandler?.onOutput?.(chunk) }
        }
      } catch { /* aborted on stop() or stream closed — expected */ }
    })().catch(() => {})
  }

  async function pump() {
    if (running || !queue.length) return
    running = true
    const { prompt, h, resolve } = queue.shift()!
    await ensure()
    activeHandler = h
    const t0 = Date.now()
    let answer = ''
    try {
      const res = await client.session.prompt({                         // resolves when the turn is DONE (exact completion)
        path: { id: sessionId },
        query: { directory: opts.cwd },
        body: { model: { providerID, modelID }, parts: [{ type: 'text', text: prompt }] },
      })
      answer = partsText(res?.data?.parts ?? res?.parts ?? [])
    } catch (e: any) { answer = `opencode error: ${e?.message ?? e}` }
    activeHandler = undefined
    running = false
    resolve({ lastLines: answer, ms: Date.now() - t0 })
    pump()
  }

  return {
    async run(prompt, h) { return new Promise<RunResult>((resolve) => { queue.push({ prompt, h, resolve }); pump() }) },
    async compact() {                                                   // opencode summarizes its own context
      try { await client?.session?.summarize?.({ path: { id: sessionId }, query: { directory: opts.cwd } }) } catch {}
      return { lastLines: '(opencode summarized session context)', ms: 0 }
    },
    buffer: () => buf,
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

export async function ensureOpencodeServer(url?: string): Promise<{ url: string; owned: boolean; stop: () => void }> {
  const target = url || 'http://127.0.0.1:4096'
  if (await isOpencodeUp(target)) return { url: target, owned: false, stop: () => {} }
  const u = new URL(target)
  const server = await createOpencodeServer({ hostname: u.hostname, port: Number(u.port) || 4096 })   // waits until "listening"
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
