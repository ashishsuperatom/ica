// ── Superatom transmission protocol (WebSocket) ──────────────────────────────
// The SINGLE, canonical description of what flows over the hub WebSocket between
// any client surface (web / teams / slack / ios / android) and the code-engine,
// via the Durable Object hub. Import these types everywhere so a wrong `t`, role,
// or shape can't be sent. Keep this SMALL — it's a living doc: as the real
// messages settle, prune drift here and let the types push the fix everywhere.
//
// Shape of the wire:
//   client → hub :  { to?, payload }          the hub STAMPS `from` (clients never set it) and relays
//   hub → client :  { from, payload }          engine/hub messages arrive wrapped like this
// Auth is the FIRST message (`hello`); every later message is an envelope above.

// Who you are on the hub.
export type Role = 'runtime' | 'code-engine' | 'fast-router' | 'admin'

// A runtime's origin surface. Also the `svc:<surface>` service-member convention
// (a headless bot authenticates as member `svc:teams`, `svc:slack`, …).
export type Surface = 'web' | 'teams' | 'slack' | 'ios' | 'android'

// ── Handshake (first message after connect) ──────────────────────────────────
// A human/bot presents a platform JWT; server-side adapters present a shared key.
export type Hello =
  | { type: 'hello'; role: 'runtime'; token: string }                              // user or bot: platform JWT
  | { type: 'hello'; role: 'runtime' | 'fast-router'; key: string }                // shared-secret adapter
  | { type: 'hello'; role: 'code-engine'; key: string; instanceId?: string; epoch?: number }

// ── Envelope ──────────────────────────────────────────────────────────────────
export type Envelope<P> = { to?: { type?: Role; id?: string }; payload: P }        // client → hub
export type Incoming<P> = { from: { id: string; type: Role | 'hub' }; payload: P } // hub → client

// ── Client → engine payloads ──────────────────────────────────────────────────
// `t` values a surface may SEND. Only `analyse` is needed for a question→answer
// surface; the rest are the web app's session/UI helpers (enumerated for the doc).
export type ClientMsgType =
  | 'analyse'
  | 'consolidate' | 'semantic:build'
  | 'sessions:list' | 'session:load' | 'suggestions:req' | 'suggest'
  | 'term:attach' | 'term:input'

export type Analyse = {
  t: 'analyse'
  question: string
  projectId: string
  sessionId: string       // one thread of intent; a Teams conversation = one session
  questionId: string      // client-minted; the answer echoes it as qid
  role?: string           // 'user' | 'developer' (persona hint, not access control)
}
// The union a surface sends. Extend with concrete shapes as surfaces need them.
export type ClientPayload = Analyse | { t: Exclude<ClientMsgType, 'analyse'>; [k: string]: unknown }

// ── Engine → client payloads ──────────────────────────────────────────────────
// `t` values a surface may RECEIVE. A surface can ignore any it doesn't render.
// THE VERBS a user can prefix a question with. Declared here, in the shared contract, because both sides need
// the same list: the engine routes on it and the client filters on it. The engine's verbs/ module imports this
// rather than keeping its own copy, so there is one place a new verb is added.
export type Verb = 'edit' | 'explain' | 'run' | 'check' | 'program' | 'view'

