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
export type EngineMsgType =
  | 'tick' | 'welcome' | 'machine:waking' | 'error'
  | 'analyst:status' | 'analyst:stream' | 'analyst:category' | 'analyst:chunk'
  | 'analyst:progress' | 'analyst:gap' | 'analyst:enriching' | 'analyst:enriched'
  | 'analyst:answer' | 'analyst:done'
  | 'sessions:res' | 'session:load:res' | 'suggestions:res' | 'suggestions'

// The ones a headless surface actually acts on; others share the generic shape.
export type EnginePayload =
  | { t: 'tick' }                                                     // liveness ping
  | { t: 'machine:waking' }                                           // engine is suspended, coming up
  | { t: 'analyst:status'; text: string }                            // interim progress line
  | { t: 'analyst:answer'; category?: string; answer: Answer; timing?: unknown; sid?: string; qid?: string; reused?: boolean }
  | { t: 'analyst:done' }
  | { t: 'error'; message: string; source?: string }
  | { t: EngineMsgType; [k: string]: unknown }                       // catch-all for stream/session variants

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
  caveat?: string
  [k: string]: unknown
}
