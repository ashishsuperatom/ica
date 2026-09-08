// ── pi session — a clean, reusable module (SAME interface as ica/claude.ts) ───
// Uses the pi coding-agent SDK with an OpenRouter model. No terminal emulation — the SDK
// streams events and tells us when a turn is idle, so completion is exact (no idle-timeout).
// Prompt-agnostic; knows nothing about the hub/protocol. One persistent session, queued turns.
//
//   OPENROUTER_API_KEY must be set. Model via opts.model / ICA_PI_MODEL (default deepseek-v4-flash).

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager, ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { Session, RunHandlers, RunResult, AgentEvent } from './session.js'   // the shared session interface
import { resolveProvider, describeResolution } from './providers.js'
import { providersOn } from '../../../packages/agent-contract/contract.mjs'
import { profile } from '../config/index.js'

/** The ChatGPT credential `codex login` already wrote. pi-ai ships an `openai-codex-responses` provider that
 *  wants a Bearer token, and codex keeps a live one — so the two only need introducing, not a second login.
 *
 *  Read on every session, never cached: the codex CLI refreshes this file, and holding the token we saw at boot
 *  is how a long-running engine ends up authenticating with an expired one. */
export function codexCredential(): { apiKey: string; accountId?: string } | null {
  try {
    const a = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'))
    const tok = a?.tokens?.access_token
    return tok ? { apiKey: tok, accountId: a?.tokens?.account_id } : (a?.OPENAI_API_KEY ? { apiKey: a.OPENAI_API_KEY } : null)
  } catch { return null }
}

export interface PiSessionOpts {
  cwd: string
  provider?: string   // default: codex when `codex login` has been done, else openrouter
  model?: string
  systemReference?: string   // the authoring reference → AGENTS.md, which pi's resource loader reads from cwd
  noTools?: boolean          // a PURE TEXT agent (the narrator): no tools at all
  system?: string            // REPLACES the coding prompt — for an agent that only writes prose
  resumeId?: string          // a prior session's file, to continue the conversation instead of starting over
}

