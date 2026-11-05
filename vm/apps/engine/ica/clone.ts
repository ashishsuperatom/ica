// ── A CLONE OF A CONVERSATION, for one turn of background work (docs/intent-graph.md, "Closing an intent") ─────────
//
// When an intent closes, what was learnt is worked out by a clone of the conversation that answered it: it has the
// whole context, the person is never kept waiting by it, and its work never enters the conversation itself. The clone
// takes one turn and is deleted.
//
//   claude-code  the transcript forked into a new session (`claude -p --resume <id> --fork-session --session-id <new>`),
//                run headless in print mode — never the live terminal — then the fork's transcript deleted
//   pi           the session file copied, the copy opened and run, then deleted
//   opencode     the session forked by the server (session.fork), run, then deleted
//   otherwise    (codex; a conversation with no saved session yet) a fresh agent in the same folder, given the
//                conversation's turns as text — said so in what it returns (`how: 'fresh'`)

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createSession, type Harness } from './index.js'
import { claudeChildEnv } from './claude.js'
import { transcriptPath } from './claude-events.js'
import { modelFor } from './models.js'

export interface CloneOf {
  harness: Harness
  /** The conversation's saved session (Session.sessionId()): claude's id, pi's file, opencode's id, codex's thread. */
  ref?: string
  cwd: string
  model?: string
  provider?: string
  thinking?: any
}

export interface CloneTurn {
  /** The clone's last words. */
  text: string
  how: 'forked' | 'fresh'
  ms: number
}

/** A clone of the conversation, for a few turns of background work: each turn sees the ones before; closed, it is gone.
 *  `transcript`: the conversation as text, for a harness that cannot fork (or a conversation not yet saved). */
export interface Clone { turn(prompt: string, o?: { doneWhen?: () => boolean; timeoutMs?: number }): Promise<CloneTurn>; close(): void }
export async function openClone(of: CloneOf, transcript: string): Promise<Clone> {
  const h = String(of.harness)
  if (of.ref && h.startsWith('claude-code')) {
    // The first turn forks the transcript into a session of its own; the next ones resume that fork; closing deletes it.
    const id = randomUUID(); let forked = false
    const model = await modelFor(of.provider, of.model ?? 'claude-sonnet-5')
    return {
      async turn(prompt, o = {}) {
        const t0 = Date.now()
        const args = forked ? ['-p', prompt, '--resume', id] : ['-p', prompt, '--resume', of.ref!, '--fork-session', '--session-id', id]
        const text = await new Promise<string>((resolve, reject) => execFile(process.env.CLAUDE_BIN ?? 'claude', [...args, '--model', model, '--dangerously-skip-permissions'],
          { cwd: of.cwd, env: claudeChildEnv(of.provider), timeout: o.timeoutMs ?? 15 * 60_000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => (err && !(o.doneWhen?.()) ? reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' '))) : resolve(String(stdout).trim()))))
        forked = true
        return { text, how: 'forked', ms: Date.now() - t0 }
      },
      close() { rmSync(transcriptPath(homedir(), of.cwd, id), { force: true }) },
    }
  }
  let copy: string | null = null, resumeId: string | undefined, how: CloneTurn['how'] = 'fresh'
  if (of.ref && h === 'pi' && existsSync(of.ref)) { copy = join(dirname(of.ref), `clone-${randomUUID()}.jsonl`); copyFileSync(of.ref, copy); resumeId = copy; how = 'forked' }
  else if (of.ref && h === 'opencode') { const f = await opencodeFork(of).catch(() => null); if (f) { resumeId = f; how = 'forked' } }
  // stop() on an opencode session given its id deletes it on the server: the fork goes with it.
  const s = createSession(of.harness, { cwd: of.cwd, model: of.model, provider: of.provider, thinking: of.thinking, ...(resumeId ? { resumeId } : {}) })
  let first = true
  return {
    async turn(prompt, o = {}) {
      const t0 = Date.now()
      const words = how === 'fresh' && first ? `The conversation so far, as it was said:\n${transcript}\n\n${prompt}` : prompt
      first = false
      return { text: await runCapped(s, words, o.doneWhen, o.timeoutMs ?? 15 * 60_000), how, ms: Date.now() - t0 }
    },
    close() { try { s.stop() } catch { /* gone */ } if (copy) rmSync(copy, { force: true }) },
  }
}

/** One turn in a clone of the conversation; the clone deleted after. */
export async function cloneTurn(of: CloneOf, prompt: string, o: { transcript: string; doneWhen?: () => boolean; timeoutMs?: number }): Promise<CloneTurn> {
  const c = await openClone(of, o.transcript)
  try { return await c.turn(prompt, o) } finally { c.close() }
}

async function runCapped(s: ReturnType<typeof createSession>, prompt: string, doneWhen: (() => boolean) | undefined, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const r = await Promise.race([s.run(prompt, doneWhen ? { doneWhen } : undefined), new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`the clone took longer than ${Math.round(ms / 60_000)} min`)), ms) })])
    return String(r.lastLines ?? '').trim()
  } finally { clearTimeout(timer) }
}

/** A session forked on the opencode server the conversation runs on; its new id. */
async function opencodeFork(of: CloneOf): Promise<string | null> {
  const base = process.env.ICA_OC_URL
  if (!base) return null
  const r = await fetch(`${base.replace(/\/$/, '')}/session/${encodeURIComponent(of.ref!)}/fork?directory=${encodeURIComponent(of.cwd)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  if (!r.ok) return null
  const j: any = await r.json().catch(() => null)
  return typeof j?.id === 'string' ? j.id : null
}
