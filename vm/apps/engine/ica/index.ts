// ── ICA factory ──────────────────────────────────────────────────────────────
// createSession(harness, opts) → a uniform `Session` over any harness. Harness and model
// are always separate; the engine talks to `Session`, never to a specific agent CLI/SDK.
//
//   opencode    — headless server + SDK. DEFAULT. Model glm-5.2 on the opencode-go sub.
//                 Set opts.baseUrl / ICA_OC_URL to share ONE standalone server (no per-engine spawn).
//   pi          — pi SDK on an OpenRouter model. Lightest (in-process, no spawned binary).
//   claude-code — Claude Code in a PTY (idle-completion).
//   codex       — OpenAI Codex SDK on the ChatGPT subscription. Model gpt-5.6-terra, effort medium.
//   mock        — canned answer; no external agent (for smoke tests).

import type { Session, RunHandlers, RunResult, TokenUsage } from './session.js'
import { randomBytes } from 'node:crypto'
import { createClaudeSession } from './claude.js'
import { createPiSession } from './pi.js'
import { createOpencodeSession } from './opencode.js'
import { createCodexSession } from './codex.js'

export type { Session, RunHandlers, RunResult, TokenUsage } from './session.js'
export { prepareWorkspace } from './workspace.js'
export { opencodeAuthStatus, login as opencodeLogin, ensureOpencodeServer } from './opencode.js'
export { codexAuthStatus, login as codexLogin } from './codex.js'

// NAMED FOR HOW IT IS DRIVEN, not for the vendor. 'claude-code-pty' runs the CLI through a pseudo-terminal
// and scrapes it; a JSON/SDK driver for the same product is a DIFFERENT harness with different cost and
// failure modes, and would sit here beside it. The old name 'claude-code' also collided with the PROVIDER of
// the same name in the agent contract, so a config line could not say which of the two it meant.
export type Harness = 'opencode' | 'pi' | 'claude-code-pty' | 'codex' | 'mock'

export interface SessionOpts {
  cwd: string           // working directory the agent operates in — REQUIRED (see workspace.ts)
  model?: string        // bare model id; per-harness default if omitted
  provider?: string     // whose account pays: pi/opencode any relayed provider; claude-code and codex their own login, or 'openrouter'
  baseUrl?: string      // opencode only: connect to a standalone `opencode serve` instead of spawning
  bin?: string          // claude-code only: the claude binary
  resumeId?: string     // resume a prior harness session (per project/agent) — harness-specific
  noTools?: boolean     // opencode: disable ALL tools — a pure text completion, no coding-agent tool schemas
  system?: string       // opencode: REPLACE the harness's default coding system prompt with this one (well-cached; keeps the per-turn prompt small). For pure-text agents (the narrator) that don't need the agent scaffolding.
  // The AUTHORITATIVE reference (the agent's role + how programs are written, agents/shared-prompts) to install
  // into the system prompt of a CODING agent (composer/analyst), so it never reads engine source or other
  // programs to learn the shape. Harness-agnostic: each harness delivers it its own way and reports how via
  // Session.referencePlacement; if a harness can't, it degrades to 'file' and the caller writes it to the workspace.
  systemReference?: string
  // How much the model reasons before it answers. Each harness takes it its own way, clamped to what it and the model
  // offer; unset, the harness's own default.
  thinking?: Thinking
}

export type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const THINKING: Thinking[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']


// ── USAGE PER PERSON ─────────────────────────────────────────────────────────────────────────────────────
// Every harness reports the tokens of each model call it makes (pi and opencode per call, Claude Code in its
// transcript, codex in its session log); that report, as given, is the usage — for every harness and every account,
// one path. The turn says who it is for (RunHandlers.forSession / forPerson), so each report is stamped with the
// session and person. The session's tag (also in the address of its proxy calls) names which agent it was.
export interface UsageSink {
  report(u: { tag: string; session: string | null; person?: string; provider: string; model?: string; in: number; out: number; cacheRead?: number; cacheWrite?: number }): void
}
let usageSink: UsageSink | null = null
/** Set once by the engine: where turns and usage are told to the platform. */
export function setUsageSink(sink: UsageSink | null) { usageSink = sink }

export function createSession(harness: Harness, opts: SessionOpts): Session {
  const tag = `${harness === 'claude-code-pty' ? 'cc' : harness}-${randomBytes(6).toString('hex')}`
  let forSession: string | null = null, forPerson: string | undefined
  const provider = opts.provider ?? ''
  const onUsage = (u: TokenUsage) => {
    if (!usageSink || !provider) return
    usageSink.report({ tag, session: forSession, person: forPerson, provider, model: u.model ?? opts.model, in: u.input ?? 0, out: u.output ?? 0, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite })
  }
  const inner = make(harness, opts, tag, onUsage)
  const run = inner.run.bind(inner)
  inner.run = async (prompt, h) => {
    forSession = h?.forSession ?? null; forPerson = h?.forPerson
    try { return await run(prompt, h) }
    finally { forSession = null; forPerson = undefined }
  }
  return inner
}

function make(harness: Harness, opts: SessionOpts, tag: string, onUsage: (u: TokenUsage) => void): Session {
  switch (harness) {
    case 'opencode':    return createOpencodeSession({ cwd: opts.cwd, provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl, noTools: opts.noTools, system: opts.system, systemReference: opts.systemReference, resumeId: opts.resumeId, thinking: opts.thinking, onUsage })
    case 'pi':          return createPiSession({ cwd: opts.cwd, provider: opts.provider, model: opts.model, systemReference: opts.systemReference, noTools: opts.noTools, system: opts.system, resumeId: opts.resumeId, thinking: opts.thinking, tag, onUsage })
    case 'claude-code-pty': return createClaudeSession({ cwd: opts.cwd, provider: opts.provider, model: opts.model, bin: opts.bin, resumeId: opts.resumeId, systemReference: opts.systemReference, thinking: opts.thinking, tag, onUsage })
    case 'codex':       return createCodexSession({ cwd: opts.cwd, provider: opts.provider, model: opts.model, resumeId: opts.resumeId, systemReference: opts.systemReference, tag, onUsage, ...(opts.thinking ? { reasoningEffort: ({ off: 'minimal', max: 'xhigh' } as const)[opts.thinking as 'off' | 'max'] ?? opts.thinking as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' } : {}) })
    case 'mock':        return createMockSession(opts)
    default:            throw new Error(`unknown harness: ${harness}`)
  }
}

// Minimal mock — echoes a canned answer through the same interface, so smoke tests need no agent.
function createMockSession(opts: SessionOpts): Session {
  let buf = ''
  return {
    turnEnd: 'native' as const,   // it answers and returns; there is nothing to infer
    async run(prompt: string, h?: RunHandlers): Promise<RunResult> {
      const answer = `mock answer for: "${prompt.slice(0, 60)}" (cwd ${opts.cwd})`
      buf = answer
      h?.onOutput?.(answer)
      h?.onEvent?.({ kind: 'message', text: answer, done: true })
      return { lastLines: answer, ms: 0 }
    },
    async compact() { return { lastLines: '(mock)', ms: 0 } },
    buffer: () => buf,
    busy: () => false,
    stop: () => {},
  }
}
