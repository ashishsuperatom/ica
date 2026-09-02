// ── pi session — a clean, reusable module (SAME interface as ica/claude.ts) ───
// Uses the pi coding-agent SDK with an OpenRouter model. No terminal emulation — the SDK
// streams events and tells us when a turn is idle, so completion is exact (no idle-timeout).
// Prompt-agnostic; knows nothing about the hub/protocol. One persistent session, queued turns.
//
//   OPENROUTER_API_KEY must be set. Model via opts.model / ICA_PI_MODEL (default deepseek-v4-flash).

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent'
import { registerBuiltInApiProviders, getModel } from '@earendil-works/pi-ai'
import type { Session, RunHandlers, RunResult, AgentEvent } from './session.js'   // the shared session interface

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

export function createPiSession(opts: PiSessionOpts): Session {
  // Prefer the ChatGPT subscription when it is there — one login for pi and codex both — and fall back to
  // OpenRouter otherwise. Explicit opts/env always win, so this is a default and never a surprise.
  const cred = codexCredential()
  const provider = opts.provider ?? process.env.ICA_PI_PROVIDER ?? (cred ? 'openai-codex-responses' : 'openrouter')
  const usingCodex = provider === 'openai-codex-responses'
  const modelId = opts.model ?? process.env.ICA_PI_MODEL ?? (usingCodex ? 'gpt-5.6-luna' : 'deepseek/deepseek-v4-flash')

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
  const liveCommands = new Map<string, string>()   // a step's command text, start → completion (see normPiEvent)
  const queue: { prompt: string; h?: RunHandlers; resolve: (r: RunResult) => void }[] = []

  async function ensure() {
    if (session) return session
    registerBuiltInApiProviders()
    const rl = new DefaultResourceLoader({ cwd: opts.cwd, agentDir: getAgentDir() } as any)
    await rl.reload()
    const model = getModel(provider as any, modelId)
    // TELL IT WHERE TO WORK. Without `cwd` the SDK defaults to process.cwd() — the ENGINE's directory, not the
    // agent's workspace — so every tool ran in the wrong place. The model worked around it by prefixing
    // `cd <absolute workspace> &&` onto every command, which costs tokens on each call, makes the step log
    // unreadable, and puts the machine's filesystem layout in the transcript. Every other harness is given its
    // directory and uses plain relative paths (`./get-concept "…"`); this one simply was not.
    ;({ session } = await createAgentSession({
      cwd: opts.cwd, resourceLoader: rl, sessionManager: SessionManager.inMemory(), model,
      // A pure-text agent gets NO tools. Until now `noTools` was not even passed to pi, so the narrator — which
      // is meant to write one sentence — ran with bash, read, edit and write available to it.
      ...(opts.noTools ? { noTools: 'all' as const } : {}),
    }))
    session.subscribe?.((ev: any) => {                                   // ONE subscription; routes to the active turn
      const norm = normPiEvent(ev, liveCommands)                          // the SHARED shape — see normPiEvent
      if (norm) activeHandler?.onEvent?.(norm)
      const chunk = fmtEvent(ev)
      if (chunk) { buf = (buf + chunk).slice(-64000); activeHandler?.onOutput?.(chunk) }
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
    async compact() { return { lastLines: '(pi manages its own context — no /compact needed)', ms: 0 } },
    referencePlacement: refPlacement,          // via AGENTS.md, which pi's resource loader picks up from cwd
    buffer: () => buf,
    busy: () => running,
    stop: () => { try { session?.close?.() } catch {} session = null },
  }
}
