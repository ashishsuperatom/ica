// ── Fitting a report into a fixed frame ──────────────────────────────────────
// The HTML and CSV surfaces are COMPLETE — every row, every column, always. Only
// the image is constrained: it has a fixed width and a practical height ceiling
// (a 4000px-tall PNG in a Teams card is unreadable and slow to load), so it must
// sometimes show less than the whole answer.
//
// Two rules govern every reduction here:
//
//   1. NEVER re-order or re-rank. The engine chose the row order for a reason we
//      cannot see from here — "top 10 by margin", "chronological", "as the user
//      asked". Re-sorting to fit would silently change what the answer MEANS.
//      We only ever truncate a tail, in place.
//   2. NEVER hide a reduction. Anything dropped is announced in the artefact
//      itself ("+473 more rows"), so an image is never mistaken for the whole
//      answer. A silently-truncated report is a wrong report.
//
// Limits are PARAMETERS, not constants: they arrive per-render, defaults below.
// They're the kind of value that should eventually be learned from real reports
// (how wide do columns actually get? how many rows do people actually read?)
// rather than fixed by us today.

import type { Answer, AnswerSection, AnswerTable, Figure } from '../types.js'

export interface FitLimits {
  width: number          // logical px of the image frame
  maxRows: number        // rows of any one table kept in the image (upper bound)
  maxCols: number        // columns kept in the image
  maxHeight: number      // logical px the image may grow to before rows are cut further
  maxCellChars: number   // per-cell text before ellipsis
  maxSections: number    // sections rendered before the rest are summarised
  maxFigures: number     // KPI tiles before the rest are dropped
  maxProseChars: number  // prose paragraph length before ellipsis
}

export const DEFAULT_LIMITS: FitLimits = {
  width: 1000,
  maxRows: 14,
  maxCols: 7,
  maxHeight: 1800,       // ~1.8:1 — beyond this a chat client shrinks it to illegibility
  maxCellChars: 42,
  maxSections: 6,
  // 5 tiles fill one row at the default width. A 6th wraps alone and looks broken,
  // and the web design system's negative-margin divider trick (which hides a wrapped
  // row's leading rule) is not portable across three renderers — so we don't wrap.
  maxFigures: 5,
  maxProseChars: 900,
}

/** What a fit dropped, so the renderer can say so and the caller can decide to
 *  send HTML instead of an image. */
export interface FitReport {
  reduced: boolean
  droppedRows: number
  droppedCols: number
  droppedSections: number
  droppedFigures: number
  /** Reductions that have NO inline home in the document (dropped sections, dropped
   *  figures) and so must be announced in the footer. Table spills are excluded on
   *  purpose — they already render under their own table, and repeating them reads
   *  as two different problems. */
  notes: string[]
}

export interface FittedTable extends AnswerTable {
  fit: { droppedRows: number; droppedCols: number; keptColIndexes: number[]; spill?: string }
}

/** Column keep-set. We keep the FIRST column unconditionally — in practically every
 *  answer it is the label/entity that makes the row meaningful, and a table of
 *  numbers with no labels is worse than no table. Beyond that we keep leading
 *  columns in their given order (the engine put the important ones first) and drop
 *  the tail, because reordering columns is as meaning-changing as reordering rows. */
function keepColumns(columns: string[], max: number): number[] {
  if (columns.length <= max) return columns.map((_, i) => i)
  return Array.from({ length: max }, (_, i) => i)
}

function truncCell(v: unknown, maxChars: number): string {
  if (v == null) return ''
  const s = typeof v === 'number' ? v.toLocaleString('en-US') : String(v)
  return s.length > maxChars ? s.slice(0, maxChars - 1).trimEnd() + '…' : s
}

/** Fit one table. Rows truncate from the tail; a `total` row (if present) is kept
 *  even when the rows it sums are not — a total is the one line that still tells
 *  the truth about the rows you cannot see. */
