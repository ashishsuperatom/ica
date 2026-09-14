// ── A STEP'S ANSWER, IN THE SHAPE THE SURFACES RENDER ────────────────────────────────────────────────────────
// The web app, iOS, Teams and the hub's answer buffer all read `Answer` (clients/protocol.ts): prose, figures,
// sections of tables. A program's answer is data + views + narration + next steps. This turns the second into the
// first, so every surface keeps working while it learns the richer form from `session:step`.

import type { Answer } from '../../../../clients/protocol.js'

type Column = { name: string; role?: string; unit?: string; kind?: string }
type Table = { columns: Column[]; rows: Record<string, unknown>[] }
type Delivered = {
  data?: Record<string, Table>
  views?: { id?: string; component?: string; data?: string; title?: string; encode?: { columns?: string[] } }[]
  narration?: { text: string }[]
  nextSteps?: { label: string }[]
}

const MAX_ROWS = 200

const heading = (name: string) => name.replace(/_label$/, '').replace(/_/g, ' ')

function display(v: unknown, col: Column | undefined, row: Record<string, unknown>): string {
  if (v === null || v === undefined) return ''
  if (typeof v !== 'number') return String(v)
  if (col?.unit === 'ratio') return `${(v * 100).toLocaleString('en-AU', { maximumFractionDigits: 1 })}%`
  const n = v.toLocaleString('en-AU', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 2 })
  if (col?.unit === 'currency') return typeof row.currency_label === 'string' ? `${row.currency_label} ${n}` : n
  if (col?.unit === 'h') return `${n} h`
  return n
}

/** The columns a person reads: a dimension's label rather than its id, and every measure. */
function readable(t: Table, chosen?: string[]): string[] {
  if (chosen?.length) return chosen.filter((c) => t.columns.some((x) => x.name === c))
  const names = new Set(t.columns.map((c) => c.name))
  return t.columns.filter((c) => c.role !== 'dimension' || !names.has(`${c.name}_label`)).map((c) => c.name)
}

function section(t: Table, title?: string, chosen?: string[]) {
  const cols = readable(t, chosen)
  const meta = new Map(t.columns.map((c) => [c.name, c]))
  return {
    kind: 'table' as const, title,
    columns: cols.map(heading),
    rows: t.rows.slice(0, MAX_ROWS).map((r) => cols.map((c) => display(r[c], meta.get(c), r))),
    ...(t.rows.length > MAX_ROWS ? { note: `First ${MAX_ROWS} of ${t.rows.length} rows` } : {}),
  }
}

export function surfaceAnswer(a: Delivered | Table | null | undefined, caveats: string[] = []): Answer {
  // A relation asked directly answers with its table: no narration, no views — the table is the answer.
  if (a && Array.isArray((a as Table).columns) && Array.isArray((a as Table).rows)) {
    const t = a as Table
    return { status: 'answered', answer: t.rows.length ? '' : 'No rows match this question.', sections: [section(t)], ...(caveats.length ? { caveat: caveats.join('\n') } : {}) }
  }
  a = a as Delivered | null | undefined
  const prose = (a?.narration ?? []).map((s) => s.text).join(' ')
  const data = { ...(a?.data ?? {}) }
  const sections: NonNullable<Answer['sections']> = []
  // Figures: a one-row table of measures (the total a program returns) reads as figures, not a table.
  for (const [key, t] of Object.entries(data)) {
    if (!t?.columns || t.rows?.length !== 1 || t.columns.some((c) => c.role === 'dimension')) continue
    const row = t.rows[0]
    sections.push({ kind: 'kpis', items: t.columns.filter((c) => c.role === 'measure')
      .map((c) => ({ label: heading(c.name), display: display(row[c.name], c, row), value: row[c.name] })) })
    delete data[key]
  }
  const shown = new Set<string>()
  for (const v of a?.views ?? []) {
    const t = v.data ? data[v.data] : undefined
    if (!t?.columns) continue
    shown.add(v.data!)
    sections.push(section(t, v.title, v.encode?.columns))
  }
  for (const [key, t] of Object.entries(data)) if (!shown.has(key) && t?.columns) sections.push(section(t, heading(key)))
  return { status: 'answered', answer: prose, ...(sections.length ? { sections } : {}), ...(caveats.length ? { caveat: caveats.join('\n') } : {}) }
}

export const followupsOf = (a: Delivered | null | undefined): string[] => (a?.nextSteps ?? []).map((s) => s.label).filter(Boolean)
