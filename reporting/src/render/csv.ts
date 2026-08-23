// ── The data behind the report ───────────────────────────────────────────────
// "Download the data" is the escape hatch from every reduction the image makes: the
// CSV is COMPLETE — every row, every column, nothing truncated, nothing re-ordered.
//
// A report can hold more than one table (the top-level one plus any table sections),
// and CSV has no concept of multiple sheets. Rather than silently exporting only the
// first — which would be another quiet truncation — tables are stacked with a blank
// line and a title row between them, which every spreadsheet imports readably.

import type { Answer } from '../types.js'

/** RFC4180: quote when the value contains a delimiter, quote or newline; double any
 *  embedded quotes. A leading =, +, - or @ is prefixed with a quote so a spreadsheet
 *  treats it as text — a cell arriving from a data source must never be executed as
 *  a formula on someone's machine. */
function cell(v: unknown): string {
  if (v == null) return ''
  let s = typeof v === 'number' ? String(v) : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const row = (cells: unknown[]) => cells.map(cell).join(',')

export function answerToCsv(a: Answer, title?: string): string {
  const out: string[] = []
  if (title) { out.push(row([title])); out.push('') }

  const table = (cols: string[], rows: unknown[][], total?: unknown[], name?: string) => {
    if (out.length) out.push('')
    if (name) out.push(row([name]))
    out.push(row(cols))
    for (const r of rows) out.push(row(cols.map((_, i) => r?.[i])))
    if (total) out.push(row(cols.map((_, i) => total[i])))
  }

  if (a.figures?.length) {
    table(['Figure', 'Value', 'Detail'], a.figures.map((f) => [f.label, f.display, f.sub ?? '']), undefined, 'Figures')
  }
  if (a.table?.columns?.length) table(a.table.columns, a.table.rows ?? [], a.table.total)
  for (const s of a.sections ?? []) {
    if (s.kind === 'table' && s.columns?.length) table(s.columns, s.rows ?? [], s.total, s.title)
    else if (s.kind === 'kpis' && s.items?.length) {
      table(['Figure', 'Value', 'Detail'], s.items.map((f) => [f.label, f.display, f.sub ?? '']), undefined, s.title)
    }
  }
  return out.join('\r\n')
}

/** A filename a human can find again in a Downloads folder six weeks later: the
 *  QUESTION, slugged — not "export(3).csv" and not an opaque id.
 *
 *  A short slice of the report id is appended for two reasons: two people asking the
 *  same question get two files rather than "report(1)", and the file can be traced back
 *  to the exact report (and therefore the exact questionId) it came from. */
export function reportFilename(title: string | undefined, id: string, ext: string): string {
  const base = (title ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60).replace(/-$/, '')
  return `${base || 'report'}-${id.slice(0, 8)}.${ext}`
}
