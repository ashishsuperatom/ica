// ── The answer as callers send it → the answer this service draws ────────────────
// The platform's answer (clients/protocol.ts) names a column as a string or as { label, unit }, and the time it
// covers as `periods`; this service draws string columns and one `period`. Read at the door, once, so every
// representation (html, png, csv) is drawn from the same stored answer.

import type { Answer, AnswerSection } from './types.js'

type Column = string | { label?: unknown; unit?: unknown }
const columnName = (c: Column): string =>
  typeof c === 'string' ? c : `${String(c?.label ?? '')}${c?.unit ? ` (${String(c.unit)})` : ''}`

export function normalise(input: any): Answer {
  const a: any = { ...input }
  if (Array.isArray(a.sections)) a.sections = a.sections.map((s: any): AnswerSection => (Array.isArray(s?.columns) ? { ...s, columns: s.columns.map(columnName) } : s))
  if (a.table && Array.isArray(a.table.columns)) a.table = { ...a.table, columns: a.table.columns.map(columnName) }
  if (!a.period && Array.isArray(a.periods) && a.periods.length) a.period = a.periods.map((p: any) => String(p?.label ?? '')).filter(Boolean).join(' · ')
  return a as Answer
}
