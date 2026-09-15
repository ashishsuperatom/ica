// ── ANSWER PROGRAMS: WHAT A PERSON READS, BUILT ON THE GRAPH ────────────────────────────────────────────────
//
// A program is a module with two exports:
//
//   meta     { name, description, params: { name: what it means }, logic }
//   default  async (ctx, params) => { headline?, data, views, narration, nextSteps }
//
// Its only data is what it asks the graph — ctx.ask(question) — so every number rests on a checked, recorded question.
// Everything else is the program's: how the answers are combined and ranked (ctx.transform), which way it went and why
// (ctx.decide, ctx.decideAt), what must hold for the answer to mean anything (ctx.verify), what a reader must know
// (ctx.caveat), and progress for the person waiting (ctx.explain). Each is a recorded step, so how an answer was reached
// is read from memory, never reconstructed.
//
// The answer it returns is checked before anyone sees it: every view shows columns its dataset has, every number in the
// narration is a {slot} that cites a cell, and a sentence that types a number is refused.

import { randomUUID } from 'node:crypto'
import type { createGraph, AskOptions } from './runtime.js'
import type { QuestionAsked } from './time.js'

export interface ProgramMeta { name: string; description: string; params?: Record<string, string>; logic?: string }

export interface Table {
  /** A dimension column that holds records says which kind (`entity`); its names are beside it as `<name>_label`. */
  columns: Array<{ name: string; role: 'dimension' | 'measure'; unit?: string; entity?: string }>
  rows: Array<Record<string, unknown>>
  /** Notes a reader needs about these numbers. */
  notes?: string[]
}
export interface ProgramCell { data: string; /** A row by its index from 0, or by the values that pick it out. */ row?: number | Record<string, unknown>; column: string; format?: 'number' | 'integer' | 'percent' | 'money' | 'hours' | 'text' }
export interface ProgramAnswer {
  headline?: { label: string; value: ProgramCell }
  data: Record<string, Table>
  views: Array<{ id: string; component: string; data: string; title?: string; encode: Record<string, string | string[]> }>
  narration: Array<{ text: string; cites?: Record<string, ProgramCell>; why?: string }>
  nextSteps: Array<{ label: string; why?: string }>
}
export type ProgramStep =
  | { kind: 'ask'; label: string; callId: string; rows?: number; refused?: string }
  | { kind: 'transform'; label: string; result: string }
  | { kind: 'decide'; label: string; took: boolean; reason: string; boundary?: { value: number; op: string; threshold: number; margin: number } }
  | { kind: 'verify'; label: string; held: boolean; detail?: string }
  | { kind: 'caveat'; text: string }
  | { kind: 'explain'; text: string }

export class AnswerRefused extends Error {}
const refuse = (m: string): never => { throw new AnswerRefused(m) }

type Graph = ReturnType<typeof createGraph>

