// ── AN ANSWER A PERSON READS: DATA, VIEWS, NARRATION, NEXT STEPS ────────────────────────────────────────────────
//
// People make decisions; an answer gives them more than a table:
//
//   data        named datasets — each a recorded answer, so every number shown has its question, plan and SQL behind it
//   views       how each dataset is shown: a component and which column plays which part
//   narration   what the views say, sentence by sentence
//   nextSteps   what the person could ask next — each a move on a dataset's question, checked by the algebra
//
// THE NUMBERS IN A NARRATION ARE NEVER TYPED. A sentence names slots — "October hours fell to {oct}" — and each slot cites
// a cell: a dataset, the group it is in (by its keys, not its position), the column. The number is read from the cell and
// written by its unit. A sentence that types a number, cites a cell that is not there, or a group that is not in the
// data is refused — so a narration cannot state a number the data does not hold, whoever wrote it.

import type { Question } from './algebra.js'
import type { Result } from './evaluate.js'
import { applyMove, type Move } from './moves.js'
import type { Schema } from './schema.js'
import type { CallRecord } from './store.js'

export interface Cell { data: string; group?: Array<string | null>; column: string; format?: 'number' | 'integer' | 'percent' | 'money' | 'hours' | 'text' }
export interface Sentence { text: string; cites?: Record<string, Cell>; why?: string }
export interface View { id: string; component: string; data: string; title?: string; encode: Record<string, string | string[]> }
export interface NextStep { label: string; data: string; move: Move; why?: string }
export interface AnswerDoc { data: Record<string, { callId: string }>; views: View[]; narration: Sentence[]; nextSteps: NextStep[] }

export interface Delivered {
  data: Record<string, { callId: string; question: unknown; result: Result }>
  views: View[]
  narration: Array<{ text: string; why?: string; values: Record<string, { value: unknown; cell: Cell }> }>
  nextSteps: Array<NextStep & { question: Question }>
}

export class AnswerError extends Error {}
const fail = (m: string): never => { throw new AnswerError(m) }

/** The answer with every dataset read from memory, every view's columns checked, every slot written from its cell and
 *  every next step checked as a move — or the first reason it cannot be given. */
export function renderAnswer(s: Schema, doc: AnswerDoc, getCall: (id: string) => CallRecord | null): Delivered {
  if (!doc || typeof doc !== 'object' || !doc.data || !Array.isArray(doc.views) || !Array.isArray(doc.narration) || !Array.isArray(doc.nextSteps)) fail('an answer is { data, views, narration, nextSteps }')
  const data: Delivered['data'] = {}
  for (const [name, ref] of Object.entries(doc.data)) {
    const c = getCall(ref.callId) ?? fail(`dataset "${name}" is the answer ${ref.callId}, which memory does not hold`)
    if (!c.output) fail(`dataset "${name}" is the answer ${ref.callId}, which ${c.refusal ? `was refused: ${c.refusal.reason}` : c.error ? `failed: ${c.error}` : 'memory keeps no rows of'}`)
    if ((c.output as any).truncated) fail(`dataset "${name}" is an answer memory keeps only part of; ask it again to show it`)
    data[name] = { callId: ref.callId, question: c.question, result: c.output as Result }
  }
  const ids = new Set<string>()
  for (const v of doc.views) {
    if (!v?.id || ids.has(v.id)) fail('each view has its own id')
    ids.add(v.id)
    if (!v.component) fail(`view "${v.id}" names a component`)
    const d = data[v.data] ?? fail(`view "${v.id}" shows "${v.data}", which is not in the data`)
    const names = d.result.columns.map((c) => c.name)
    for (const [role, cols] of Object.entries(v.encode ?? {})) for (const col of [cols].flat()) if (!names.includes(col)) fail(`view "${v.id}" puts "${col}" as ${role}, and "${v.data}" has no such column — it has ${names.join(', ')}`)
  }
  const narration = doc.narration.map((sentence, i) => {
    if (typeof sentence?.text !== 'string') fail(`sentence ${i + 1} has no text`)
    const slots = [...sentence.text.matchAll(/\{([a-zA-Z_]\w*)\}/g)].map((m) => m[1])
    for (const slot of slots) if (!sentence.cites?.[slot]) fail(`sentence ${i + 1} has a slot {${slot}} that cites nothing`)
    const typed = sentence.text.replace(/\{[a-zA-Z_]\w*\}/g, '').match(/(?<![\w-])\d[\d,]*(\.\d+)?%?/g)?.filter((n) => !/^(19|20)\d\d$/.test(n))
    if (typed?.length) fail(`sentence ${i + 1} types the number ${typed[0]} — every number in a narration is a slot that cites its cell`)
    const values: Record<string, { value: unknown; cell: Cell }> = {}
    for (const [slot, cell] of Object.entries(sentence.cites ?? {})) {
      const d = data[cell.data] ?? fail(`sentence ${i + 1}: {${slot}} cites "${cell.data}", which is not in the data`)
      const col = d.result.columns.findIndex((c) => c.name === cell.column)
      if (col < 0) fail(`sentence ${i + 1}: {${slot}} cites the column "${cell.column}", which "${cell.data}" does not have`)
      const n = d.result.columns.filter((c) => c.unit === undefined).length
      const rows = cell.group ? d.result.rows.filter((r) => cell.group!.every((k, j) => r[j] === k)) : d.result.rows
      if (!cell.group && rows.length !== 1) fail(`sentence ${i + 1}: {${slot}} names no group, and "${cell.data}" has ${rows.length}`)
      if (cell.group && cell.group.length !== n) fail(`sentence ${i + 1}: {${slot}} names a group of ${cell.group.length} keys, and "${cell.data}" is grouped by ${n}`)
      if (rows.length !== 1) fail(`sentence ${i + 1}: {${slot}} cites the group ${JSON.stringify(cell.group)}, which is not in "${cell.data}"`)
      values[slot] = { value: rows[0][col], cell }
    }
    const text = sentence.text.replace(/\{([a-zA-Z_]\w*)\}/g, (_m, slot: string) => {
      const { value, cell } = values[slot]
      const column = data[cell.data].result.columns.find((c) => c.name === cell.column)!
      return write(value, cell.format ?? formatFor(column.unit))
    })
    return { text, ...(sentence.why ? { why: sentence.why } : {}), values }
  })
  const nextSteps = doc.nextSteps.map((step) => {
    if (!step?.label || !step.move) fail('each next step has a label and a move')
    const d = data[step.data] ?? fail(`the next step "${step.label}" moves from "${step.data}", which is not in the data`)
    const moved = applyMove(s, d.question as Question, step.move)
    if (!moved.verdict.ok) fail(`the next step "${step.label}" would be refused: ${moved.verdict.reason}`)
    return { ...step, question: moved.question }
  })
  return { data, views: doc.views, narration, nextSteps }
}

