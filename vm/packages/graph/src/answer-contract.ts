// ── WHAT A QUESTION'S PROGRAM GIVES BACK ──────────────────────────────────────────────────────────────────
//
// The people asking make decisions. A question's program — `returns: 'answer'` — gives them more than numbers:
//
//   data        the datasets the answer rests on, each with columns that say what they are
//   views       how each is shown: a component, the dataset it reads, and which column plays which part
//   narration   what the view says, sentence by sentence, with the numbers it rests on
//   nextSteps   what the person could ask next, each a message their data session can apply
//
// THE NUMBERS IN A NARRATION ARE NEVER TYPED. A sentence names slots — "Utilisation fell to {june}" — and each slot
// cites a cell: a dataset, the row it is in, the column. The engine reads the cell and writes the number. A narration
// that cites a cell which does not exist, or a row that is not there, is refused; so a sentence cannot state a number
// the data does not hold, however it was written — by a program, or by a model asked to explain.
//
// Views name components by what they are ('table', 'line', 'bar', 'kpi', 'pivot', or one of the organisation's own),
// and bind roles to columns. The engine checks that every column bound exists; how a component draws is the display's.

import type { Column, Result } from './execute.js'
import type { Message } from './session.js'

export interface Cell {
  data: string
  /** The row: its position in the dataset (1 is the first), or the values that pick it out — `{ month: '2026-06' }`. */
  row?: number | Record<string, unknown>
  column: string
  /** How the number is written. Defaults from the column's unit. */
  format?: 'number' | 'integer' | 'percent' | 'currency' | 'hours' | 'date' | 'text'
}

export interface Sentence {
  /** The sentence, with {slot} where each number goes. */
  text: string
  cites?: Record<string, Cell>
  /** Why this is said: the reasoning a person can open. */
  why?: string
}

export interface View {
  id: string
  component: string
  data: string
  title?: string
  /** Which column plays which part: { x: 'month', y: 'utilisation', series: 'pillar' }. */
  encode: Record<string, string | string[]>
}

export interface NextStep {
  label: string
  message: Message
  why?: string
}

export interface Answer {
  data: Record<string, Result>
  views: View[]
  narration: Sentence[]
  nextSteps: NextStep[]
}

/** A sentence as delivered: its text with every slot written from the data, and the cells it read. */
export interface Rendered { text: string; why?: string; values: Record<string, { value: unknown; cell: Cell; rowIndex: number }> }
export interface DeliveredAnswer extends Omit<Answer, 'narration'> { narration: Rendered[] }

const isResult = (d: unknown): d is Result => !!d && Array.isArray((d as Result).columns) && Array.isArray((d as Result).rows)

/** Why an answer cannot be given as it is, or null. */
export function answerProblem(a: unknown): string | null {
  if (!a || typeof a !== 'object') return 'an answer is { data, views, narration, nextSteps }'
  const x = a as Answer
  if (!x.data || typeof x.data !== 'object') return 'an answer needs data: named datasets, each { columns, rows }'
  for (const [name, d] of Object.entries(x.data)) if (!isResult(d)) return `dataset "${name}" must be { columns, rows }`
  if (!Array.isArray(x.views) || !Array.isArray(x.narration) || !Array.isArray(x.nextSteps)) return 'an answer needs views, narration and nextSteps, each a list (empty is allowed)'
  const ids = new Set<string>()
  for (const v of x.views) {
    if (!v?.id || ids.has(v.id)) return `each view needs its own id`
    ids.add(v.id)
    if (typeof v.component !== 'string' || !v.component) return `view "${v.id}" needs a component`
    const d = x.data[v.data]
    if (!d) return `view "${v.id}" shows "${v.data}", which is not in the data`
    const names = new Set(d.columns.map((c: Column) => c.name))
    for (const [role, cols] of Object.entries(v.encode ?? {})) {
      for (const c of Array.isArray(cols) ? cols : [cols]) if (!names.has(c)) return `view "${v.id}" puts "${c}" as ${role}, and "${v.data}" has no such column — it has ${[...names].join(', ')}`
    }
  }
  for (const s of x.nextSteps) {
    if (!s?.label || !s.message || typeof s.message !== 'object') return 'each next step needs a label and a message'
  }
  for (const [i, s] of x.narration.entries()) {
    if (typeof s?.text !== 'string') return `sentence ${i + 1} has no text`
    const slots = [...s.text.matchAll(/\{([a-zA-Z_][\w]*)\}/g)].map((m) => m[1])
    for (const slot of slots) if (!s.cites?.[slot]) return `sentence ${i + 1} has a slot {${slot}} that cites nothing`
    // A number typed into the sentence would be a number nothing checks.
    const typed = s.text.replace(/\{[a-zA-Z_][\w]*\}/g, '').match(/(?<![\w-])\d[\d,]*(\.\d+)?%?/g)?.filter((n) => !/^(19|20)\d\d$/.test(n))
    if (typed?.length) return `sentence ${i + 1} types the number ${typed[0]} — every number in a narration must be a slot that cites its cell`
  }
  return null
}

