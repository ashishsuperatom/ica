// ── Claude Code session — a clean, reusable module ───────────────────────────
// Drives ONE persistent `claude` process in a PTY. PROMPT-AGNOSTIC: you pass any prompt,
// it submits it and streams the raw terminal output, detecting completion by IDLE — while
// Claude works the TUI never stops emitting, so no output for `idleMs` = the turn finished.
// Prompts are queued (one turn at a time). This module knows NOTHING about analysis, the
// hub, or any message protocol — that all lives in the caller.

import type { Session, RunHandlers, RunResult } from './session.js'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { statSync, openSync, readSync, closeSync, writeFileSync, readFileSync, renameSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { makeClaudeEventLog, transcriptPath } from './claude-events.js'
import { boxCredentialsReady } from './box-credentials.js'

// ── FIRST-RUN GATES ──────────────────────────────────────────────────────────────────────────────────────
// A freshly provisioned box has a credential but no history, and claude-code asks three questions before it
// will do any work. Each is a TUI prompt, so on a machine nobody is watching they do not fail — they HANG,
// which is far worse: the box looks alive, the turn never ends, and nothing in the logs says a dialog is
// waiting. Auth is never even reached.
//
//   hasCompletedOnboarding        the welcome flow
//   hasTrustDialogAccepted        "Do you trust the files in this folder?" — asked PER WORKING DIRECTORY, so
//                                 every new project workspace re-asks it
//   bypassPermissionsModeAccepted the warning raised because we spawn with --dangerously-skip-permissions.
//                                 The flag selects the mode; it does not accept the dialog about it.
//
// Trust is keyed on the RESOLVED path: on macOS a workspace under /var/... is really /private/var/..., and the
// unresolved key silently fails to match, so the prompt appears anyway and the seeding looks broken.
//
// EXISTING VALUES ARE NEVER OVERWRITTEN. On a developer's machine this file is the real one, holding real
// preferences; we add what is missing and touch nothing that is already answered — including a `false`, which
// is a decision someone made and not a gap to fill.
const firstRunSeeded = new Set<string>()
function seedFirstRunGates(cwd: string): void {
  if (firstRunSeeded.has(cwd)) return
  firstRunSeeded.add(cwd)
  const file = join(homedir(), '.claude.json')
  try {
    // Resolve through symlinks so the trust key matches what claude will look up. A cwd that does not exist
    // yet is not an error here — the caller creates it — so fall back to the literal path.
    let key = cwd
    try { key = realpathSync(cwd) } catch { /* not created yet; the literal path is the best guess */ }

    let cfg: any = {}
    try { cfg = JSON.parse(readFileSync(file, 'utf8')) || {} } catch { /* absent or unreadable ⇒ start fresh */ }

    let changed = false
    const put = (o: any, k: string, v: unknown) => { if (!(k in o)) { o[k] = v; changed = true } }
    put(cfg, 'hasCompletedOnboarding', true)
    put(cfg, 'bypassPermissionsModeAccepted', true)
    if (!cfg.projects || typeof cfg.projects !== 'object') { cfg.projects = {}; changed = true }
    if (!cfg.projects[key] || typeof cfg.projects[key] !== 'object') { cfg.projects[key] = {}; changed = true }
    put(cfg.projects[key], 'hasTrustDialogAccepted', true)

    if (!changed) return
    // Write via a temp file and rename so a crash — or two agents warming up at once — can never leave a
    // half-written config, which would lock the box out of every gate at the same time.
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cfg, null, 2))
    renameSync(tmp, file)
  } catch (e) {
    // Never fatal: on a machine that is already set up this is a no-op anyway, and a spawn that proceeds and
    // stops on a visible dialog beats one that refuses to start over a config file.
    console.warn(`[ica:claude] could not seed first-run gates (${(e as any)?.message ?? e}) — a fresh box may stop on a prompt`)
  }
}