// Turn one SDK event into a human-readable stream chunk (tool starts + assistant text).
function fmtEvent(e: any): string {
  if (!e?.type) return ''
  if (e.type === 'tool_execution_start') {
    const a = e.args || {}
    const d = a.command || a.path || a.file_path || (a.sql ? String(a.sql).replace(/\s+/g, ' ').slice(0, 140) : '')
    return `→ ${e.toolName || e.tool?.name || 'tool'} ${d}`.trim() + '\r\n'
  }
  if (e.type === 'message_end' && e.message?.role === 'assistant') {
    const t = (e.message.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ').trim()
    return t ? t + '\r\n' : ''
  }
  return ''
}

/** pi's own event → the shared AgentEvent. Every other harness does this translation; pi used to forward its
 *  RAW SDK event instead, so the engine — which reads `kind`, `id`, `command` and `status` — could not see a
 *  command start or finish. Its log rows never appeared and its steps were never timed, which is precisely the
 *  "switching harness changes what the system does" that all of this is meant to prevent.
 *
 *  `id` matters as much as `kind`: the engine pairs a command's start with its completion by id to work out how
 *  long the step took. Without a stable one, nothing can be timed. */
/** Reopen a prior session, or nothing if it has gone. A stored path can outlive the file it names — the
 *  session directory is cleaned, a workspace is rebuilt — and every CLI treats that as a hard failure rather
 *  than starting fresh. One quiet fallback turns "the agent is broken" into "the agent lost its memory". */
function tryOpenSession(path: string, cwd: string): any | null {
  try { return SessionManager.open(path, undefined, cwd) }
  catch (e: any) { console.warn(`[ica:pi] could not resume ${path} (${e?.message ?? e}) — starting a fresh session`); return null }
}

/** The text a pi tool produced. pi returns `{ content: [{ type:'text', text }] }` — not a string and not
 *  `.output`, which is where the first version of this looked, so every completion arrived with no output at
 *  all. The narrator is fed from command RESULTS, so an empty output there meant it was never called once in a
 *  whole turn while the run itself worked perfectly. */
function piResultText(result: any): string | undefined {
  if (result == null) return undefined
  if (typeof result === 'string') return result
  const parts = Array.isArray(result?.content) ? result.content : null
  if (parts) {
    const t = parts.filter((c: any) => c?.type === 'text' || typeof c?.text === 'string').map((c: any) => c.text).join('\n').trim()
    return t || undefined
  }
  return typeof result?.output === 'string' ? result.output : undefined
}

function normPiEvent(e: any, cmds: Map<string, string>): AgentEvent | null {
  if (!e?.type) return null
  const id = e.toolCallId ?? e.id ?? (e.toolName ? `${e.toolName}:${e.callIndex ?? ''}` : undefined)
  const a = e.args || {}
  const cmd = a.command || a.path || a.file_path || (a.sql ? String(a.sql).replace(/\s+/g, ' ').slice(0, 300) : '')

  // pi puts the ARGS on the start event and the OUTPUT on the end event, and the two never meet. Remember the
  // command here so the completion can carry it: without that, a finished step reads "bash" with no command,
  // the log row says only `Ran bash`, and the narrator — which needs to see WHAT was run to know a query from a
  // file read — is fed nothing at all for the whole turn.
  if (e.type === 'tool_execution_start') {
    const command = `${e.toolName || e.tool?.name || 'tool'} ${cmd}`.trim()
    if (id) cmds.set(id, command)
    return { kind: 'command', id, command, status: 'in_progress', done: false }
  }

  if (e.type === 'tool_execution_end' || e.type === 'tool_result') {
    const failed = e.isError || e.error || e.result?.isError
    const remembered = id ? cmds.get(id) : undefined
    if (id) cmds.delete(id)                                    // drained as it completes — only live steps are held
    return { kind: 'command', id, command: remembered ?? `${e.toolName || e.tool?.name || 'tool'} ${cmd}`.trim(),
             output: piResultText(e.result) ?? piResultText(e.output),
             status: failed ? 'failed' : 'completed', done: true }
  }

  if (e.type === 'message_end' && e.message?.role === 'assistant') {
    const t = (e.message.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ').trim()
    return t ? { kind: 'message', id: e.message?.id, text: t, done: true } : null
  }

  if (e.type === 'reasoning' || e.type === 'thinking') {
    const t = String(e.text ?? e.content ?? '').trim()
    return t ? { kind: 'reasoning', id, text: t, done: true } : null
  }
  return null
}

// ONE shared model runtime, reading the SAME ~/.pi/agent that the `pi` CLI writes.
//
// This replaces the static getModel() catalog, and the difference is the whole point: the built-in catalog is
// frozen at the version of pi-ai we happen to have installed, so a model released since then simply does not
// exist to us — gpt-5.6-luna was selectable in the terminal and invisible here for exactly that reason. The
// runtime reads the live catalog instead, so authorising a model once with `pi` → /login → /model is enough
// and a newer model is adopted by upgrading pi rather than by editing this file.
let runtimeP: Promise<any> | null = null
function modelRuntime(): Promise<any> {
  const agentDir = getAgentDir()
  runtimeP ??= (ModelRuntime as any).create({
    authPath: `${agentDir}/auth.json`,
    modelsStorePath: `${agentDir}/models-store.json`,
    allowModelNetwork: true,
  })
  return runtimeP!
}

export function createPiSession(opts: PiSessionOpts): Session {
  // WHICH ACCOUNT PAYS — decided from the MODEL, not pinned globally. The chain per model lives in
  // providers.ts; here we just take the first account we actually hold a credential for. This used to be
  // "codex if a codex login exists, else OpenRouter", which quietly put every model on one account —
  // including models that account does not carry, and including models we would rather bill elsewhere.
  //
  // An explicit opts.provider / ICA_PI_PROVIDER still wins outright: routing is the default, never a veto.
  const modelId = opts.model ?? process.env.ICA_PI_MODEL ?? profile().harnessModel.pi!
  const pinned = opts.provider ?? process.env.ICA_PI_PROVIDER
  const routed = pinned ? null : resolveProvider(modelId)
  if (routed) console.log(`[ica:pi] ${describeResolution(modelId, routed)}`)
  // No credential for anything in the chain is still a real attempt: the SDK's own error names the missing
  // key far better than a guess here would, and failing at selection time would hide which model was asked
  // for. So fall through to the end of the chain and let the request say what is wrong.
  const provider = pinned ?? routed?.provider ?? 'openrouter'
  const cred = codexCredential()
  const usingCodex = provider === 'openai-codex'

  // THE AGENT'S INSTRUCTIONS. pi's DefaultResourceLoader reads AGENTS.md / CLAUDE.md / SYSTEM.md from cwd and
  // folds them into the system prompt, so the reference goes in the same way codex takes it — as a file the
  // harness loads itself, not as text prepended to the question.
  //
  // Without this, pi ran the composer with NO instructions at all: no canonicalisation, no route rules, no
  // built.json contract. It still answered, which is the dangerous part — a turn that looks like it worked.
  let refPlacement: 'in-context' | 'file' = 'file'
  // NOT for a pure-text agent. AGENTS.md lives in the cwd, and the narrator shares the composer's workspace —
  // writing there would overwrite the composer's instructions with narration rules. That exact collision, one
  // file claimed by two roles, is what once handed the analyst the composer's prompt for a whole question.
  // A no-tools agent has no workspace to describe anyway: its instructions ride on the prompt instead.
  if (opts.systemReference?.trim() && !opts.noTools) {
    try { writeFileSync(join(opts.cwd, 'AGENTS.md'), opts.systemReference); refPlacement = 'in-context' }
    catch (e) { console.warn('[ica:pi] could not write AGENTS.md; instructions will be missing', e) }
  }
  let session: any = null
  let buf = ''
  let running = false
  let activeHandler: RunHandlers | undefined
  let activeAnswer = ''
  const rawSubs = new Set<(chunk: string) => void>()
  // Every normalised event of the CURRENT turn, kept so a client that connects late — or reconnects — can be
  // shown what it missed instead of a blank panel. Every other harness keeps one; pi kept none, so a reload
  // mid-turn lost the whole step list.
  let eventLog: AgentEvent[] = []
  const liveCommands = new Map<string, string>()   // a step's command text, start → completion (see normPiEvent)
  const queue: { prompt: string; h?: RunHandlers; resolve: (r: RunResult) => void }[] = []

  async function ensure() {
    if (session) return session
    const rl = new DefaultResourceLoader({ cwd: opts.cwd, agentDir: getAgentDir() } as any)
    await rl.reload()

    // ── ROUTE THROUGH OUR PROXY, when there is one and it can carry this provider ──────────────────────────
    // SUPERATOM_PLATFORM makes model calls leave the box through one host we control: one domain to whitelist,
    // no provider key on the machine, and usage counted where it can be trusted.
    //
    // BUT NOT FOR EVERY PROVIDER. The ChatGPT backend refuses any relayed request, so it is served by the
    // CONNECT tunnel instead — and a tunnel works at the TRANSPORT layer, not this one. Rewriting the URL for
    // it points the request at a proxy that will (correctly) refuse to relay it, which is exactly what
    // happened: the composer got a 421 rather than a model, produced nothing, and escalated three seconds
    // later. So these providers keep their real URL and ica/proxy-dispatcher.ts tunnels the connection
    // underneath.
    const TUNNELLED = new Set(providersOn('tunnel'))
    const platform = process.env.SUPERATOM_PLATFORM
    const proxyBase = platform && process.env.ICA_PROJECT && !TUNNELLED.has(provider)
      ? `https://proxy.${platform}/p/${process.env.ICA_PROJECT}` : undefined

    // ── WHICH LIST TO PICK THE MODEL FROM ─────────────────────────────────────────────────────────────────
    // Two different questions, and asking the wrong one cost us every proxied box.
    //
    //   getAvailable  "which models can THIS MACHINE pay for" — the catalog filtered by a local login.
    //   getModels     "which models exist" — the catalog itself, no credential involved.
    //
    // A proxied box pays for nothing: the proxy holds the key and decides. So its machine-local answer is
    // legitimately EMPTY, and asking getAvailable there throws "authorise one with `pi` → /login" before the
    // proxy is ever consulted — a login demanded by the one design that exists so no login is needed. On a
    // fresh fleet machine that killed every question: pi selected no model, the narrator died, and the box
    // sat healthy and mute.
    //
    // The descriptor is free either way (id, api shape, baseUrl), so take it from the catalog when proxied
    // and keep the authorised list where it means something — a laptop, where a local login IS the payer.
    const runtime = await modelRuntime()
    const listed: any[] = proxyBase ? [...runtime.getModels(provider)] : [...await runtime.getAvailable(provider)]
    const model: any = listed.find((m) => m?.id === modelId) ?? listed[0]
    if (!model) {
      throw new Error(proxyBase
        ? `pi: provider "${provider}" has no models in the catalog — the model list could not be fetched`
        : `pi: no model available from "${provider}" — authorise one with \`pi\` → /login`)
    }
    if (model.id !== modelId) console.warn(`[ica:pi] ${modelId} not in ${provider}'s list; using ${model.id}`)

    if (proxyBase) {
      model.baseUrl = `${proxyBase}/${provider}`
      // The project's own API key travels as the provider credential, because that is the only slot an agent
      // will populate — the proxy recognises `sk-proj-…`, proves it, and substitutes the real key. This is an
      // identifier, not a provider secret: it grants this project the pooled credential and nothing else.
      //
      // TOLD TO THE RUNTIME, not only stamped on the model. Setting model.apiKey alone is not enough: the
      // request path asks the credential store, finds nothing, and refuses with "No API key found — use
      // /login" while holding a perfectly good key one field away. setRuntimeApiKey is an in-memory override
      // (a Map consulted ahead of the store), so nothing is written to disk and the box keeps nothing when it
      // stops — the same terms the vault credential runs on.
      if (process.env.ICA_KEY) {
        if (!model.apiKey) model.apiKey = process.env.ICA_KEY
        await runtime.setRuntimeApiKey(provider, process.env.ICA_KEY)
      }
      console.log(`[ica:pi] via proxy → ${model.baseUrl}`)
    } else if (platform && TUNNELLED.has(provider)) {
      console.log(`[ica:pi] ${provider} keeps its own URL — carried by the tunnel, not relayed`)
    }

    // TELL IT WHERE TO WORK. Without `cwd` the SDK defaults to process.cwd() — the ENGINE's directory, not the
    // agent's workspace — so every tool ran in the wrong place. The model worked around it by prefixing
    // `cd <absolute workspace> &&` onto every command, which costs tokens on each call, makes the step log
    // unreadable, and puts the machine's filesystem layout in the transcript. Every other harness is given its
    // directory and uses plain relative paths (`./get-concept "…"`); this one simply was not.
    // ON DISK, NOT IN MEMORY. inMemory() threw the conversation away when the process ended, so pi could
    // neither report a session nor resume one — every engine restart started the composer from nothing, while
    // claude and codex both carried on. A pure-text agent (the narrator) keeps no conversation worth resuming,
    // so it stays in memory.
    //
    // `resumeId` is the session FILE: pi identifies a session by its path, and open() reads it back.
    const sm = opts.noTools ? SessionManager.inMemory()
             : (opts.resumeId ? tryOpenSession(opts.resumeId, opts.cwd) : null) ?? SessionManager.create(opts.cwd)
    ;({ session } = await createAgentSession({
      cwd: opts.cwd, agentDir: getAgentDir(), modelRuntime: runtime,
      settingsManager: SettingsManager.create(opts.cwd, getAgentDir()),
      resourceLoader: rl, sessionManager: sm, model,
      // A pure-text agent gets NO tools. Until now `noTools` was not even passed to pi, so the narrator — which
      // is meant to write one sentence — ran with bash, read, edit and write available to it.
      ...(opts.noTools ? { noTools: 'all' as const } : {}),
    }))
    session.subscribe?.((ev: any) => {                                   // ONE subscription; routes to the active turn
      const norm = normPiEvent(ev, liveCommands)                          // the SHARED shape — see normPiEvent
      if (norm) {
        const at = eventLog.findIndex((e) => e.id && e.id === norm.id)     // a step UPDATES in place, start → completion
        if (at >= 0) eventLog[at] = norm; else eventLog.push(norm)
        if (eventLog.length > 400) eventLog = eventLog.slice(-400)
        activeHandler?.onEvent?.(norm)
      }
      const chunk = fmtEvent(ev)
      if (chunk) {
        buf = (buf + chunk).slice(-64000)
        activeHandler?.onOutput?.(chunk)
        for (const cb of rawSubs) { try { cb(chunk) } catch { /* one bad watcher cannot break the rest */ } }
      }
      if (ev.type === 'message_end' && ev.message?.role === 'assistant') {
        const t = (ev.message.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ').trim()
        if (t) activeAnswer = t                                          // last assistant message = the answer
      }
    })
    return session
  }

  async function pump() {
    if (running || !queue.length) return
    running = true
    const { prompt, h, resolve } = queue.shift()!
    const s = await ensure()
    // pi has no `system` slot, so an agent whose whole job is described by one it does carry it on the prompt.
    // Dropping it silently is how the narrator came to run with no instructions at all.
    const text = opts.system?.trim() ? `${opts.system.trim()}\n\n${prompt}` : prompt
    activeHandler = h; activeAnswer = ''
    const t0 = Date.now()
    try { await s.prompt(text); await s.waitForIdle?.() }
    catch (e: any) { activeAnswer = `pi error: ${e?.message ?? e}` }
    activeHandler = undefined
    running = false
    resolve({ lastLines: activeAnswer, ms: Date.now() - t0 })            // SDK-precise completion
    pump()
  }

  return {
    async run(prompt, h) { return new Promise<RunResult>((resolve) => { queue.push({ prompt, h, resolve }); pump() }) },
    async compact() { const r = await session?.compact?.(); return { lastLines: r ? '(context compacted)' : '(nothing to compact)', ms: 0 } },
    referencePlacement: refPlacement,          // via AGENTS.md, which pi's resource loader picks up from cwd

    // The session FILE is pi's identity — what to hand back as `resumeId` next time. claude and codex both
    // report theirs and the engine persists it; pi reported nothing, so its conversation died with the process.
    turnEnd: 'native' as const,   // the agent loop ends and we are told; doneWhen is never polled
    sessionId: () => session?.sessionFile ?? undefined,

    // Built BEFORE a question arrives, so the first one does not pay for it. The engine warms every agent it
    // can at boot; pi offered nothing to warm, so its first turn was always cold.
    async warmup() { await ensure() },

    // Throw the conversation away and start clean. This is the recovery when a session wedges — the failure
    // that once needed a whole container restarted because nothing could reset an agent in place.
    reset: () => { try { session?.dispose?.() } catch { /* already gone */ } session = null; buf = ''; eventLog = []; liveCommands.clear() },

    // Steering: text pushed into a turn that is already running, which is what pi calls it. Fire and forget —
    // the caller is a keystroke stream, and awaiting a round trip per character would make typing unusable.
    input: (data: string) => { void session?.steer?.(data)?.catch?.(() => {}) },

    // Watch the live stream without owning it. Returns its own unsubscribe.
    onRaw: (cb: (chunk: string) => void) => { rawSubs.add(cb); return () => rawSubs.delete(cb) },

    buffer: () => buf,
    events: () => eventLog,
    busy: () => running,
    stop: () => { try { session?.abort?.() } catch { /* not running */ } try { session?.dispose?.() } catch { /* already gone */ } session = null },
  }
}
