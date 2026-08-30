// ── codex session — a clean, reusable module (SAME interface as the others) ───
// Drives OpenAI Codex via @openai/codex-sdk on the logged-in ChatGPT subscription. No terminal
// emulation and no idle-timeout: runStreamed() streams ThreadEvents and the generator ENDS when
// the turn completes, so completion is exact. onEvent exposes every raw ThreadEvent (reasoning,
// command execution, file changes, agent message) so the caller selects what to forward.
// Prompt-agnostic; one persistent Thread (consecutive turns = same conversation), queued.
//
//   Subscription auth (no apiKey). Default model gpt-5.6-terra, reasoning effort medium.
//   ALL PERMISSIONS enabled: sandbox danger-full-access + approvals never (see ensure()).

import { Codex, type Thread } from '@openai/codex-sdk'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session, RunHandlers, RunResult, AgentEvent } from './session.js'

export interface CodexSessionOpts {
  cwd: string
  model?: string                                                     // default 'gpt-5.6-terra'
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'  // default 'medium'
  resumeId?: string                                                  // resume a prior thread (persisted in ~/.codex/sessions)
  systemReference?: string    // authoritative authoring reference → written to AGENTS.md (codex auto-loads it from cwd)
}

// Turn one ThreadEvent into a readable stream chunk. `seen` tracks per-item emitted length so the
// agent's answer streams incrementally; command executions emit a one-line "→ <command>" once.
function fmtEvent(ev: any, seen: Map<string, number>): string {
  if (ev?.type !== 'item.started' && ev?.type !== 'item.updated' && ev?.type !== 'item.completed') return ''
  const item = ev.item
  if (!item) return ''
  if (item.type === 'agent_message' && typeof item.text === 'string') {
    const prev = seen.get(item.id) || 0
    if (item.text.length <= prev) return ''
    seen.set(item.id, item.text.length)
    return item.text.slice(prev)                                     // only the new suffix
  }
  if (item.type === 'command_execution' && item.command) {
    const key = `cmd:${item.id}`
    if (!seen.has(key)) { seen.set(key, 1); return `→ ${String(item.command).replace(/\s+/g, ' ')}`.slice(0, 160) + '\r\n' }
  }
  return ''
}

// Structured sibling of fmtEvent: turn a ThreadEvent into a normalized AgentEvent for the UI event log
// (null = an event we don't render). Each item keeps its stable id across started→updated→completed, so the
// UI updates the same block in place as the command output or message text streams in.
//
// FORMAT CONTRACT — @openai/codex-sdk ^0.144 (this is what we're coding against; harness formats DRIFT, so if
// the event view goes blank/garbled after an SDK bump, check here first). Events we map:
//   turn.started                                    → { kind:'turn' }
//   item.{started,updated,completed} · item.type of:
//     agent_message      { id, text }               → message
//     reasoning          { id, text }               → reasoning
//     command_execution  { id, command, aggregated_output, status } → command
//     file_change        { id, path|text }          → file
// New item.types Codex adds later fall through to null (rendered as nothing) until mapped here.
function normEvent(ev: any): AgentEvent | null {
  if (ev?.type === 'turn.started') return { kind: 'turn' }
  if (ev?.type !== 'item.started' && ev?.type !== 'item.updated' && ev?.type !== 'item.completed') return null
  const it = ev.item; if (!it) return null
  const done = ev.type === 'item.completed'
  switch (it.type) {
    case 'agent_message':     return { kind: 'message',   id: it.id, text: it.text ?? '', done }
    case 'reasoning':         return { kind: 'reasoning', id: it.id, text: it.text ?? '', done }
    case 'command_execution': return { kind: 'command',   id: it.id, command: it.command ?? '', output: it.aggregated_output ?? '', status: it.status, done }
    case 'file_change':       return { kind: 'file',      id: it.id, text: it.path ?? it.text ?? '', done }
    default:                  return null
  }
}