export type EngineMsgType =
  | 'tick' | 'welcome' | 'machine:waking' | 'error' | 'done'
  // THE ANSWER and its story — what every surface renders, however differently.
  | 'session:step' | 'analyst:answer' | 'narration' | 'followups'
  // VERB TURNS (explain:, check:, …) — their events, sent straight to the ASKER as they happen. NOT an agent
  // lane and NOT gated on anyone attaching to one: the user asked for this turn by name, so its progress is
  // theirs by right. Everything is sent; the client decides what to render — today just `kind: 'message'`,
  // and showing the tool calls later is a client change with nothing to alter in the engine.
  //
  // One type carrying `verb` rather than one type per verb: the client filters on the field, and the next
  // verb needs no new message and no new case anywhere that already handles this one.
  | 'verb:event'
  // STOP — the client asks for the turn in a session to be abandoned; the engine confirms whether one was
  // running. A turn can span two agents and several minutes, so this is scoped to the SESSION, not a question:
  // by the time the message lands, the work may have moved from the composer to the analyst.
  | 'turn:stop' | 'turn:stopped'
  // A PROGRAM RUNNING — what it is doing, while it does it. Sent for the whole turn, whether the engine started
  // the program or the agent did from its own shell; run.mjs writes the same trace either way. This is the
  // difference between a three-minute query and a hang, which from outside look identical.
  | 'program:event'
  // AGENT LANES — one vocabulary for every agent (composer, analyst, concept-modeller, and any later one),
  // keyed by `lane`. This replaced a per-agent set (analyst:status/stream/category/progress/done,
  // concept:event/status/stream): a new agent needed new message types, and every consumer had to learn them.
  | 'agent:hello'      // the lane announces itself: label, stream kind, whether it has a raw terminal
  | 'agent:event'      // one work atom (ev.kind: command|message|reasoning|file|turn|user|segment|narration)
  | 'agent:events'     // full replay after a reconnect
  | 'agent:status'     // live state: text | category | progress | state:'done'
  | 'agent:chunk'      // raw output for a lane that has no structured events
  // The analyst's raw TERMINAL bytes. Deliberately NOT a lane frame: it is a byte stream for an xterm, shared
  // with the admin console, and only sent to a client that asked for it (term:attach).
  | 'analyst:chunk'
  // DATASOURCE INDEX build, driven from the admin console.
  | 'index:status' | 'index:line' | 'index:done'
  // Session/suggestion plumbing.
  | 'sessions:res' | 'session:load:res' | 'suggestions:res' | 'suggestions'
  | 'sync:res' | 'answer:res' | 'session:reset' | 'inspect:res' | 'program:forget:res'
  // ADMIN CONSOLE surfaces. Same wire, different reader — the console watches agents that never face an end
  // user (the connector wiring up a source, the grounding build) and can open a raw terminal into one.
  | 'grounding:status' | 'grounding:done'
  | 'connector:status' | 'connector:done' | 'term:stream'
  // Their STRUCTURED work arrives as the lane frames above (lane: 'connector' | 'grounding' | 'analyst'), the
  // same vocabulary the user-facing surfaces use — one idea, carried once.
  // Raw terminal BYTES keep a per-agent type: a byte stream feeding an xterm is a different thing from a
  // structured event, and it is only sent to a client that asked for it (term:attach).
  | 'connector:chunk' | 'grounding:chunk'
  // CHAT-CHANNEL delivery (Teams/Slack): the answer is addressed to a channel, not to a live socket.
  | 'channel:answer' | 'channel:narration'

// The ones a headless surface actually acts on; others share the generic shape.
export type EnginePayload =
  | { t: 'tick' }                                                     // liveness ping
  | { t: 'machine:waking' }                                           // engine is suspended, coming up
  | { t: 'analyst:answer'; category?: string; answer: Answer; timing?: unknown; sid?: string; qid?: string; reused?: boolean }
  | { t: 'program:event'; ev: { t: string; text: string; run?: string; program?: string; sql?: string; ms?: number; rows?: number; error?: string }; sid?: string; qid?: string }
  | { t: 'turn:stop'; sessionId: string; reason?: string }
  | { t: 'turn:stopped'; sessionId: string; stopped: boolean }
  | { t: 'verb:event'; verb: Verb; ev: { kind: string; text?: string; command?: string; id?: string; done?: boolean }; sid?: string; qid?: string }
  | { t: 'narration'; text: string; qid?: string; sid?: string }      // a business-language beat while work happens
  | { t: 'followups'; items: string[]; qid?: string; sid?: string }
  | { t: 'agent:status'; lane: Lane; text?: string; category?: string; progress?: string; state?: 'done'; question?: string; sid?: string }
  | { t: 'agent:event'; lane: Lane; ev: unknown; qid?: string; sid?: string }
  | { t: 'agent:events'; lane: Lane; events: unknown[]; replace?: boolean }
  | { t: 'agent:hello'; lane: Lane; label?: string; streamKind?: 'events' | 'pty'; pty?: boolean; interactive?: boolean }
  | { t: 'error'; message: string; source?: string }
  | { t: EngineMsgType; [k: string]: unknown }                       // catch-all for the plumbing variants

// WHICH AGENT a lane frame belongs to. A lane is one agent's observable work stream; `lane` is the routing key
// so a consumer places the frame without knowing anything about the agent behind it.
export type Lane = 'composer' | 'analyst' | 'modeler' | (string & {})

// ── The Answer (the JSON every surface renders, each in its own way) ──────────
export type AnswerStatus = 'answered' | 'unknowable' | 'cannot_answer' | 'error'
export interface Answer {
  status?: AnswerStatus
  category?: string
  answer?: string                                                    // prose
  period?: string
  scope?: string
  figures?: { label: string; display: string; sub?: string; value?: unknown; neg?: boolean }[]
  table?: { columns: string[]; rows: unknown[][]; totalRows?: number; total?: unknown[] }
  // Multi-block report: an ORDERED list of sections. A simple answer omits this and uses figures/table above.
  // kind:'table' → columns/rows (+ optional total/note); 'kpis' → items (same shape as figures); 'text' → body.
  sections?: { kind: 'table' | 'kpis' | 'text'; title?: string; columns?: string[]; rows?: unknown[][]; total?: unknown[]; note?: string; items?: { label: string; display: string; sub?: string; value?: unknown; neg?: boolean }[]; body?: string }[]
  caveat?: string
  [k: string]: unknown
}
