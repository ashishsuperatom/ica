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

import type { Session, RunHandlers, RunResult } from './session.js'
import { createClaudeSession } from './claude.js'
import { createPiSession } from './pi.js'
import { createOpencodeSession } from './opencode.js'
import { createCodexSession } from './codex.js'

export type { Session, RunHandlers, RunResult } from './session.js'
export { prepareWorkspace } from './workspace.js'
export { opencodeAuthStatus, login as opencodeLogin, ensureOpencodeServer } from './opencode.js'
export { codexAuthStatus, login as codexLogin } from './codex.js'

export type Harness = 'opencode' | 'pi' | 'claude-code' | 'codex' | 'mock'

export interface SessionOpts {
  cwd: string           // working directory the agent operates in — REQUIRED (see workspace.ts)
  model?: string        // bare model id; per-harness default if omitted
  provider?: string     // for pi/opencode (e.g. 'openrouter' | 'opencode-go')
  baseUrl?: string      // opencode only: connect to a standalone `opencode serve` instead of spawning
  bin?: string          // claude-code only: the claude binary
  resumeId?: string     // resume a prior harness session (per project/agent) — harness-specific
}

// The DEFAULT harness — override with ICA_HARNESS.
export const DEFAULT_HARNESS: Harness = (process.env.ICA_HARNESS as Harness) || 'opencode'

export function createSession(harness: Harness, opts: SessionOpts): Session {
  switch (harness) {
    case 'opencode':    return createOpencodeSession({ cwd: opts.cwd, provider: opts.provider, model: opts.model, baseUrl: opts.baseUrl })
    case 'pi':          return createPiSession({ cwd: opts.cwd, provider: opts.provider, model: opts.model })
    case 'claude-code': return createClaudeSession({ cwd: opts.cwd, model: opts.model, bin: opts.bin, resumeId: opts.resumeId })
    case 'codex':       return createCodexSession({ cwd: opts.cwd, model: opts.model, resumeId: opts.resumeId })
    case 'mock':        return createMockSession(opts)
    default:            throw new Error(`unknown harness: ${harness}`)
  }
}

// Minimal mock — echoes a canned answer through the same interface, so smoke tests need no agent.
function createMockSession(opts: SessionOpts): Session {
  let buf = ''
  return {
    async run(prompt: string, h?: RunHandlers): Promise<RunResult> {
      const answer = `mock answer for: "${prompt.slice(0, 60)}" (cwd ${opts.cwd})`
      buf = answer
      h?.onOutput?.(answer)
      h?.onEvent?.({ type: 'mock.done', text: answer })
      return { lastLines: answer, ms: 0 }
    },
    async compact() { return { lastLines: '(mock)', ms: 0 } },
    buffer: () => buf,
    busy: () => false,
    stop: () => {},
  }
}
