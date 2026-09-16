// ── ICA session — the ONE interface every harness implements ─────────────────
// claude-code (PTY), pi (OpenRouter SDK), and opencode (headless server + SDK) all expose
// this same shape. Prompt-agnostic: the caller passes any prompt and streams output; the
// module knows nothing about the hub or any message protocol. Completion is per-harness
// (idle for claude-code, SDK-precise for pi/opencode) but the interface hides that.

// A normalized agent-activity event — the STRUCTURED sibling of the text `buffer()`. Event-kind harnesses
// (codex/…) translate their own native events into these, so the UI renders ONE consistent event log
// (command runs, assistant messages, reasoning, file edits) no matter which harness produced them. Items
// carry a stable `id` across started→updated→completed so the UI can update a block in place as it streams.
export interface AgentEvent {
  kind: 'command' | 'message' | 'reasoning' | 'file' | 'turn'
  id?: string
  text?: string       // message/reasoning prose, or (kind:'file') the path
  command?: string    // kind:'command' — the shell command
  output?: string     // kind:'command' — its aggregated output
  status?: string     // kind:'command' — 'in_progress' | 'completed' | 'failed'
  done?: boolean      // the item reached completion (item.completed)
  at?: number         // WHEN, epoch ms — stamped as close to the source as the harness can manage
  ms?: number         // how long the step TOOK; a command is paired in_progress → completed by id
}

// ── Usage / cost — ABSTRACT INTERFACE every ICA harness SHOULD provide ────────────────────────────────
// Uniform token + $cost accounting for a turn, so cost is observable no matter which agent (narrator/
// analyst) or which backend (opencode/claude/codex) produced it. NOT fully wired yet — opencode surfaces this
// today (see ica/opencode.ts `[oc-usage]`); claude-code + codex still need to map their native usage into this
// shape. Delivered two ways (below): streamed via onUsage as it becomes known, AND as a total on RunResult.usage.
export interface TokenUsage {
  input?: number        // prompt / input tokens
  output?: number       // completion / output tokens
  reasoning?: number    // hidden reasoning tokens, when the model separates them
  cacheRead?: number    // prompt-cache HITS (cheap)
  cacheWrite?: number   // prompt-cache writes
  costUsd?: number      // this turn's $ cost, when the backend reports it
}

export interface RunHandlers {
  onOutput?: (chunk: string) => void   // formatted text stream (raw PTY for claude-code; readable text for pi/opencode)
  onEvent?: (ev: AgentEvent) => void   // normalized structured event (event-kind harnesses only; the harness
                                       // translates its native events → AgentEvent). The caller forwards these
                                       // to the UI event log; claude-code (pty) uses onOutput instead.
  // WHAT THE TURN WAS FOR. The caller says what its deliverable looks like — a file on disk, written by the
  // agent's last act. The moment it is there, the turn is over: the work is done and nothing said afterwards
  // can change it. EVERY harness honours this (see `endsWhenDone`), because it is a fact about the caller's
  // work, not about how a harness notices that a model stopped talking.
  doneWhen?: () => boolean | Promise<boolean>
  // Clean, human-readable PROGRESS — the agent's own narration ("Found an exact match … writing the
  // answer"), NEVER tool calls or raw terminal. Harness-specific: claude-code parses its TUI prose;
  // SDK harnesses forward assistant-text events. Safe to show a non-technical user.
  onNarration?: (text: string) => void
  // TODO(usage): the event form of the usage interface — EVERY ICA harness should call this as it learns its
  // token/cost numbers (a long turn may report incrementally, e.g. per assistant message), so the engine can
  // stream live cost to the UI just like onEvent streams activity. Not implemented by the harnesses yet.
  onUsage?: (u: TokenUsage) => void
}

// TODO(usage): `usage` — the finished turn's token/cost TOTALS. Every ICA harness should populate it when the
// backend can report it (see TokenUsage). Optional for now so nothing breaks; opencode has the data (ica/
// opencode.ts logs it), claude-code/codex to follow. This is the "tell us when it finishes" half of the contract.
export interface RunResult { lastLines: string; ms: number; usage?: TokenUsage }   // lastLines = the answer/tail; ms = wall time

