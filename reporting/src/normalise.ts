// ── The answer as callers send it → the answer this service draws ────────────────
// The platform's answer (clients/protocol.ts) names a column as a string or as { label, unit }, and the time it
// covers as `periods`; this service draws string columns and one `period`. Read at the door, once, so every
// representation (html, png, csv) is drawn from the same stored answer.

import type { Answer, AnswerSection } from './types.js'

type Column = string | { label?: unknown; unit?: unknown }
/** A cell carrying its own words ({ value, display }) is drawn by them. */
const cellOf = (v: any): unknown => (v && typeof v === 'object' && !Array.isArray(v) && 'display' in v ? String(v.display) : v && typeof v === 'object' && 'value' in v ? v.value : v)
const rowsOf = (rows: unknown) => (Array.isArray(rows) ? rows.map((r) => (Array.isArray(r) ? r.map(cellOf) : r)) : rows)
const columnName = (c: Column): string =>
  typeof c === 'string' ? c : `${String(c?.label ?? '')}${c?.unit ? ` (${String(c.unit)})` : ''}`

export function normalise(input: any): Answer {
  const a: any = { ...input }
  if (Array.isArray(a.sections)) a.sections = a.sections.map((s: any): AnswerSection => (Array.isArray(s?.columns) ? { ...s, columns: s.columns.map(columnName), rows: rowsOf(s.rows), ...(s.total ? { total: rowsOf([s.total])[0] } : {}) } : s))
  if (a.table && Array.isArray(a.table.columns)) a.table = { ...a.table, columns: a.table.columns.map(columnName), rows: rowsOf(a.table.rows) }
  if (!a.period && Array.isArray(a.periods) && a.periods.length) a.period = a.periods.map((p: any) => String(p?.label ?? '')).filter(Boolean).join(' · ')
  return a as Answer
}
