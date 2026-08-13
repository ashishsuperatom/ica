// ── pi session — a clean, reusable module (SAME interface as ica/claude.ts) ───
// Uses the pi coding-agent SDK with an OpenRouter model. No terminal emulation — the SDK
// streams events and tells us when a turn is idle, so completion is exact (no idle-timeout).
// Prompt-agnostic; knows nothing about the hub/protocol. One persistent session, queued turns.
//
//   OPENROUTER_API_KEY must be set. Model via opts.model / ICA_PI_MODEL (default deepseek-v4-flash).

import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager } from '@earendil-works/pi-coding-agent'
import { registerBuiltInApiProviders, getModel } from '@earendil-works/pi-ai'
import type { Session, RunHandlers, RunResult } from './session.js'   // the shared session interface

export interface PiSessionOpts {
  cwd: string
  provider?: string   // default 'openrouter'
  model?: string      // default 'deepseek/deepseek-v4-flash'
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

export function createPiSession(opts: PiSessionOpts): Session {
  const provider = opts.provider ?? 'openrouter'
  const modelId = opts.model ?? process.env.ICA_PI_MODEL ?? 'deepseek/deepseek-v4-flash'
  let session: any = null
  let buf = ''
  let running = false
  let activeHandler: RunHandlers | undefined
  let activeAnswer = ''
  const queue: { prompt: string; h?: RunHandlers; resolve: (r: RunResult) => void }[] = []

  async function ensure() {
    if (session) return session
    registerBuiltInApiProviders()
    const rl = new DefaultResourceLoader({ cwd: opts.cwd, agentDir: getAgentDir() } as any)
    await rl.reload()
    const model = getModel(provider as any, modelId)
    ;({ session } = await createAgentSession({ resourceLoader: rl, sessionManager: SessionManager.inMemory(), model }))
    session.subscribe?.((ev: any) => {                                   // ONE subscription; routes to the active turn
      activeHandler?.onEvent?.(ev)                                       // FULL raw event — caller selects what to forward
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
    activeHandler = h; activeAnswer = ''
    const t0 = Date.now()
    try { await s.prompt(prompt); await s.waitForIdle?.() }
    catch (e: any) { activeAnswer = `pi error: ${e?.message ?? e}` }
    activeHandler = undefined
    running = false
    resolve({ lastLines: activeAnswer, ms: Date.now() - t0 })            // SDK-precise completion
    pump()
  }

  return {
    async run(prompt, h) { return new Promise<RunResult>((resolve) => { queue.push({ prompt, h, resolve }); pump() }) },
    async compact() { return { lastLines: '(pi manages its own context — no /compact needed)', ms: 0 } },
    buffer: () => buf,
    busy: () => running,
    stop: () => { try { session?.close?.() } catch {} session = null },
  }
}