/** Run a program's module text with parameters; record the run and every step; return the checked answer. */
export async function runProgram(graph: Graph, source: string, params: Record<string, unknown>, a: AskOptions & { onExplain?: (text: string) => void }) {
  const runId = randomUUID()
  const started = Date.now()
  const steps: ProgramStep[] = []
  const notes: string[] = []
  let meta: ProgramMeta | undefined
  let delivered: ReturnType<typeof deliver> | undefined
  let error: string | undefined
  const summary = (v: unknown) => Array.isArray(v) ? `${v.length} items` : v && typeof v === 'object' ? `{ ${Object.keys(v).slice(0, 6).join(', ')} }` : String(v)
  try {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
    meta = mod.meta
    if (!meta?.name || !meta.description) refuse('a program exports meta: { name, description, params, logic }')
    if (typeof mod.default !== 'function') refuse('a program exports default async (ctx, params) => answer')
    const ctx = {
      today: a.today,
      /** A question of the graph: its rows with each dimension by name and each measure by name. Refused questions throw. */
      ask: async (question: QuestionAsked, label = 'question') => {
        const r = await graph.ask(question, { ...a, parentId: runId })
        if (!r.ok) { steps.push({ kind: 'ask', label, callId: r.callId, refused: r.reason }); refuse(`"${label}" was refused: ${r.reason}`) }
        const answered = r as Extract<typeof r, { ok: true }>
        const table = tableOf(answered.result)
        steps.push({ kind: 'ask', label, callId: answered.callId, rows: table.rows.length })
        for (const n of table.notes ?? []) if (!notes.includes(n)) notes.push(n)
        return table
      },
      transform: <T>(label: string, fn: () => T): T => { const out = fn(); steps.push({ kind: 'transform', label, result: summary(out) }); return out },
      decide: (label: string, took: boolean, reason: string) => { steps.push({ kind: 'decide', label, took, reason }); return took },
      decideAt: (label: string, value: number, op: '<' | '<=' | '>' | '>=', threshold: number, reason = '') => {
        const took = op === '<' ? value < threshold : op === '<=' ? value <= threshold : op === '>' ? value > threshold : value >= threshold
        steps.push({ kind: 'decide', label, took, reason, boundary: { value, op, threshold, margin: value - threshold } })
        return took
      },
      verify: async (label: string, holds: () => boolean | Promise<boolean>, detail?: string) => {
        const held = !!(await holds())
        steps.push({ kind: 'verify', label, held, ...(detail ? { detail } : {}) })
        if (!held) refuse(`the check "${label}" does not hold${detail ? ` — ${detail}` : ''}`)
      },
      caveat: (text: string) => { steps.push({ kind: 'caveat', text }); if (!notes.includes(text)) notes.push(text) },
      explain: (text: string) => { steps.push({ kind: 'explain', text }); a.onExplain?.(text) },
    }
    const answer = await mod.default(ctx, params)
    delivered = deliver(answer, notes)
  } catch (e: any) {
    error = e?.message ?? String(e)
  }
  graph.store.recordCall({
    id: runId, parentId: null, sessionId: a.sessionId ?? null, question: { program: meta?.name ?? '(unnamed)', params }, canonical: null,
    plan: { program: meta ?? null, steps, source }, schema: graph.model(a.model).schemaHash, sources: graph.model(a.model).sourcesHash, settings: graph.model(a.model).settingsHash,
    output: delivered ?? null, refusal: error ? { rule: 'program', reason: error } : null, error: null, statements: [], caveats: notes, ms: Date.now() - started,
    at: started, today: a.today ?? '', asOf: null, who: a.who ?? null, assumptions: null, interventions: null, nodes: [],
  })
  return { callId: runId, meta, steps, answer: delivered, error }
}

/** A graph answer as a program works with it: rows as records, a measure by its own name, a dimension by its key — the id
 *  a question, a parameter or a canonical view names it by — with its name beside it as `<dimension>_label`. */
export function tableOf(r: { columns: Array<{ name: string; unit?: string }>; rows: unknown[][]; labels?: Record<number, Record<string, string>>; notes?: string[] }): Table {
  const plain = (name: string) => name.includes(' by ') ? name.slice(0, name.indexOf(' by ')) : name.replace(/\[?[A-Z]\w*\.([^\]\s*/+-]+(?: [^\]*/+-]+)*)\]?/g, (_m, measure: string) => measure.trim())
  const short = r.columns.map((c) => plain(c.name))
  const names = r.columns.map((c, i) => (short.filter((x) => x === short[i]).length > 1 ? c.name : short[i]))
  const labelled = (i: number) => !r.columns[i].unit && !!r.labels?.[i]
  return {
    columns: r.columns.flatMap((c, i) => [
      { name: names[i], role: c.unit ? 'measure' as const : 'dimension' as const, ...(c.unit ? { unit: c.unit } : {}), ...(labelled(i) ? { entity: plain(c.name) } : {}) },
      ...(labelled(i) ? [{ name: `${names[i]}_label`, role: 'dimension' as const }] : []),
    ]),
    rows: r.rows.map((row) => Object.fromEntries(row.flatMap((v, i) => [
      [names[i], v],
      ...(labelled(i) ? [[`${names[i]}_label`, v === null ? null : r.labels![i][String(v)] ?? String(v)]] : []),
    ]))),
    ...(r.notes?.length ? { notes: r.notes } : {}),
  }
}