export function createCodexSession(opts: CodexSessionOpts): Session {
  const model = opts.model ?? process.env.ICA_CODEX_MODEL ?? 'gpt-5.6-terra'
  const effort = (opts.reasoningEffort ?? process.env.ICA_CODEX_EFFORT ?? 'medium') as CodexSessionOpts['reasoningEffort']
  // Authoritative authoring reference → AGENTS.md, which codex auto-loads from the working directory (its
  // equivalent of CLAUDE.md). So the reference is always in-context with no read-instruction. Written once here.
  let refPlacement: 'in-context' | 'file' = 'file'
  if (opts.systemReference?.trim()) {
    try { writeFileSync(join(opts.cwd, 'AGENTS.md'), opts.systemReference); refPlacement = 'in-context' }
    catch (e) { console.warn('[ica:codex] could not write AGENTS.md; falling back to file-read', e) }
  }
  let codex: Codex | null = null
  let thread: Thread | null = null
  let resumeId = opts.resumeId                                      // mutable: cleared if the resume can't be found
  let threadId: string | null = opts.resumeId ?? null              // current thread id — persist this to resume across restarts
  let resumeFailed = false
  let buf = ''
  const eventLog: AgentEvent[] = []                                // structured events (the 'events' view's buffer), capped
  let running = false
  const queue: { prompt: string; h?: RunHandlers; resolve: (r: RunResult) => void }[] = []

  const threadOpts = () => ({
    model,
    modelReasoningEffort: effort,
    workingDirectory: opts.cwd,
    sandboxMode: 'danger-full-access' as const,                    // ALL PERMISSIONS: full fs + no sandbox
    approvalPolicy: 'never' as const,                              //                  never pause to ask
    networkAccessEnabled: true,
    skipGitRepoCheck: true,                                        // don't refuse outside a git repo
  })
  function ensure() {
    if (thread) return
    codex = new Codex()                                             // logged-in ChatGPT subscription (no apiKey)
    // RESUME the prior thread when we have its id (threads persist in ~/.codex/sessions), else start fresh.
    thread = resumeId ? codex.resumeThread(resumeId, threadOpts()) : codex.startThread(threadOpts())
  }

  async function pump() {
    if (running || !queue.length) return
    running = true
    const { prompt, h, resolve } = queue.shift()!
    ensure()
    const seen = new Map<string, number>()
    let answer = ''
    const t0 = Date.now()
    try {
      const streamed = await thread!.runStreamed(prompt)
      for await (const ev of streamed.events) {                     // generator ends when the turn completes → exact
        if (ev.type === 'thread.started' && (ev as any).thread_id) threadId = (ev as any).thread_id
        const norm = normEvent(ev)                                 // structured event for the UI event log
        if (norm) { eventLog.push(norm); if (eventLog.length > 600) eventLog.shift(); h?.onEvent?.(norm) }
        const chunk = fmtEvent(ev, seen)
        if (chunk) { buf = (buf + chunk).slice(-64000); h?.onOutput?.(chunk) }
        if ((ev.type === 'item.completed' || ev.type === 'item.updated') && ev.item?.type === 'agent_message') {
          answer = ev.item.text                                     // last assistant message = the answer
        }
      }
      try { if (thread!.id) threadId = thread!.id } catch {}        // authoritative id once the turn started
    } catch (e: any) {
      // A resume can fail if the persisted thread is gone (rotated/cleared) or we switched harness. Start a
      // FRESH thread ONCE and retry this same prompt — nothing important is lost (the model/programs are on disk).
      if (resumeId && !resumeFailed) {
        resumeFailed = true; resumeId = undefined; thread = null; codex = null; threadId = null
        queue.unshift({ prompt, h, resolve }); running = false
        return pump()
      }
      answer = `codex error: ${e?.message ?? e}`
    }
    running = false
    resolve({ lastLines: answer, ms: Date.now() - t0 })
    pump()
  }

  return {
    kind: 'events',                                                  // discrete agent events → UI renders an event log, not a terminal
    referencePlacement: refPlacement,                                // via AGENTS.md (auto-loaded) when a systemReference was given
    async run(prompt, h) { return new Promise<RunResult>((resolve) => { queue.push({ prompt, h, resolve }); pump() }) },
    async compact() { return { lastLines: '(codex manages its own context)', ms: 0 } },
    buffer: () => buf,
    events: () => eventLog,
    busy: () => running,
    stop: () => { thread = null; codex = null },
    sessionId: () => threadId ?? undefined,   // the codex thread id — persisted so we resume it after a restart
  }
}

// ── login scaffold ───────────────────────────────────────────────────────────
// Real interactive login (`codex login` — ChatGPT OAuth) comes later; for now this only reports
// whether codex has stored credentials, so the caller can pick the harness.
export async function codexAuthStatus(): Promise<{ loggedIn: boolean; mode?: string }> {
  try {
    const { readFileSync } = await import('node:fs')
    const { homedir } = await import('node:os')
    const auth = JSON.parse(readFileSync(`${homedir()}/.codex/auth.json`, 'utf8'))
    return { loggedIn: !!(auth.tokens || auth.OPENAI_API_KEY), mode: auth.auth_mode }
  } catch { return { loggedIn: false } }
}

// TODO(login): drive `codex login` (ChatGPT OAuth) — scaffold only.
export async function login(): Promise<never> {
  throw new Error('login() not implemented yet — run `codex login` in a terminal for now')
}