/** The narration written out from the data: each slot read from its cell. Throws when a cell cannot be found. */
export function renderAnswer(a: Answer): DeliveredAnswer {
  const narration = a.narration.map((s, i) => {
    const values: Rendered['values'] = {}
    for (const [slot, cell] of Object.entries(s.cites ?? {})) {
      const d = a.data[cell.data] ?? fail(`sentence ${i + 1}: {${slot}} cites "${cell.data}", which is not in the data`)
      const col = d.columns.find((c) => c.name === cell.column) ?? fail(`sentence ${i + 1}: {${slot}} cites column "${cell.column}", which "${cell.data}" does not have`)
      let rowIndex: number
      if (cell.row == null) {
        if (d.rows.length !== 1) fail(`sentence ${i + 1}: {${slot}} names no row, and "${cell.data}" has ${d.rows.length}`)
        rowIndex = 0
      } else if (typeof cell.row === 'number') {
        if (!d.rows[cell.row - 1]) fail(`sentence ${i + 1}: {${slot}} cites row ${cell.row}, and "${cell.data}" has ${d.rows.length}`)
        rowIndex = cell.row - 1
      } else {
        const matches = d.rows.map((r, k) => [r, k] as const).filter(([r]) => Object.entries(cell.row as object).every(([k, v]) => String(r[k]) === String(v)))
        if (matches.length !== 1) fail(`sentence ${i + 1}: {${slot}} picks ${JSON.stringify(cell.row)}, which matches ${matches.length} rows of "${cell.data}"`)
        rowIndex = matches[0][1]
      }
      values[slot] = { value: d.rows[rowIndex][col.name], cell, rowIndex }
    }
    const text = s.text.replace(/\{([a-zA-Z_][\w]*)\}/g, (_m, slot) => {
      const { value, cell } = values[slot]
      const col = a.data[cell.data].columns.find((c) => c.name === cell.column)!
      return write(value, cell.format ?? formatFor(col))
    })
    return { text, ...(s.why ? { why: s.why } : {}), values }
  })
  return { ...a, narration }
}

function fail(msg: string): never { throw new Error(msg) }

function formatFor(c: Column): NonNullable<Cell['format']> {
  if (c.role !== 'measure') return 'text'
  if (c.unit === 'ratio' || c.unit === 'share') return 'percent'
  if (c.unit === 'h') return 'hours'
  if (c.unit && /^[A-Z]{3}$/.test(c.unit)) return 'currency'
  return 'number'
}

function write(v: unknown, format: NonNullable<Cell['format']>): string {
  if (v == null) return 'no value'
  if (format === 'text' || format === 'date') return String(v)
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  const grouped = (x: number, digits: number) => x.toLocaleString('en', { maximumFractionDigits: digits })
  if (format === 'percent') return `${grouped(n * 100, 1)}%`
  if (format === 'integer') return grouped(Math.round(n), 0)
  if (format === 'hours') return `${grouped(n, 0)} h`
  if (format === 'currency') return grouped(n, 0)
  return grouped(n, Math.abs(n) >= 100 ? 0 : 2)
}
