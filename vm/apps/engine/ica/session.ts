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
  // Fast completion: polled (~250ms) after the prompt is submitted. When it returns true the run
  // resolves IMMEDIATELY, instead of waiting out the idle timeout. Use it when the agent's deliverable
  // is a file (e.g. out/answer.json) — the moment it's written, we're done; don't wait for silence.
  // Only a harness with turnEnd: 'inferred' polls this — see Session.turnEnd. A 'native' one is TOLD when the
  // turn ends, so it resolves on that and never looks at the predicate.
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
  // HOW THIS HARNESS KNOWS A TURN IS OVER — the difference that shapes everything above.
  //   'native'   the SDK reports it (pi, opencode, codex). run() resolves on that signal. Exact.
  //   'inferred' we are reading a terminal (claude-code) and there is no such signal, so it is deduced from
  //              the prompt marker returning plus silence — and it additionally polls handlers.doneWhen so a
  //              caller whose deliverable is a file can end the turn the moment the file appears, instead of
  //              waiting out the silence.
  // Stated per harness rather than left to be discovered, because "does doneWhen do anything here?" is
  // otherwise unanswerable without reading four implementations.
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