export interface ClaudeSessionOpts {
  cwd: string                 // working directory the agent runs in
  model?: string              // required: named by the agent's profile
  bin?: string                // default $CLAUDE_BIN || 'claude'
  idleMs?: number             // silence that means "done" (default 6000; measured max working gap ≈ 3.7s)
  firstGraceMs?: number       // long grace for the FIRST output after submit (default 60000)
  bufferCap?: number          // rolling output buffer size (default 64000)
  resumeId?: string           // resume this claude session id (--resume); else a fresh id we own (--session-id)
  systemReference?: string    // authoritative authoring reference → injected via --append-system-prompt-file (no PTY typing)
}

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|[\r\b]/g, '')
const lastLines = (buf: string, n = 8) => { const ls = stripAnsi(buf).split('\n').map(l => l.trim()).filter(Boolean); return ls.slice(-n).join('\n') }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createClaudeSession(opts: ClaudeSessionOpts): Session {
  if (!opts.model) throw new Error('claude-code: no model given — the agent profile must name one')
  const model = opts.model
  const bin = opts.bin ?? process.env.CLAUDE_BIN ?? 'claude'
  // Authoritative authoring reference → the REAL system prompt via --append-system-prompt-file (a spawn arg, so
  // no fragile PTY typing; it survives compaction, unlike a file the agent must remember to re-read). Written
  // once here; the flag is added to the spawn args below. Absent ⇒ nothing injected (referencePlacement 'file').
  let sysRefFlag: string[] = []
  if (opts.systemReference?.trim()) {
    const p = join(opts.cwd, 'SYSTEM_REFERENCE.md')   // clear name: an agent may be asked to READ it (the file fallback)
    try { writeFileSync(p, opts.systemReference); sysRefFlag = ['--append-system-prompt-file', p] }
    catch (e) { console.warn('[ica:claude] could not write system-reference file; falling back to file-read', e) }
  }
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
  // ABSOLUTE cap on a single turn, however lively it is. HARD_SILENCE only catches an agent that goes QUIET;
  // one that keeps printing runs forever, and with it the doneWhen poller, the idle timer and the queue behind
  // it. Deliberately far longer than any real turn — this is not a deadline, it is the guarantee that a turn
  // ends. Anything hit by it was never coming back.
  const HARD_TURN = Number(process.env.ICA_MAX_TURN_MS) || 60 * 60 * 1000
  const READY_QUIET = 500                     // …and the TUI has been quiet this long (render settled)
  const READY_MAX = 25000                     // don't wait longer than this for startup
  const CAP = opts.bufferCap ?? 64000
  // The input box is READY when its prompt marker is on screen. Anchored to claude's TUI (see
  // ica/CLAUDE_TIMING.md); if a version changes this, re-measure with ica/cc-diag.mjs and update.
  const READY_MARKER = /❯|for shortcuts|bypass permissions/
  const WORKING_MARKER = /esc to interrupt|Cogitat|Creating|Thinking|✳|✽|⏺/   // agent accepted the prompt & is running

  let pty: any = null
  let buf = ''
  // Authoritative SCREEN state: a headless terminal emulator (server-side) consumes the SAME PTY byte stream
  // and holds the current 2D grid. `buffer()` serializes IT — a consistent snapshot that recreates the exact
  // screen — so reconnect/replay is correct (you cannot rebuild a cursor-addressed TUI from a raw byte tail).
  // `buf` stays the raw tail, still used for prompt-matching + answer extraction (those want the raw stream).
  let term: any = null            // @xterm/headless Terminal
  let serialize: any = null       // @xterm/addon-serialize — term.serialize() → the snapshot
  let idle: ReturnType<typeof setTimeout> | null = null
  let donePoll: ReturnType<typeof setInterval> | null = null   // fast completion: poll the caller's doneWhen()
  let hardCap: ReturnType<typeof setTimeout> | null = null     // absolute end-of-turn, so nothing can outlive it
  let lastDataAt = 0                          // timestamp of the last PTY byte — drives readiness (settle) detection
  let cols = 120, rows = 34                   // PTY size — the UI resizes this to fill its terminal width (SIGWINCH)
  interface Job { prompt: string; h?: RunHandlers; resolve: (r: RunResult) => void; startedAt: number; submitted: boolean }
  const queue: Job[] = []
  let current: Job | null = null
  let trustAccepted = false    // answered the one-time "trust this folder" safety dialog (new workspace dir)
  let bypassAccepted = false   // sent the "Yes, I accept" keystroke for the one-time Bypass-Permissions dialog
  let resumeChoiceSent = false // answered the "session is old" resume menu (once per spawn)
  const rawListeners = new Set<(d: string) => void>()   // interactive terminal viewers (raw PTY passthrough, e.g. /login from the UI)

  // ── STRUCTURED events, from the JSONL transcript (NOT the PTY) ──────────────────────────────────────────
  // claude writes a clean, structured transcript to ~/.claude/projects/<encoded-cwd>/<sid>.jsonl — one event
  // per line. We TAIL it and turn each line into an AgentEvent (the same shape codex emits), so the UI can
  // render claude through the shared event log with NO PTY and NO LLM. Purely additive: the PTY path above is
  // untouched — it stays as the on-demand "raw terminal" view.
  const eventLog = makeClaudeEventLog()
  let tailTimer: ReturnType<typeof setInterval> | null = null
  let tailPath = '', tailOffset = 0, tailBuf = ''
  function pollTranscript() {
    const path = transcriptPath(homedir(), opts.cwd, sid)   // sid can change (a failed --resume re-spawns fresh)
    if (path !== tailPath) { tailPath = path; tailOffset = 0; tailBuf = '' }
    let size = 0
    try { size = statSync(tailPath).size } catch { return }   // not created yet
    if (size < tailOffset) { tailOffset = 0; tailBuf = '' }   // truncated/rotated
    if (size <= tailOffset) return
    let chunk = ''
    try { const fd = openSync(tailPath, 'r'); const b = Buffer.alloc(size - tailOffset); readSync(fd, b, 0, b.length, tailOffset); closeSync(fd); chunk = b.toString('utf8'); tailOffset = size } catch { return }
    tailBuf += chunk
    let nl: number
    while ((nl = tailBuf.indexOf('\n')) >= 0) {
      const line = tailBuf.slice(0, nl); tailBuf = tailBuf.slice(nl + 1)
      if (!line.trim()) continue
      let o: any; try { o = JSON.parse(line) } catch { continue }
      for (const ev of eventLog.handleEntry(o)) {
        current?.h?.onEvent?.(ev)                                          // live to the active run; events() has the full log for replay
      }
    }
  }
  const startTail = () => { if (!tailTimer) tailTimer = setInterval(pollTranscript, 400) }
  const stopTail = () => { if (tailTimer) { clearInterval(tailTimer); tailTimer = null } }

  async function ensure() {
    if (pty) return
    if (!term) {   // one headless emulator per session, sized to match the PTY (kept in sync by resize())
      const [{ Terminal }, { SerializeAddon }] = await Promise.all([import('@xterm/headless'), import('@xterm/addon-serialize')])
      term = new Terminal({ cols, rows, scrollback: 200, allowProposedApi: true })
      serialize = new SerializeAddon(); term.loadAddon(serialize)
    }
    const m = await import('node-pty')
    // A box-side credential is inherited ONCE, at spawn. Warm-up already waits for the vault before starting
    // anything, but agents are also spawned lazily on first use — and a question that arrives while the vault
    // is still being retried would otherwise spawn an agent with no credential, which then stays broken for
    // its whole life while every log line says "not logged in". Wait here instead. Returns immediately on a
    // machine with its own login, and is capped so a vault outage delays the answer rather than hanging it.
    await boxCredentialsReady()
    // Before the very first spawn in this cwd: clear the prompts that would otherwise hang an unattended box.
    seedFirstRunGates(opts.cwd)
    // Each agent PTY must be a CLEAN, top-level claude-code session. If the engine was itself launched from
    // inside a claude-code session (e.g. dev-restarting pm2 from the CLI), it inherits CLAUDE_CODE_* markers;
    // passing them down makes the spawned claude think it's a CHILD session — which DISABLES transcript saving
    // (so --resume then fails with "No conversation found"). Strip every CLAUDE_CODE_* var so the agent is
    // always a fresh top-level session, regardless of how the engine was started.
    //
    // EXCEPT the credential. CLAUDE_CODE_OAUTH_TOKEN is how a box authenticates when nobody has logged into
    // it — the whole point of a fleet machine you never SSH into — and it shares the prefix of the session
    // markers by coincidence, not by kind. Stripping it makes an engine that was started with a perfectly
    // good credential report itself as not logged in, with nothing in the logs to say why. The markers this
    // guard exists for are all about session IDENTITY; the token is not one of them.
    const KEEP = new Set(['CLAUDE_CODE_OAUTH_TOKEN'])
    const childEnv: Record<string, any> = { ...process.env, TERM: 'xterm-256color' }
    for (const k of Object.keys(childEnv)) if (k.startsWith('CLAUDE_CODE_') && !KEEP.has(k)) delete childEnv[k]
    pty = m.spawn(bin, ['--model', model, '--dangerously-skip-permissions', ...sysRefFlag, ...sessionArgs()],
      { name: 'xterm-256color', cols, rows, cwd: opts.cwd, env: childEnv as any })
    lastDataAt = Date.now()
    pty.onData((d: string) => {
      buf = (buf + d).slice(-CAP)
      try { term?.write(d) } catch { /* emulator must never break the PTY */ }   // feed the authoritative screen
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
      // WARN with the version so we can re-calibrate. Fires for EVERY claude agent (analyst/connector/grounding).
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
          resuming = false; const dead = pty; pty = null; buf = ''; sid = randomUUID(); try { term?.reset() } catch {}
          try { dead?.kill() } catch {}
          void ensure()   // re-spawn fresh; waitForReady keeps polling the new session's buffer
          return
        }
      }
      current?.h?.onOutput?.(d)
      // NOTE: nothing user-facing is EVER sourced from this raw PTY byte stream — it goes to the terminal
      // surface and nowhere else. The stream interleaves cursor-addressed writes from all over the TUI (spinner,
      // token counter, the code being written) — stripAnsi can't reconstruct screen lines, so reading it here once
      // mashed the spinner + diff + source into a single "line" and leaked it to the user. Clean text only, below.
      // Completion tracking runs ONLY after we've submitted — before that, output is the TUI
      // starting up / echoing the typed prompt, which must NOT trip the "done" timer.
      if (current?.submitted) { if (idle) clearTimeout(idle); idle = setTimeout(maybeFinish, IDLE) }
    })
    pty.onExit(() => { pty = null })
    startTail()   // begin tailing this session's JSONL transcript → structured AgentEvents (independent of the PTY)
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
    if (hardCap) { clearTimeout(hardCap); hardCap = null }
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
    if (hardCap) clearTimeout(hardCap)
    hardCap = setTimeout(() => {
      if (current !== job) return
      console.warn(`[ica:claude] turn exceeded ${(HARD_TURN / 60000) | 0}m — ending it so the session is not held open`)
      finish()
    }, HARD_TURN)
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
    // No turn-end signal exists in a terminal: we deduce it from the ❯ prompt returning plus silence, and poll
    // handlers.doneWhen so a caller whose deliverable is a file (built.json, escalate.json) ends the moment it
    // lands rather than waiting the silence out. This is the ONLY harness where doneWhen does anything.
    turnEnd: 'inferred' as const,
    referencePlacement: sysRefFlag.length ? 'in-context' : 'file',  // injected via --append-system-prompt-file when present
    // Pre-spawn the PTY and wait until the input box is up — so the first real question doesn't pay the
    // ~10-15s claude startup. Idempotent: a second call is a cheap no-op once the box is ready.
    async warmup() { await ensure(); await waitForReady() },
    // Interactive terminal: write raw keystrokes/paste straight to the PTY (spawns it first if needed), and
    // subscribe to every byte of output. This is the /login passthrough — the UI drives claude directly.
    async input(data: string) { await ensure(); try { pty?.write(data) } catch { /* PTY vanished */ } },
    onRaw(cb: (d: string) => void) { rawListeners.add(cb); return () => rawListeners.delete(cb) },
    async run(prompt, h) { await ensure(); return enqueue(prompt, h) },
    async compact(h) { await ensure(); return enqueue('/compact', h) },   // same terminal — compact when context grows
    // Replay = the SERIALIZED SCREEN from the headless emulator (a consistent snapshot that recreates the exact
    // grid + cursor), NOT the raw byte tail — so a reconnecting client repaints correctly. Falls back to the raw
    // tail if the emulator isn't up yet or serialization throws.
    buffer: () => { try { return serialize ? serialize.serialize() : buf } catch { return buf } },
    // The STRUCTURED view (from the JSONL transcript) — the sibling of buffer(), same AgentEvent shape as codex.
    events: () => eventLog.events(),
    busy: () => !!current,
    stop: () => { stopTail(); try { pty?.kill() } catch {} },
    // The UI fits xterm to its container width and sends the resulting cols/rows here so claude's TUI re-lays-out
    // to fill the panel. Resize the emulator TOO, so its screen stays the same geometry as the client's.
    resize: (c: number, r: number) => { cols = Math.max(40, c | 0); rows = Math.max(10, r | 0); try { pty?.resize(cols, rows) } catch {}; try { term?.resize(cols, rows) } catch {} },
    sessionId: () => sid,
    // Abandon this conversation: kill the PTY and mint a NEW id (no --resume). The next run spawns a fresh claude
    // session — nothing carried over. Clear the emulator screen too so the replay doesn't show the old session.
    reset: () => { try { pty?.kill() } catch {}; pty = null; buf = ''; resuming = false; sid = randomUUID(); try { term?.reset() } catch {} },
  }
}
