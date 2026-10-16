// ── The answer card — markdown with marker lines, as the one answer component draws it ─────────────────────────────
//
// An answer is markdown; a marker line names a card (the contract: @superatom/ui/cards — `:::table <name>.json`, rows:
// one generic structure every surface turns into what it draws). The card is the named file in a thread's folder (an
// agent's answer) or carried with the answer (a program's — whose own cards carry their `type`: kpis, bars, grid, …).
// Every surface takes the answer in one shape (clients/protocol.ts Answer): the markdown as written and each card as rows.

import type { Answer, AnswerCard } from '../../../clients/protocol.js'
import { fmt } from '@superatom/ui/format'
import { checkBlock } from '@superatom/ui/blocks'
import { readCard, cardFixes, markerOf } from '@superatom/ui/cards'


/** A card a marker names: what it is (a contract card or a program's), or why it cannot be drawn. */
export interface SaidBlock { marker: string; block: Record<string, unknown> | null; error?: string; /** A contract card that is not its shape: its file and what is wrong, for its writer. */ file?: string; problems?: string[] }

// any card a marker names: a file (an agent's, `rows.json`) or a block a program carries by name (`req-kpis`), of any kind
// a program draws — not only the few an agent writes
const KIND: Record<string, string> = { bar: 'bars', bars: 'bars', line: 'bars', table: 'table', kpis: 'kpis', figure: 'figure', facts: 'facts', text: 'text' }

/** A field's words for a column label: `quotes_received` → Quotes received. */
const labelOf = (key: string) => { const w = key.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim(); return w ? w[0].toUpperCase() + w.slice(1) : key }
/** The columns a list of rows has: every field, in the order first seen. */
const columnsOf = (rows: Record<string, unknown>[]) => [...new Set(rows.flatMap((r) => Object.keys(r)))].map((key) => ({ key, label: labelOf(key) }))
const isRow = (r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object' && !Array.isArray(r)

/** One block as a marker names it: the marker's kind wins over the block's `type`; a line series is bars with every
 *  series drawn as a line. A bare list of rows is a table (its columns the rows' fields, its title the file's name), and
 *  a table with rows but no columns takes them from its rows. */
export function blockFor(kind: string, v: unknown, name = ''): Record<string, unknown> {
  if (Array.isArray(v)) {
    if (!v.every(isRow)) throw new Error('a list that is not rows')
    v = { title: labelOf(name.replace(/\.json$/, '')), columns: columnsOf(v), rows: v }
    kind = kind === 'table' || !KIND[kind] || ['bar', 'bars', 'line'].includes(kind) ? 'table' : kind
  }
  if (!v || typeof v !== 'object') throw new Error('not a block object')
  const b: Record<string, unknown> = { ...(v as Record<string, unknown>), type: KIND[kind] ?? (v as any).type }
  if (kind === 'line' && Array.isArray(b.series)) b.series = (b.series as any[]).map((x) => ({ ...x, line: true }))
  if (kind === 'line' && !b.series && Array.isArray(b.rows) && (b.rows as any[])[0]?.values) b.series = Object.keys((b.rows as any[])[0].values).map((k) => ({ key: k, label: k, line: true }))
  if (b.type === 'bars' && !b.series && Array.isArray(b.rows) && (b.rows as any[])[0]?.values) b.series = Object.keys((b.rows as any[])[0].values).map((k) => ({ key: k, label: k }))
  if (b.type === 'table' && !Array.isArray(b.rows)) throw new Error('a table has rows')
  if (b.type === 'table' && (!Array.isArray(b.columns) || !(b.columns as unknown[]).length)) b.columns = columnsOf((b.rows as unknown[]).filter(isRow))
  return b
}

/** Every block a markdown's marker lines name, in order, each read by `read(name)`. */
export async function blocksOf(markdown: string, read: (name: string) => unknown | Promise<unknown>): Promise<SaidBlock[]> {
  const out: SaidBlock[] = []
  for (const line of markdown.split('\n')) {
    const mk = markerOf(line.trim()); if (!mk) continue
    const marker = line.trim(), m = [marker, mk.kind, mk.name] as const
    if (mk.problem) { out.push({ marker, block: null, error: mk.problem }); continue }
    try {
      const v = await read(m[2])
      // a program's own card carries its type (answer/blocks.ts); any other is read by the contract
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof (v as any).type === 'string' || !mk.card) {
        const block = blockFor(m[1], v, m[2]), bad = checkBlock(block)
        out.push(bad.length ? { marker, block: null, error: `${m[2]}: ${bad.join('; ')}` } : { marker, block })
      } else {
        const r = readCard(m[1], v)
        // a card that names no title is headed by its file's name, in words
        out.push('card' in r ? { marker, block: { ...r.card, title: r.card.title ?? labelOf(m[2].replace(/\.json$/, '')) } as unknown as Record<string, unknown> } : { marker, block: null, error: `${m[2]}: ${r.problems.join('; ')}`, problems: r.problems, file: m[2] })
      }
    } catch (e: any) { out.push({ marker, block: null, error: `${m[2]}: ${e?.message ?? e}` }) }
  }
  return out
}

/** What to tell the one who wrote cards that do not pass (the contract's own words), or null when every one passes. */
export function blockFixes(blocks: SaidBlock[]): string | null {
  return cardFixes(blocks.filter((b) => b.error).map((b) => ({ file: b.file ?? b.marker, problems: b.problems ?? [b.error!] })))
}