/** The answer checked and its narration written from its cells. */
export function deliver(answer: ProgramAnswer, notes: string[]) {
  if (!answer || typeof answer !== 'object' || !answer.data || typeof answer.data !== 'object') refuse('a program returns { headline?, data, views, narration, nextSteps }')
  for (const [name, t] of Object.entries(answer.data)) {
    if (!Array.isArray(t?.columns) || !Array.isArray(t?.rows)) refuse(`dataset "${name}" is { columns, rows } — ctx.ask returns one, and a transformed one keeps that shape`)
    for (const c of t.columns) if (!c?.name || !['dimension', 'measure'].includes(c.role)) refuse(`dataset "${name}": each column has a name and a role, dimension or measure`)
  }
  const views = answer.views ?? []
  const ids = new Set<string>()
  for (const v of views) {
    if (!v?.id || ids.has(v.id)) refuse('each view has its own id')
    ids.add(v.id)
    const t = (typeof v.data === 'string' ? answer.data[v.data] : undefined) ?? refuse(`view "${v.id}" names its dataset by key, one of ${Object.keys(answer.data).join(', ')}`)
    const cols = t.columns.map((c) => c.name)
    for (const [role, names] of Object.entries(v.encode ?? {})) for (const n of [names].flat()) if (!cols.includes(n)) refuse(`view "${v.id}" puts "${n}" as ${role}, and "${v.data}" has ${cols.join(', ')}`)
  }
  const cell = (c: ProgramCell, where: string) => {
    const t = answer.data[c.data] ?? refuse(`${where} cites "${c.data}", which is not in the data`)
    const col = t.columns.find((x) => x.name === c.column) ?? refuse(`${where} cites the column "${c.column}", and "${c.data}" has ${t.columns.map((x) => x.name).join(', ')}`)
    let row: Record<string, unknown> | undefined
    if (c.row === undefined) { if (t.rows.length !== 1) refuse(`${where} names no row, and "${c.data}" has ${t.rows.length}`); row = t.rows[0] }
    else if (typeof c.row === 'number') row = t.rows[c.row] ?? refuse(`${where} cites row ${c.row}, and "${c.data}" has rows 0 to ${t.rows.length - 1}`)
    else {
      const hits = t.rows.filter((r) => Object.entries(c.row as object).every(([k, v]) => String(r[k]) === String(v)))
      if (hits.length !== 1) refuse(`${where} picks ${JSON.stringify(c.row)}, which matches ${hits.length} rows of "${c.data}"`)
      row = hits[0]
    }
    const label = col.role === 'dimension' && t.columns.some((x) => x.name === `${col.name}_label`) ? row![`${col.name}_label`] : undefined
    return label !== undefined && !c.format ? String(label ?? 'none') : write(row![col.name], c.format ?? formatOf(col))
  }
  const narration = (answer.narration ?? []).map((s, i) => {
    if (typeof s?.text !== 'string') refuse(`sentence ${i + 1} has no text`)
    const typed = s.text.replace(/\{[a-zA-Z_]\w*\}/g, '').match(/(?<![\w-])\d[\d,]*(\.\d+)?%?/g)?.map((n) => n.replace(/,$/, '')).filter((n) => !/^(19|20)\d\d$/.test(n))
    if (typed?.length) refuse(`sentence ${i + 1} types the number ${typed[0]} — every number is a {slot} citing its cell`)
    const text = s.text.replace(/\{([a-zA-Z_]\w*)\}/g, (_m, slot: string) => cell(s.cites?.[slot] ?? refuse(`sentence ${i + 1}: {${slot}} cites nothing`), `sentence ${i + 1} {${slot}}`))
    return { text, ...(s.why ? { why: s.why } : {}) }
  })
  const headline = answer.headline ? { label: answer.headline.label, display: cell(answer.headline.value, 'the headline'), value: null } : undefined
  return {
    ...(headline ? { headline } : {}),
    data: Object.fromEntries(Object.entries(answer.data).map(([k, t]) => [k, { columns: t.columns, rows: t.rows }])),
    views, narration, nextSteps: (answer.nextSteps ?? []).filter((n) => n?.label), notes,
  }
}

function formatOf(c: { role: string; unit?: string }): NonNullable<ProgramCell['format']> {
  if (c.role !== 'measure') return 'text'
  if (c.unit === 'ratio') return 'percent'
  if (c.unit === 'h') return 'hours'
  if (c.unit === 'money') return 'money'
  return 'number'
}
function write(v: unknown, format: NonNullable<ProgramCell['format']>): string {
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