// Session lifecycle protocol — the same verbs for every harness: run · compact · reset · stop.
// Creation takes `resumeId` (opts) to continue a prior session; `sessionId()` reads the current id to
// persist; `reset()` abandons the session so the next run starts fresh. Optional methods degrade
// gracefully — when a harness can't do one, the engine recreates the agent instead.
export interface Session {
  // How this harness's output should be shown: 'pty' = a real terminal stream (claude-code → render in a
  // terminal emulator); 'events' = discrete agent events (codex/pi/opencode → render as a plain event log,
  // NOT a terminal). The UI picks its renderer from this. Absent ⇒ treat as 'events'.
  kind?: 'pty' | 'events'
  // Where this session's `systemReference` (the authoritative authoring reference) ended up:
  //   'in-context' — the harness put it where the model ALWAYS sees it: the real system prompt
  //                  (claude --append-system-prompt-file, opencode `system`) or an auto-loaded project doc
  //                  (codex AGENTS.md). No file to read, no read-instruction needed.
  //   'file'       — the harness can't carry it → the CALLER must write it into the workspace and tell the
  //                  agent to read it (the legacy behavior). Absent ⇒ treat as 'file'.
  // Lets the engine drop the "go read CONTEXT.md" preamble only when the reference is already in-context.
  referencePlacement?: 'in-context' | 'file'
  // HOW THIS HARNESS NOTICES THE MODEL HAS STOPPED TALKING — a fallback, and an event worth recording, but
  // NOT what a turn waits on. A turn ends when its deliverable exists (`doneWhen`); this is what happens when
  // there is no deliverable, or the agent stops without producing one.
  //   'native'   the SDK tells us (pi, opencode, codex). Exact, and free.
  //   'inferred' we are reading a terminal (claude-code) and there is no such signal, so it is deduced from
  //              the prompt marker returning plus silence — a guess, and the reason `doneWhen` was written.
  turnEnd: 'native' | 'inferred'
  run(prompt: string, handlers?: RunHandlers): Promise<RunResult>   // queues one turn; resolves when it completes
  compact(handlers?: RunHandlers): Promise<RunResult>               // shrink context when it grows (same session)
  warmup?(): Promise<void>                                          // pre-spawn/connect so the first run is instant (no cold start)
  input?(data: string): void | Promise<void>                        // interactive terminal: raw keystrokes/paste → the agent's PTY (e.g. /login)
  onRaw?(cb: (d: string) => void): () => void                       // subscribe to every byte of PTY output (returns an unsubscribe)
  reset?(): void                                                    // abandon this session → a fresh one on the next run
  buffer(): string                                                  // rolling text output (replay on reconnect; the 'pty' view)
  events?(): AgentEvent[]                                           // rolling structured events (replay on reconnect; the 'events' view — event-kind harnesses only)
  busy(): boolean
  stop(): void
  resize?(cols: number, rows: number): void                         // PTY harnesses only (claude-code) — fit terminal to the UI width
  sessionId?(): string | undefined                                  // the harness session id — persist it to resume across restarts
}

// ── THE TURN IS OVER WHEN ITS WORK IS DONE ───────────────────────────────────────────────────────────────────
//
// An agent whose job is to produce something finishes that job and then, often, writes a closing paragraph about
// it. The work was over at the first moment; the person waited through the second. Worse, four harnesses each had
// their own idea of when a turn ends — silence, an SDK event, a prompt marker — and none of them is the question
// actually being asked, which is: IS THE THING THERE?
//
// So it is asked here, once, for all of them. The caller says what its deliverable looks like (`doneWhen`); this
// watches for it and ends the turn the moment it appears. A harness's own end-of-turn signal stays where it is —
// it is worth recording, and it is what happens when an agent stops without producing anything — but nothing
// waits on it when there is a deliverable to wait for instead.

export interface Deliverable {
  /** Stop watching — always called when the turn resolves, however it resolved. */
  stop(): void
  /** Did the deliverable arrive? True when this is why the turn ended, so an abort is not reported as a failure. */
  arrived(): boolean
}

export function endsWhenDone(h: RunHandlers | undefined, end: () => void, everyMs = 250): Deliverable {
  if (!h?.doneWhen) return { stop() {}, arrived: () => false }
  let here = false
  let over = false
  const timer = setInterval(async () => {
    if (here || over) return
    try { if (!(await h.doneWhen!())) return } catch { return }   // a check that throws is not an answer
    here = true
    clearInterval(timer)
    end()
  }, everyMs)
  timer.unref?.()
  return { stop() { over = true; clearInterval(timer) }, arrived: () => here }
}