/** A program's answer as every surface takes it: its markers resolved against the blocks it carries. */
export async function cardOf(answer: { markdown: string; blocks?: Record<string, unknown> }): Promise<Answer> {
  const blocks = await blocksOf(answer.markdown, (name) => {
    if (!answer.blocks || !(name in answer.blocks)) throw new Error('the answer does not carry it')
    return answer.blocks[name]
  })
  return answerOf(answer.markdown, blocks)
}

type Col = { key: string; label: string; unit?: string }
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v))
const objs = (v: unknown): Record<string, any>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) : [])

/** Any card as the one generic structure — our table: a contract card as it is; a program's own card (kpis, bars, a
 *  grid, …) as the rows it shows. Each cell's words from the platform's one formatter, by its column's unit (or its row's,
 *  for figures that each have their own). */
export function genericCard(b: Record<string, any>): AnswerCard {
  const title = typeof b.title === 'string' && b.title ? b.title : undefined
  const make = (columns: Col[], rows: Record<string, unknown>[], unitOf?: (r: Record<string, unknown>, c: Col) => string | undefined): AnswerCard => ({
    ...(title ? { title } : {}), ...(typeof b.description === 'string' ? { description: b.description } : {}), ...(b.hint ? { hint: String(b.hint) } : {}),
    columns, rows, text: rows.map((r) => columns.map((c) => { const u = unitOf?.(r, c) ?? c.unit; return u ? fmt(r[c.key], u) : r[c.key] === null || r[c.key] === undefined ? '—' : typeof r[c.key] === 'object' ? JSON.stringify(r[c.key]) : String(r[c.key]) })),
  })
  const t = b.kind === 'table' ? 'table' : b.type
  if (t === 'table') return make(objs(b.columns).filter((c) => c.key).map((c) => ({ key: String(c.key), label: str(c.label) || String(c.key), ...(c.unit ? { unit: String(c.unit) } : {}) })), objs(b.rows))
  if (t === 'kpis' || t === 'facts') return make([{ key: 'label', label: '' }, { key: 'value', label: '' }], objs(b.items).map((i) => ({ label: str(i.label), value: i.value, unit: i.unit })), (r, c) => (c.key === 'value' ? (r.unit as string | undefined) : undefined))
  if (t === 'figure') return make([{ key: 'label', label: '' }, { key: 'value', label: '' }], [{ label: str(b.label), value: b.value }], (_r, c) => (c.key === 'value' ? b.unit : undefined))
  if (t === 'bars') {
    const series = objs(b.series).filter((x) => x.key)
    return make([{ key: 'label', label: str(b.axis) }, ...series.map((x) => ({ key: String(x.key), label: str(x.label) || String(x.key), ...(b.unit ? { unit: String(b.unit) } : {}) }))],
      objs(b.rows).map((r) => ({ label: str(r.label), ...Object.fromEntries(series.map((x) => [x.key, r.values?.[x.key] ?? null])) })))
  }
  if (t === 'grid') {
    const periods: string[] = Array.isArray(b.periods) ? b.periods.map(String) : []
    return make([{ key: 'label', label: '' }, ...periods.map((p) => ({ key: p, label: p, ...(b.unit ? { unit: String(b.unit) } : {}) }))],
      objs(b.rows).map((r) => ({ label: str(r.label), ...Object.fromEntries(objs(r.cells).map((c) => [String(c.period), c.value])) })))
  }
  if (t === 'trend') {
    const series = objs(b.series).filter((x) => x.key), periods: string[] = Array.isArray(b.periods) ? b.periods.map(String) : []
    return make([{ key: 'period', label: '' }, ...series.map((x) => ({ key: String(x.key), label: str(x.label) || String(x.key), ...(b.unit ? { unit: String(b.unit) } : {}) }))],
      periods.map((p) => ({ period: p, ...Object.fromEntries(series.map((x) => [x.key, b.values?.[p]?.[x.key] ?? null])) })))
  }
  if (t === 'pareto') return make([{ key: 'label', label: '' }, { key: 'value', label: '', ...(b.unit ? { unit: String(b.unit) } : {}) }], objs(b.rows).map((r) => ({ label: str(r.label), value: r.value })))
  if (t === 'cards') return make([{ key: 'title', label: '' }, { key: 'value', label: '' }, { key: 'sub', label: '' }], objs(b.items).map((i) => ({ title: str(i.title), value: i.value, sub: str(i.sub), unit: i.unit })), (r, c) => (c.key === 'value' ? (r.unit as string | undefined) : undefined))
  if (t === 'scatter') return make([{ key: 'label', label: '' }, { key: 'x', label: str(b.x?.label), ...(b.x?.unit ? { unit: String(b.x.unit) } : {}) }, { key: 'y', label: str(b.y?.label), ...(b.y?.unit ? { unit: String(b.y.unit) } : {}) }], objs(b.points).map((p) => ({ label: str(p.label), x: p.x, y: p.y })))
  if (t === 'text') return make([{ key: 'text', label: '' }], [{ text: str(b.text) }])
  return make([], [])
}

/** The answer every surface takes (clients/protocol.ts Answer): the markdown as written, each card it names as the one
 *  generic structure (null where it could not be shown), and the time it covers. */
export function answerOf(markdown: string, blocks: SaidBlock[], periods: { label: string; detail?: string }[] = []): Answer {
  const cards: Record<string, AnswerCard | null> = {}
  for (const b of blocks) { const name = b.marker.trim().split(/\s+/)[1] ?? b.marker; cards[name] = b.block ? genericCard(b.block) : null }
  return { status: 'answered', category: 'reading', markdown, cards, ...(periods.length ? { periods } : {}) }
}
