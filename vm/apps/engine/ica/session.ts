// ── ICA session — the ONE interface every harness implements ─────────────────
// claude-code (PTY), pi (OpenRouter SDK), and opencode (headless server + SDK) all expose
// this same shape. Prompt-agnostic: the caller passes any prompt and streams output; the
// module knows nothing about the hub or any message protocol. Completion is per-harness
// (idle for claude-code, SDK-precise for pi/opencode) but the interface hides that.

export interface RunHandlers {
  onOutput?: (chunk: string) => void   // formatted text stream (raw PTY for claude-code; readable text for pi/opencode)
  onEvent?: (ev: any) => void          // FULL raw event — tool calls, args, token deltas, lifecycle.
                                       // The caller decides what to forward over the WS and what to discard.
  // Fast completion: polled (~250ms) after the prompt is submitted. When it returns true the run
  // resolves IMMEDIATELY, instead of waiting out the idle timeout. Use it when the agent's deliverable
  // is a file (e.g. out/answer.json) — the moment it's written, we're done; don't wait for silence.
  doneWhen?: () => boolean | Promise<boolean>
  // Clean, human-readable PROGRESS — the agent's own narration ("Found an exact match … writing the
  // answer"), NEVER tool calls or raw terminal. Harness-specific: claude-code parses its TUI prose;
  // SDK harnesses forward assistant-text events. Safe to show a non-technical user.
  onNarration?: (text: string) => void
}

export interface RunResult { lastLines: string; ms: number }   // lastLines = the answer/tail; ms = wall time

// Session lifecycle protocol — the same verbs for every harness: run · compact · reset · stop.
// Creation takes `resumeId` (opts) to continue a prior session; `sessionId()` reads the current id to
// persist; `reset()` abandons the session so the next run starts fresh. Optional methods degrade
// gracefully — when a harness can't do one, the engine recreates the agent instead.
export interface Session {
  // How this harness's output should be shown: 'pty' = a real terminal stream (claude-code → render in a
  // terminal emulator); 'events' = discrete agent events (codex/pi/opencode → render as a plain event log,
  // NOT a terminal). The UI picks its renderer from this. Absent ⇒ treat as 'events'.
  kind?: 'pty' | 'events'
  run(prompt: string, handlers?: RunHandlers): Promise<RunResult>   // queues one turn; resolves when it completes
  compact(handlers?: RunHandlers): Promise<RunResult>               // shrink context when it grows (same session)
  warmup?(): Promise<void>                                          // pre-spawn/connect so the first run is instant (no cold start)
  input?(data: string): void | Promise<void>                        // interactive terminal: raw keystrokes/paste → the agent's PTY (e.g. /login)
  onRaw?(cb: (d: string) => void): () => void                       // subscribe to every byte of PTY output (returns an unsubscribe)
  reset?(): void                                                    // abandon this session → a fresh one on the next run
  buffer(): string                                                  // rolling output (replay on reconnect)
  busy(): boolean
  stop(): void
  resize?(cols: number, rows: number): void                         // PTY harnesses only (claude-code) — fit terminal to the UI width
  sessionId?(): string | undefined                                  // the harness session id — persist it to resume across restarts
}