export function fitTable(t: AnswerTable, limits: FitLimits): FittedTable {
  const keptColIndexes = keepColumns(t.columns ?? [], limits.maxCols)
  const droppedCols = (t.columns?.length ?? 0) - keptColIndexes.length
  const allRows = t.rows ?? []
  const declaredTotal = typeof t.totalRows === 'number' ? t.totalRows : allRows.length
  const keptRows = allRows.slice(0, limits.maxRows)
  // Rows we can't show = the tail we cut, PLUS any the caller already told us exist
  // beyond what they sent (totalRows > rows.length happens when the engine paginates).
  const droppedRows = Math.max(0, declaredTotal - keptRows.length)

  const spillBits: string[] = []
  if (droppedRows > 0) spillBits.push(`+${droppedRows.toLocaleString('en-US')} more ${droppedRows === 1 ? 'row' : 'rows'}`)
  if (droppedCols > 0) spillBits.push(`+${droppedCols} more ${droppedCols === 1 ? 'column' : 'columns'}`)

  return {
    columns: keptColIndexes.map((i) => String(t.columns[i] ?? '')),
    rows: keptRows.map((r) => keptColIndexes.map((i) => truncCell(r?.[i], limits.maxCellChars))),
    total: t.total ? keptColIndexes.map((i) => truncCell(t.total![i], limits.maxCellChars)) : undefined,
    totalRows: declaredTotal,
    fit: {
      droppedRows, droppedCols, keptColIndexes,
      spill: spillBits.length ? `${spillBits.join(' · ')} — view the full report` : undefined,
    },
  }
}

function truncProse(s: string, max: number): string {
  if (s.length <= max) return s
  // Cut at a sentence boundary when one is near the limit, so the image doesn't
  // end mid-clause; otherwise fall back to a hard ellipsis.
  const cut = s.slice(0, max)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut.trimEnd() + '…')
}

export interface FittedAnswer {
  answer: Answer
  fit: FitReport
}

/** Apply the frame to a whole Answer. Returns a COPY — the stored report is never
 *  mutated, so the HTML surface always still has everything. */
export function fitAnswer(a: Answer, limits: FitLimits = DEFAULT_LIMITS): FittedAnswer {
  const notes: string[] = []
  let droppedRows = 0, droppedCols = 0, droppedFigures = 0, droppedSections = 0

  const prose = Array.isArray(a.answer) ? a.answer : a.answer ? [a.answer] : []
  const fittedProse = prose.map((p) => truncProse(String(p), limits.maxProseChars))

  const figures = (a.figures ?? []).slice(0, limits.maxFigures)
  droppedFigures = (a.figures?.length ?? 0) - figures.length

  let table: AnswerTable | undefined
  if (a.table?.columns?.length) {
    const ft = fitTable(a.table, limits)
    droppedRows += ft.fit.droppedRows; droppedCols += ft.fit.droppedCols
    table = ft                       // its spill renders under the table itself
  }

  const srcSections = a.sections ?? []
  const sections: AnswerSection[] = srcSections.slice(0, limits.maxSections).map((s) => {
    if (s.kind === 'table' && s.columns?.length) {
      const ft = fitTable({ columns: s.columns, rows: s.rows ?? [], total: s.total }, limits)
      droppedRows += ft.fit.droppedRows; droppedCols += ft.fit.droppedCols
      return { ...s, columns: ft.columns, rows: ft.rows, total: ft.total, fit: ft.fit } as AnswerSection
    }
    if (s.kind === 'kpis' && s.items?.length) {
      const kept = s.items.slice(0, limits.maxFigures)
      droppedFigures += s.items.length - kept.length
      return { ...s, items: kept }
    }
    if (s.kind === 'text' && s.body) return { ...s, body: truncProse(s.body, limits.maxProseChars) }
    return s
  })
  droppedSections = srcSections.length - sections.length
  if (droppedSections > 0) notes.push(`+${droppedSections} more ${droppedSections === 1 ? 'section' : 'sections'} — view the full report`)
  if (droppedFigures > 0) notes.push(`+${droppedFigures} more ${droppedFigures === 1 ? 'figure' : 'figures'}`)

  const reduced = droppedRows > 0 || droppedCols > 0 || droppedSections > 0 || droppedFigures > 0
    || fittedProse.some((p, i) => p !== String(prose[i]))

  return {
    answer: { ...a, answer: fittedProse.length > 1 ? fittedProse : fittedProse[0], figures, table, sections },
    fit: { reduced, droppedRows, droppedCols, droppedSections, droppedFigures, notes },
  }
}