function formatFor(unit?: string): NonNullable<Cell['format']> {
  if (!unit) return 'text'
  if (unit === 'ratio') return 'percent'
  if (unit === 'h') return 'hours'
  if (unit === 'money') return 'money'
  return 'number'
}

function write(v: unknown, format: NonNullable<Cell['format']>): string {
  if (v == null) return 'no value'
  if (format === 'text') return String(v)
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  const grouped = (x: number, digits: number) => x.toLocaleString('en', { maximumFractionDigits: digits })
  if (format === 'percent') return `${grouped(n * 100, 1)}%`
  if (format === 'integer') return grouped(Math.round(n), 0)
  if (format === 'hours') return `${grouped(n, 0)} h`
  if (format === 'money') return grouped(n, 0)
  return grouped(n, Math.abs(n) >= 100 ? 0 : 2)
}

/** How an answer was reached, read from memory: every line is something that happened. */
export function trace(getCall: (id: string) => CallRecord | null, children: (id: string) => CallRecord[], callId: string, options: { sql?: boolean } = {}, indent = ''): string {
  const c = getCall(callId)
  if (!c) return `${indent}(no call ${callId})`
  const lines = [
    `${indent}${c.refusal ? `refused (${c.refusal.rule}): ${c.refusal.reason}` : c.error ? `failed: ${c.error}` : `answered in ${c.ms} ms`} — ${JSON.stringify(c.question)}`,
    `${indent}  as of ${c.today}${c.who ? `, asked by ${JSON.stringify(c.who)}` : ''}; on ${c.schema}${c.sources ? `, ${c.sources}` : ''}${c.settings ? `, ${c.settings}` : ''}`,
    ...(c.programs && Object.keys(c.programs).length ? [`${indent}  programs: ${Object.entries(c.programs).map(([n, h]) => `${n} ${h}`).join(', ')}`] : []),
    ...(c.assumptions ?? []).map((x) => `${indent}  setting ${x.name} = ${JSON.stringify(x.value)} (from ${x.from}${x.rule ? `, rule ${JSON.stringify(x.rule)}` : ''})`),
    ...(c.interventions ? [`${indent}  hypothetical: ${JSON.stringify(c.interventions)}`] : []),
    ...c.caveats.map((x) => `${indent}  note: ${x}`),
    ...c.statements.map((x) => `${indent}  read ${x.fact} from ${x.source}: ${x.rows} rows in ${x.ms} ms${x.capped ? ' — cut short by the source' : ''}${options.sql && x.sql ? `\n${indent}    ${x.sql.replace(/\n/g, `\n${indent}    `)}` : ''}`),
    ...(c.surprises ?? []).map((x) => `${indent}  surprise: ${x.output} for ${JSON.stringify(x.group)} in ${x.period} is ${x.value}, expected about ${x.median}`),
  ]
  for (const child of children(callId)) lines.push(trace(getCall, children, child.id, options, `${indent}  `))
  return lines.join('\n')
}
