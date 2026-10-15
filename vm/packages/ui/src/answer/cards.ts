// THE ANSWER CONTRACT — one, everywhere (docs/platform-architecture.md "What a session shows"): an answer is MARKDOWN, and
// a marker line in it names a CARD — a file beside the answer — drawn where the line stands:
//
//   :::table <name>.json                 our table: a list of rows (objects by column), or { title?, columns?, rows }
//   :::period <when> · <what kind>       the time the answer covers (not a card)
//
// ONE GENERIC DATA STRUCTURE, whatever draws it: a card is rows. Each runtime turns it into what it can draw (the web,
// the phone, sacli — no runtime is assumed to have a chart library). A marker of another kind (:::bar, :::line, :::pie,
// :::chart) names the same structure; its kind is kept as a hint for a runtime that draws charts — none does yet, so
// every card is drawn as its table. A card is drawn exactly as written or not at all: one not this shape is an error its
// writer is told (cardFixes), never drawn empty. A file may say more about itself (title, description).
//
// A program's own block carries its own cards (with their `type`: kpis, bars, grid, …: answer/blocks.ts) — a card file
// with a `type` is one of those, not read here.

export type CardKind = 'table'
/** A marker line naming a card: its kind as written (bar, line, pie, chart, table) and its file. */
export const CARD_MARKER = /^\s*:::(table|bar|line|pie|chart)\s+([\w.-]+\.json)\s*$/

export interface TableColumn { key: string; label: string; unit?: string }
export interface TableCard { kind: 'table'; title?: string; description?: string; columns: TableColumn[]; rows: Record<string, unknown>[]; /** The marker's kind when not :::table (bar, line, …): how a runtime that draws charts may draw it. */ hint?: string }
export type Card = TableCard

/** An answer's parts in order: its text, and the cards its marker lines name (a :::period line is neither). */
export type AnswerPart = { text: string } | { marker: string; kind: CardKind; hint: string; file: string }
export function answerParts(markdown: string): AnswerPart[] {
  const out: AnswerPart[] = []
  let buf: string[] = []
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ text: t }); buf = [] }
  for (const line of String(markdown ?? '').split('\n')) {
    if (/^\s*:::(period|answer)\b/.test(line)) continue
    const m = CARD_MARKER.exec(line)
    if (!m) { buf.push(line); continue }
    flush()
    out.push({ marker: line.trim(), kind: 'table', hint: m[1], file: m[2] })
  }
  flush()
  return out
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const words = (k: string) => { const w = k.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(); return w ? w[0].toUpperCase() + w.slice(1) : k }
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

/** A card file read: the card (its marker's kind kept as its hint), or what is wrong with it (in words its writer can act on). */
export function readCard(hint: string, v: unknown): { card: Card } | { problems: string[] } {
  const r = readTable(v)
  return 'card' in r && hint !== 'table' ? { card: { ...r.card, hint } } : r
}

function readTable(v: unknown): { card: TableCard } | { problems: string[] } {
  const given = Array.isArray(v) ? { rows: v } : v
  if (!isObj(given)) return { problems: ['a table is a list of rows, or { "columns": [...], "rows": [...] }'] }
  const bad: string[] = []
  if (!Array.isArray(given.rows)) return { problems: ['a table has "rows": a list of rows, each an object by column'] }
  const rows = given.rows as unknown[]
  const notRow = rows.find((r) => !isObj(r))
  if (notRow !== undefined) bad.push(`each row is an object by column ({"month": "2026-02", "amount": 125000}), not ${Array.isArray(notRow) ? 'a list' : 'a plain value'}`)
  let columns: TableColumn[]
  if (given.columns === undefined) columns = [...new Set(rows.filter(isObj).flatMap((r) => Object.keys(r)))].map((key) => ({ key, label: words(key) }))
  else if (!Array.isArray(given.columns) || given.columns.some((c) => !isObj(c) || !text(c.key))) { bad.push('"columns" is a list of { "key": <a row\'s field>, "label": "…" } (or leave it out: the rows\' fields)'); columns = [] }
  else columns = (given.columns as Record<string, unknown>[]).map((c) => ({ key: String(c.key), label: text(c.label) ?? words(String(c.key)), ...(text(c.unit) ? { unit: text(c.unit) } : {}) }))
  if (!bad.length && rows.length && columns.length && !columns.some((c) => rows.some((r) => isObj(r) && c.key in r))) bad.push(`no row has any of the columns' keys (${columns.map((c) => c.key).join(', ')})`)
  if (bad.length) return { problems: bad }
  return { card: { kind: 'table', ...(text(given.title) ? { title: text(given.title) } : {}), ...(text(given.description) ? { description: text(given.description) } : {}), columns, rows: rows as Record<string, unknown>[] } }
}

/** What to tell the one who wrote cards that do not pass: each file and what is wrong — the contract itself, said once. */
export function cardFixes(bad: { file: string; problems: string[] }[]): string | null {
  if (!bad.length) return null
  return [...bad.map((b) => `- ${b.file}: ${b.problems.join('; ')}`), '', 'A card\'s file is a list of rows (objects by column), or { "title", "columns": [{ "key", "label" }], "rows" }.'].join('\n')
}
