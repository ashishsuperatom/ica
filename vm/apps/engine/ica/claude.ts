// ── Claude Code session — a clean, reusable module ───────────────────────────
// Drives ONE persistent `claude` process in a PTY. PROMPT-AGNOSTIC: you pass any prompt,
// it submits it and streams the raw terminal output, detecting completion by IDLE — while
// Claude works the TUI never stops emitting, so no output for `idleMs` = the turn finished.
// Prompts are queued (one turn at a time). This module knows NOTHING about analysis, the
// hub, or any message protocol — that all lives in the caller.

import type { Session, RunHandlers, RunResult } from './session.js'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'

export interface ClaudeSessionOpts {
  cwd: string                 // working directory the agent runs in
  model?: string              // default 'claude-sonnet-5'
  bin?: string                // default $CLAUDE_BIN || 'claude'
  idleMs?: number             // silence that means "done" (default 6000; measured max working gap ≈ 3.7s)
  firstGraceMs?: number       // long grace for the FIRST output after submit (default 60000)
  bufferCap?: number          // rolling output buffer size (default 64000)
  resumeId?: string           // resume this claude session id (--resume); else a fresh id we own (--session-id)
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|[\r\b]/g, '')
const lastLines = (buf: string, n = 8) => { const ls = stripAnsi(buf).split('\n').map(l => l.trim()).filter(Boolean); return ls.slice(-n).join('\n') }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createClaudeSession(opts: ClaudeSessionOpts): Session {
  const model = opts.model ?? 'claude-sonnet-5'
  const bin = opts.bin ?? process.env.CLAUDE_BIN ?? 'claude'
  // Capture the claude-code version once — the interactive prompts we auto-answer (bypass dialog, session-age
  // resume menu) are claude-code TUI copy that Anthropic can reword between versions. We log the version next
  // to every auto-answer and WARN when expected wording is missing, so a drift is visible against a version.
  let claudeVersion = ''
  execFile(bin, ['--version'], (err, stdout) => { if (!err && stdout) claudeVersion = stdout.trim().split('\n')[0] })
  // WE own the session id: a fresh UUID on first run (pinned via --session-id), then --resume it after a
  // restart. So `sessionId()` is stable and storable per (project, agent). Claude persists the transcript
  // on disk (keyed by cwd), so resuming reloads the whole conversation.
  let sid = opts.resumeId ?? randomUUID()
  let resuming = !!opts.resumeId
  const sessionArgs = () => (resuming ? ['--resume', sid] : ['--session-id', sid])
  const IDLE = opts.idleMs ?? 8000            // silence AFTER submit that means "done" (measured max working gap ≈ 3.7s)
  const FIRST = opts.firstGraceMs ?? 60000    // grace for the agent's FIRST output after we submit
  const HARD_SILENCE = 300000                 // absolute silence cap: even without the ❯ marker, give up after 5m
  const READY_QUIET = 500                     // …and the TUI has been quiet this long (render settled)
  const READY_MAX = 25000                     // don't wait longer than this for startup
  const CAP = opts.bufferCap ?? 64000
  // The input box is READY when its prompt marker is on screen. Anchored to claude's TUI (see
  // ica/CLAUDE_TIMING.md); if a version changes this, re-measure with ica/cc-diag.mjs and update.
  const READY_MARKER = /❯|for shortcuts|bypass permissions/
  const WORKING_MARKER = /esc to interrupt|Cogitat|Creating|Thinking|✳|✽|⏺/   // agent accepted the prompt & is running

  let pty: any = null
  let buf = ''
  let idle: ReturnType<typeof setTimeout> | null = null
  let donePoll: ReturnType<typeof setInterval> | null = null   // fast completion: poll the caller's doneWhen()
  let lastNarr = '', lastNarrAt = 0                            // last clean narration line emitted (dedup + throttle)
  let lastDataAt = 0                          // timestamp of the last PTY byte — drives readiness (settle) detection
  let cols = 120, rows = 34                   // PTY size — the UI resizes this to fill its terminal width (SIGWINCH)
  interface Job { prompt: string; h?: RunHandlers; resolve: (r: RunResult) => void; startedAt: number; submitted: boolean }
  const queue: Job[] = []
  let current: Job | null = null
  let trustAccepted = false    // answered the one-time "trust this folder" safety dialog (new workspace dir)
  let bypassAccepted = false   // sent the "Yes, I accept" keystroke for the one-time Bypass-Permissions dialog
  let resumeChoiceSent = false // answered the "session is old" resume menu (once per spawn)
  const rawListeners = new Set<(d: string) => void>()   // interactive terminal viewers (raw PTY passthrough, e.g. /login from the UI)

  async function ensure() {
    if (pty) return
    const m = await import('node-pty')
    pty = m.spawn(bin, ['--model', model, '--dangerously-skip-permissions', ...sessionArgs()],
      { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: { ...process.env, TERM: 'xterm-256color' } as any })
    lastDataAt = Date.now()
    pty.onData((d: string) => {
      buf = (buf + d).slice(-CAP)
      lastDataAt = Date.now()
      // Raw terminal passthrough: stream EVERY byte to any interactive viewer (the UI xterm), so a user can
      // watch the live TUI and drive it (e.g. run /login) even when no run is active. Independent of the queue.
      if (rawListeners.size) for (const fn of rawListeners) { try { fn(d) } catch { /* one bad viewer can't break the PTY */ } }
      // First-run "trust this folder" safety dialog (shown the first time a workspace dir is opened, even with
      // --dangerously-skip-permissions). Blocks a headless run. Auto-accept ONCE: option "1. Yes, I trust this
      // folder" is the default (cursor already on it) → just Enter. claude records the trust on the volume, so
      // it never asks again for this dir. Fires for every claude agent on its first spawn in a new workspace.
      if (!trustAccepted && /trust this folder|Is this a project you (created|trust)/i.test(stripAnsi(buf.slice(-3000)))) {
        trustAccepted = true
        setTimeout(() => { try { pty?.write('\r') } catch {} }, 250)
      }
      // First-run "Bypass Permissions mode" acceptance dialog (from --dangerously-skip-permissions) blocks a
      // headless run — the harness can't type past a menu. Auto-accept it ONCE: move to "2. Yes, I accept"
      // (down-arrow) + Enter. claude then remembers it (config on the volume), so it's one-time per machine.
      if (!bypassAccepted && /Yes, I accept|accept all responsibility/i.test(stripAnsi(buf.slice(-3000)))) {
        bypassAccepted = true
        setTimeout(() => { try { pty?.write('\x1b[B\r') } catch {} }, 250)
      }
      // Session-age resume menu (a newer claude-code prompt on an old/large session): it BLOCKS a headless run,
      // waiting for a keypress. Auto-answer it and keep the FULL context — pick "Resume full session as-is"
      // (the option below the default "Resume from summary"): down-arrow + Enter. Anchored on the stable
      // "Resume from summary" line; if the "full session" wording drifts we accept the default to unblock and
      // WARN with the version so we can re-calibrate. Fires for EVERY claude agent (analyst/modeler/connector).
      if (!resumeChoiceSent && /Resume from summary/i.test(stripAnsi(buf.slice(-3000)))) {
        resumeChoiceSent = true
        if (/Resume full session/i.test(stripAnsi(buf.slice(-3000)))) {
          console.warn(`[ica:claude] session-age resume menu → "Resume full session as-is" (claude ${claudeVersion || '?'})`)
          setTimeout(() => { try { pty?.write('\x1b[B\r') } catch {} }, 250)
        } else {
          console.warn(`[ica:claude] resume menu wording CHANGED (claude ${claudeVersion || '?'}) — accepting default to unblock: ${stripAnsi(buf.slice(-260)).replace(/\s+/g, ' ')}`)
          setTimeout(() => { try { pty?.write('\r') } catch {} }, 250)
        }
      }
      // Stale --resume: claude can't find the session (its store wasn't durable / the id is old). ALWAYS-ON
      // here (a bounded window or the bypass warning could defeat a timed check) → re-spawn FRESH once with a
      // new id + no --resume, and LOG the missing id so we can see WHY it wasn't found. Nothing is lost — the
      // model + answers live in the DB; we just skip warm continuity this once.
      if (resuming) {
        const miss = stripAnsi(buf.slice(-2000)).match(/No conversation found with session ID: ([\w-]+)/i)
        if (miss) {
          console.warn(`[ica:claude] --resume ${miss[1]} failed (session not found — store not persisted?); starting a FRESH session`)
          resuming = false; const dead = pty; pty = null; buf = ''; sid = randomUUID()
          try { dead?.kill() } catch {}
          void ensure()   // re-spawn fresh; waitForReady keeps polling the new session's buffer
          return
        }
      }
      current?.h?.onOutput?.(d)
      // Clean progress: pull the agent's latest NARRATION line (bulleted prose), never tool calls.
      if (current?.h?.onNarration && Date.now() - lastNarrAt > 350) { lastNarrAt = Date.now(); emitNarration() }
      // Completion tracking runs ONLY after we've submitted — before that, output is the TUI
      // starting up / echoing the typed prompt, which must NOT trip the "done" timer.
      if (current?.submitted) { if (idle) clearTimeout(idle); idle = setTimeout(maybeFinish, IDLE) }
    })
    pty.onExit(() => { pty = null })
    // (Stale-resume recovery is handled ALWAYS-ON in onData above — re-spawn FRESH on "No conversation found".)
  }

  // Resolve once the input box is actually rendered (READY_MARKER on screen) AND the TUI has gone
  // quiet — NOT just quiet, because startup has quiet lulls before the box exists, and typing into a
  // not-yet-ready box is silently dropped. Capped at READY_MAX.
  async function waitForReady() {
    const start = Date.now()
    while (Date.now() - start < READY_MAX) {
      const s = stripAnsi(buf)
      const boxReady = READY_MARKER.test(s) && !/Yes, I accept/i.test(s) && !/trust this folder/i.test(s)   // NOT ready while the bypass/trust dialog is up
      const quiet = Date.now() - lastDataAt >= READY_QUIET
      if (boxReady && quiet) return
      await delay(100)
    }
  }

  // The agent's latest DELIBERATE progress note: a line the agent marked with `[[ui]]` (the system prompt
  // tells it to prefix user-facing progress with that tag). We only ever surface these — never bullets,
  // tool calls, reasoning, or errors. Robust: no TUI-format guessing, just find the marker. Deduped.
  function emitNarration() {
    const lines = stripAnsi(buf).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      // claude renders each assistant line with a leading bullet; drop it so the marker is at the start.
      const line = lines[i].replace(/^\s*[●⏺]\s*/, '')
      const m = line.match(/^\[\[ui\]\]\s+(.+?)\s*$/i)   // a line the agent MARKED as user-facing progress
      if (!m) continue
      const t = m[1].trim()
      if (t && t !== lastNarr) { lastNarr = t; current?.h?.onNarration?.(t) }
      return
    }
  }

  // A real turn-end returns the TUI to the `❯` prompt (CLAUDE_TIMING.md). Silence ALONE is not enough:
  // auto-compaction (and other long server-side pauses) go quiet for >IDLE while still MID-TURN, which used
  // to trip `finish` and resolve the run before the agent's real work landed. So when the idle timer fires,
  // finish ONLY if the prompt is actually back; otherwise the agent is still working (compacting) — re-arm
  // and keep waiting. A hard silence cap prevents an infinite hang if the prompt marker never reappears.
  function maybeFinish() {
    if (!current) return
    const recent = stripAnsi(buf).slice(-4000)
    if (READY_MARKER.test(recent) || Date.now() - lastDataAt >= HARD_SILENCE) return finish()
    if (idle) clearTimeout(idle)
    idle = setTimeout(maybeFinish, IDLE)
  }

  function finish() {
    if (!current) return
    if (idle) clearTimeout(idle)
    if (donePoll) { clearInterval(donePoll); donePoll = null }
    const job = current; current = null
    job.resolve({ lastLines: lastLines(buf), ms: Date.now() - job.startedAt })
    pump()
  }

  async function pump() {
    if (current || !queue.length || !pty) return
    current = queue.shift()!
    current.startedAt = Date.now()
    current.submitted = false
    // Wait until the TUI is actually ready for input BEFORE typing (the startup/welcome takes a few
    // seconds; typing into it too early is silently dropped). Then type the single-line prompt and
    // send Enter SEPARATELY after a beat (a paste + \r in one go doesn't submit).
    await waitForReady()
    const job = current
    if (!job || job.submitted || !pty) return   // pty can vanish (claude exited/reset) during the awaits above
    const line = job.prompt.replace(/\s+/g, ' ').trim()
    pty.write(line)
    await delay(900)                          // let the whole line land + render in the input box
    if (current !== job || !pty) return       // stopped/replaced/exited while we waited
    pty.write('\r')                           // submit — Enter as \r (\n does NOT submit, it appends)
    job.submitted = true
    if (idle) clearTimeout(idle)
    idle = setTimeout(finish, FIRST)          // grace for the FIRST agent output; onData then tightens to IDLE
    // Fast path: the instant the caller's deliverable exists (e.g. out/answer.json written), resolve —
    // don't sit through the idle timeout. Falls back to idle if doneWhen never fires.
    if (job.h?.doneWhen) {
      donePoll = setInterval(async () => {
        if (current !== job) { if (donePoll) { clearInterval(donePoll); donePoll = null } return }
        try { if (await job.h!.doneWhen!()) finish() } catch { /* predicate error → keep waiting on idle */ }
      }, 250)
    }
    // Safety net: if the agent hasn't started after a beat (a dropped keystroke), submit once more.
    await delay(2500)
    if (current === job && pty && !WORKING_MARKER.test(stripAnsi(buf).slice(-4000))) pty.write('\r')
  }

  const enqueue = (prompt: string, h?: RunHandlers) =>
    new Promise<RunResult>((resolve) => { queue.push({ prompt, h, resolve, startedAt: 0, submitted: false }); pump() })

  return {
    kind: 'pty',                                                    // a real terminal stream → UI renders a terminal emulator
    // Pre-spawn the PTY and wait until the input box is up — so the first real question doesn't pay the
    // ~10-15s claude startup. Idempotent: a second call is a cheap no-op once the box is ready.
    async warmup() { await ensure(); await waitForReady() },
    // Interactive terminal: write raw keystrokes/paste straight to the PTY (spawns it first if needed), and
    // subscribe to every byte of output. This is the /login passthrough — the UI drives claude directly.
    async input(data: string) { await ensure(); try { pty?.write(data) } catch { /* PTY vanished */ } },
    onRaw(cb: (d: string) => void) { rawListeners.add(cb); return () => rawListeners.delete(cb) },
    async run(prompt, h) { await ensure(); return enqueue(prompt, h) },
    async compact(h) { await ensure(); return enqueue('/compact', h) },   // same terminal — compact when context grows
    buffer: () => buf,
    busy: () => !!current,
    stop: () => { try { pty?.kill() } catch {} },
    // The UI fits xterm to its container width and sends the resulting cols/rows here so claude's
    // TUI re-lays-out to fill the panel (no more 120-col clamp). Stored for the next spawn too.
    resize: (c: number, r: number) => { cols = Math.max(40, c | 0); rows = Math.max(10, r | 0); try { pty?.resize(cols, rows) } catch {} },
    sessionId: () => sid,
    // Abandon this conversation: kill the PTY and mint a NEW id (no --resume). The next run spawns a
    // fresh claude session — nothing carried over. Deliberate reset, distinct from a crash (onExit).
    reset: () => { try { pty?.kill() } catch {}; pty = null; buf = ''; resuming = false; sid = randomUUID() },
  }
}
