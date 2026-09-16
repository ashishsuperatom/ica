// ── A STEP'S ANSWER, IN THE SHAPE THE SURFACES RENDER ────────────────────────────────────────────────────────
// The web app, iOS, Teams and the hub's answer buffer all read `Answer` (clients/protocol.ts): prose, figures,
// sections of tables. A program's answer is data + views + narration + next steps. This turns the second into the
// first, so every surface keeps working while it learns the richer form from `session:step`.

import type { Answer } from '../../../../clients/protocol.js'

type Column = { name: string; role?: string; unit?: string; kind?: string; entity?: string }
type Table = { columns: Column[]; rows: Record<string, unknown>[] }
type Delivered = {
  status?: 'answered' | 'unknowable' | 'uncertain'
  missing?: string
  period?: string
  scope?: string
  headline?: { label: string; display: string }
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
  if (col?.unit === 'currency' || col?.unit === 'money') return typeof row.currency_label === 'string' ? `${row.currency_label} ${n}` : n
  if (col?.unit === 'h') return `${n} h`
  return n
}

/** The columns a person reads: a dimension's label rather than its id, and every measure. */
function readable(t: Table, chosen?: string[]): string[] {
  const names = new Set(t.columns.map((c) => c.name))
  if (chosen?.length) return chosen.map((c) => (names.has(`${c}_label`) ? `${c}_label` : c)).filter((c) => names.has(c))
  return t.columns.filter((c) => c.role !== 'dimension' || !names.has(`${c.name}_label`)).map((c) => c.name)
}

function section(t: Table, title?: string, chosen?: string[]) {
  const cols = readable(t, chosen)
  const meta = new Map(t.columns.map((c) => [c.name, c]))
  // A column of names beside its ids (`X` and `X_label`) reads as the names, and each cell carries its
  // record's id and the column its kind — so a surface can open the record.
  const idOf = (c: string) => (c.endsWith('_label') && meta.has(c.slice(0, -6)) ? c.slice(0, -6) : undefined)
  const entityOf = (c: string) => { const id = idOf(c); return id ? meta.get(id)?.entity ?? id : undefined }
  return {
    kind: 'table' as const, title,
    columns: cols.map((c) => (entityOf(c) ? { label: heading(c), entity: entityOf(c)! } : heading(c))),
    rows: t.rows.slice(0, MAX_ROWS).map((r) => cols.map((c) => {
      const id = idOf(c)
      const shown = display(r[c], meta.get(c), r)
      return id && r[id] != null ? { value: r[c] ?? r[id], display: shown || String(r[id]), id: r[id] as string | number } : shown
    })),
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
  // The narration's points read as a list, one point to a line.
  const points = (a?.narration ?? []).map((s) => s.text)
  const prose = points.length > 1 ? points.map((t) => `- ${t}`).join('\n') : (points[0] ?? '')
  const data = { ...(a?.data ?? {}) }
  const sections: NonNullable<Answer['sections']> = []
  if (a?.headline) sections.push({ kind: 'kpis', items: [{ label: a.headline.label, display: a.headline.display, value: null }] } as any)
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
    // The surfaces draw tables: a dataset two views show (a table and its chart) is drawn once.
    if (!t?.columns || shown.has(v.data!)) continue
    shown.add(v.data!)
    sections.push(section(t, v.title, v.encode?.columns))
  }
  for (const [key, t] of Object.entries(data)) if (!shown.has(key) && t?.columns) sections.push(section(t, heading(key)))
  // What the answer holds for travels with it: its period and scope; an answer that could not be given says why.
  const doubt = a?.status === 'uncertain' && a.missing ? [`Not answered with confidence: ${a.missing}`] : []
  const told = [...doubt, ...caveats]
  return { status: a?.status === 'unknowable' ? 'unknowable' : 'answered', answer: a?.status === 'unknowable' && !prose ? a.missing : prose,
    ...(a?.period ? { period: a.period } : {}), ...(a?.scope ? { scope: a.scope } : {}),
    ...(sections.length ? { sections } : {}), ...(told.length ? { caveat: told.join('\n') } : {}) }
}

export const followupsOf = (a: Delivered | null | undefined): string[] => (a?.nextSteps ?? []).map((s) => s.label).filter(Boolean)

/** A semantic-graph answer — targets then outputs, rows as arrays — as the table surfaces render. */
export function semanticTable(r: { columns: Array<{ name: string; unit?: string }>; rows: unknown[][]; labels?: Record<number, Record<string, string>> } | null | undefined): Table | null {
  if (!r) return null
  // A key reads as its name; groups read in the order of their names.
  const named = (row: unknown[]) => row.map((v, i) => (v !== null && r.labels?.[i]?.[String(v)] !== undefined ? r.labels[i][String(v)] : v))
  const targets = r.columns.filter((c) => !c.unit).length
  const rowsNamed = r.rows.map(named).sort((a, b) => { for (let i = 0; i < targets; i++) { const c = String(a[i] ?? '\uffff').localeCompare(String(b[i] ?? '\uffff'), undefined, { numeric: true }); if (c) return c } return 0 })
  // Headings a person reads: "Month" for "Month by day.month" unless two columns would read the same, "Revenue" for
  // "AllocationDay.revenue", and an expression's measures by their own names.
  const plain = (name: string) => name.includes(' by ') ? name.slice(0, name.indexOf(' by ')) : name.replace(/\[?[A-Z]\w*\.([^\]\s*/+-]+(?: [^\]*/+-]+)*)\]?/g, (_m, measure: string) => measure.trim())
  const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const short = r.columns.map((c) => capital(plain(c.name)))
  const headings = r.columns.map((c, i) => (short.filter((x) => x === short[i]).length > 1 ? c.name : short[i]))
  return {
    columns: r.columns.map((c, i) => ({ name: headings[i], ...(c.unit ? { role: 'measure', unit: c.unit === 'money' ? 'currency' : c.unit } : { role: 'dimension' }) })),
    rows: rowsNamed.map((row) => Object.fromEntries(r.columns.map((_, i) => [headings[i], row[i] ?? '(none)']))),
  }
}
