// ── What a report is made of ──────────────────────────────────────────────────
// This service renders ONE input shape: the engine's `Answer`. That type is
// vendored here (not imported from ../clients/protocol.ts) on purpose — this is a
// standalone Cloudflare project with its own lockfile and deploy, and it must not
// take a source dependency on the engine plane. The canonical definition lives in
// `clients/protocol.ts`; keep this in sync when that changes, and treat any field
// we don't know about as ignorable (the shape is open via `[k: string]`).
//
// Note what this service deliberately does NOT know: Teams, email, Slack, or any
// other destination. It turns an Answer into representations (HTML / PNG / CSV)
// and hands back URLs. Callers decide what to do with them.

export type AnswerStatus = 'answered' | 'unknowable' | 'cannot_answer' | 'error'

export interface Figure {
  label: string
  display: string
  sub?: string
  value?: unknown
  neg?: boolean
}

export interface AnswerTable {
  columns: string[]
  rows: unknown[][]
  totalRows?: number
  total?: unknown[]
}

export interface AnswerSection {
  kind: 'table' | 'kpis' | 'text'
  title?: string
  columns?: string[]
  rows?: unknown[][]
  total?: unknown[]
  note?: string
  items?: Figure[]
  body?: string
  /** Set by the fit pass when this section's table was reduced. */
  fit?: { droppedRows: number; droppedCols: number; spill?: string }
}

export interface Answer {
  status?: AnswerStatus
  category?: string
  answer?: string | string[]
  period?: string
  scope?: string
  figures?: Figure[]
  table?: AnswerTable
  sections?: AnswerSection[]
  caveat?: string | string[]
  [k: string]: unknown
}

// ── The stored report ────────────────────────────────────────────────────────
// A report is immutable: the Answer as submitted, plus who submitted it and when.
// Re-answering the same question mints a NEW id, so a link that was shared keeps
// showing what the recipient was told at the time.

export interface ReportMeta {
  id: string
  projectId: string
  title?: string          // question text, usually — shown as the report heading
  createdAt: number
  expiresAt: number
  source?: string         // free-form: which caller submitted it ('engine', 'analyst', …)
}

export interface StoredReport {
  meta: ReportMeta
  answer: Answer
}

// The render surface a caller asks for. `png` is the constrained one — it must fit
// a fixed frame, so it gets the fit heuristics; `html` and `csv` are complete.
export type Surface = 'html' | 'png' | 'csv' | 'json'
