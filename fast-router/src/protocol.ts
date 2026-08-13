// The wire shape — identical envelope to the existing DO hub (cloudflare/superadmin/src/hub-core.ts).
// fast-router is NOT a new protocol; it's a new server-side role on the SAME per-project DO. The DO
// stamps `from` on every relayed message (we never set it); we send `to` (or omit for broadcast).

export interface Envelope {
  to?: { id?: string; type?: string }
  from?: { id: string; type: string; userId?: string }
  payload: any
}

// ── Identity model (carried on every as-you-type message, across every hop) ────────────────────
//
//   projectId  scope — selects the DO + the per-project index. (Connection-level for the worker,
//              but ALSO echoed in the payload so a mis-routed message across hops is caught.)
//   userId     trusted — DO-stamps it from the verified JWT; the engine forwards that trusted value.
//              NEVER take it from a browser-supplied field. Scopes personalization within a project.
//   inputId    a fresh UUID the FRONTEND generates when the user focuses/clicks an input box. Stable
//              for that focus session, unique per tab/field. This is what makes two tabs (same user)
//              go to the RIGHT place — the reply is matched back to the exact input box by inputId.
//   seq        monotonic per-CHANGE counter within an inputId (one per keystroke). Debounce +
//              drop-stale + coalesce: for a given (projectId,userId,inputId) only the highest seq
//              matters; anything lower that arrives late is discarded at every layer.
//
// Routing key for a suggestion stream = (projectId, userId, inputId); ordering within it = seq.

export interface Ident {
  projectId: string
  userId: string
  inputId: string
  seq: number
}

// ── Intent — the FIRST routing decision: what KIND of request is this? ─────────────────────────
//
// Generic and dataset-agnostic. The classifier is a MODEL (semantic + GLiNER, per project, tuned by
// the consolidation agent) — the protocol only NAMES the kinds; the engine never hardcodes trigger
// phrases. Intent lets the engine pick the cheapest correct path (see per-kind note).
export type Intent =
  | 'lookup'     // retrieve a specific value/figure directly   → fast exact/replay path
  | 'analysis'   // reason over data: compare/decompose/explain  → full program path
  | 'edit'       // correct/refine the PREVIOUS answer           → refine last program in-session
  | 'action'     // perform a side-effecting task / command      → command handler
  | 'unknown'    // not confidently any of the above             → let the slow path decide

export interface IntentGuess {
  intent: Intent
  confidence: number   // 0..1
}

// The intent classes as an array — generic (engine-level), fed to the GLiNER classifier.
export const INTENT_LABELS: Intent[] = ['lookup', 'analysis', 'edit', 'action']

// ── Payloads (mirrors the engine's `{ t: ... }` convention) ──────────────────────────────────

// engine → fast-router: a debounced partial (or full) question to route on.
export interface SuggestMsg extends Ident {
  t: 'suggest'
  text: string       // what the user has typed so far
}

// fast-router → engine: the routing for this text. `intent` is the primary output (shipped first);
// `items` (matched prior questions, extracted params, entity hits) fill in as those paths land.
// Echoes the full Ident so the engine can (a) drop stale replies by seq and (b) route to the exact
// tab/input by inputId.
export interface SuggestionsMsg extends Ident {
  t: 'suggestions'
  intent: IntentGuess
  items: Suggestion[]
  ms: number         // server-side compute time, for observability
  diag?: SuggestDiag // rich breakdown for the test console (safe to ignore in production)
}

// Detailed analysis surfaced to the test console: every candidate + its score, and per-stage timing.
export interface SuggestDiag {
  text: string
  collection: string
  points: number                                    // how many prior questions are indexed for this project
  matches: { question: string; score: number; intent?: string; params?: Record<string, unknown> }[]  // score = cosine similarity 0..1
  intentScores?: Record<string, number>             // per-class score from the GLiNER classifier
  entities?: { text: string; label: string; score: number }[]   // GLiNER NER (per-project labels)
  timings: Record<string, number>                   // stage → ms (embed, qdrant, gliner, …)
  threshold: number                                 // the "surface as a suggestion" cutoff
}

export interface Suggestion {
  kind: 'match' | 'entity' | 'param'   // matched prior question | an entity hit | an extracted parameter
  label: string                        // what to show the user
  question?: string                    // the canonical question to run on click
  params?: Record<string, unknown>     // extracted / resolved parameters to run it with
  score: number                        // 0..1 confidence
}

// engine → fast-router (fire-and-forget): a question that got a GOOD answer, to index for next time.
// Scoped by project + user (no inputId/seq — it's not part of a keystroke stream).
export interface IngestMsg {
  t: 'ingest'
  projectId: string
  userId: string
  question: string
  normQ?: string
  programRef?: string                  // pointer to the saved program that answered it
  params?: Record<string, unknown>
  quality?: number                     // how good the answer was (drives whether/how strongly to index)
}

// ── Generic model-task protocol (machine-to-machine) ───────────────────────────────────────────
// Beyond the fixed `suggest` pipeline, the worker exposes the raw model as request/response tasks.
// The DO relays these OPAQUELY — they are a caller ↔ fast-router-worker contract, never a DO concern
// (no Cloudflare change to add a task). A caller (any 'runtime') addresses { type: 'fast-router' } and
// mints a `reqId`; the worker runs the model and replies with the same reqId so the caller can match it.

// Zero-shot classification over an ARBITRARY label set — labels are given per call, nothing hardcoded.
export interface ClassifyMsg {
  t: 'classify'
  reqId: string
  text: string
  labels: string[]
  multiLabel?: boolean   // default false → single best class; true → independent per-label scores
  threshold?: number     // default 0 → floor for returned scores
}
export interface ClassifyResult {
  t: 'classify:result'
  reqId: string
  top: { label: string; score: number }   // highest-scoring label
  scores: Record<string, number>           // every label → score (0..1)
  ms: number
}

// Zero-shot NER over an ARBITRARY label set.
export interface NerMsg {
  t: 'ner'
  reqId: string
  text: string
  labels: string[]
}
export interface NerResult {
  t: 'ner:result'
  reqId: string
  entities: { text: string; label: string; score: number }[]
  ms: number
}

// Any task can fail (empty input, model error) — echoed with reqId so the caller settles its request.
export interface TaskError {
  t: 'task:error'
  reqId?: string
  error: string
}

export type FromEngine = SuggestMsg | IngestMsg | ClassifyMsg | NerMsg
export type FromRouter = SuggestionsMsg | ClassifyResult | NerResult | TaskError

export const HUB_ROLE = 'fast-router' as const
export const ENGINE_ROLE = 'code-engine' as const

// The staleness key for a keystroke stream. Kept here so every layer computes it identically.
export function streamKey(i: { projectId: string; userId: string; inputId: string }): string {
  return JSON.stringify([i.projectId, i.userId, i.inputId])
}
