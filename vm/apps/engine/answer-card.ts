// ── The answer card — markdown with marker lines, as the one answer component draws it ─────────────────────────────
//
// An answer is markdown; a line `:::table <name>.json` (or `:::bar`, `:::line`, `:::kpis`, …) marks where a block
// belongs. The block is the named file in a thread's folder (an agent's answer) or carried with the answer (a
// program's). Every surface draws the card (clients/protocol.ts Answer): the prose without its marker lines, each
// block a section. One place for both, so a table from an agent and one from a program draw the same.

import type { Answer } from '../../../clients/protocol.js'
import { fmt, numeric, asNumber } from '@superatom/ui/format'

/** A figure as the web draws it (the one formatter: A$6.6M, 49,048 h), its value kept beside the words. */
const shown = (v: unknown, unit: unknown): unknown => (typeof unit === 'string' && numeric(unit) && asNumber(v) !== null ? { value: v, display: fmt(v, unit) } : v)

export interface SaidBlock { marker: string; block: Record<string, unknown> | null; error?: string }

export const MARKER = /^:::(table|bar|bars|line|kpis|figure|facts|text)\s+([\w.-]+\.json)\s*$/
const KIND: Record<string, string> = { bar: 'bars', bars: 'bars', line: 'bars', table: 'table', kpis: 'kpis', figure: 'figure', facts: 'facts', text: 'text' }

/** One block as a marker names it: the marker's kind wins over the block's `type`; a line series is bars with every
 *  series drawn as a line. */
export function blockFor(kind: string, v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a block object')
  const b: Record<string, unknown> = { ...(v as Record<string, unknown>), type: KIND[kind] ?? (v as any).type }
  if (kind === 'line' && Array.isArray(b.series)) b.series = (b.series as any[]).map((x) => ({ ...x, line: true }))
  if (kind === 'line' && !b.series && Array.isArray(b.rows) && (b.rows as any[])[0]?.values) b.series = Object.keys((b.rows as any[])[0].values).map((k) => ({ key: k, label: k, line: true }))
  if (b.type === 'bars' && !b.series && Array.isArray(b.rows) && (b.rows as any[])[0]?.values) b.series = Object.keys((b.rows as any[])[0].values).map((k) => ({ key: k, label: k }))
  if (b.type === 'table' && !Array.isArray(b.rows)) throw new Error('a table has rows')
  return b
}

/** Every block a markdown's marker lines name, in order, each read by `read(name)`. */
export async function blocksOf(markdown: string, read: (name: string) => unknown | Promise<unknown>): Promise<SaidBlock[]> {
  const out: SaidBlock[] = []
  for (const line of markdown.split('\n')) {
    const m = MARKER.exec(line.trim()); if (!m) continue
    const marker = line.trim()
    try { out.push({ marker, block: blockFor(m[1], await read(m[2])) }) } catch (e: any) { out.push({ marker, block: null, error: `${m[2]}: ${e?.message ?? e}` }) }
  }
  return out
}

/** A program's answer as the card: its markers resolved against the blocks it carries. */
export async function cardOf(answer: { markdown: string; blocks?: Record<string, unknown> }): Promise<Answer> {
  const blocks = await blocksOf(answer.markdown, (name) => {
    if (!answer.blocks || !(name in answer.blocks)) throw new Error('the answer does not carry it')
    return answer.blocks[name]
  })
  return readingAnswer(answer.markdown, blocks)
}

/** A reading as an Answer: the prose without its marker lines, and each block the markdown named as a section. */
export function readingAnswer(markdown: string, blocks: { marker: string; block: Record<string, unknown> | null; error?: string }[], periods: { label: string; detail?: string }[] = []): Answer {
  const prose = markdown.split('\n').filter((l) => !/^:::\S+\s+\S+/.test(l.trim())).join('\n').trim()
  const sections: NonNullable<Answer['sections']> = []
  for (const b of blocks) {
    const block = b.block
    if (!block) { sections.push({ kind: 'text', body: `${b.marker}: ${b.error ?? 'nothing to show'}` }); continue }
    const cols = Array.isArray(block.columns) ? (block.columns as any[]).filter((c) => c && typeof c === 'object' && c.key) : []
    const rows = Array.isArray(block.rows) ? (block.rows as any[]) : []
    if (cols.length && rows.length) {
      sections.push({ kind: 'table', title: typeof block.title === 'string' ? block.title : undefined,
        columns: cols.map((c) => ({ label: String(c.label ?? c.key), ...(c.unit ? { unit: String(c.unit) } : {}) })),
        rows: rows.map((r) => cols.map((c) => shown(r && typeof r === 'object' ? (r as any)[c.key] : r, c.unit))) })
    } else if (Array.isArray(block.series) && rows.length) {
      // A chart, for now as its numbers: the axis and one column per series.
      const series = (block.series as any[]).filter((x) => x && x.key)
      const value = (r: any, key: string) => (r?.values && typeof r.values === 'object' ? r.values[key] : r?.[key])
      sections.push({ kind: 'table', title: typeof block.title === 'string' ? block.title : undefined,
        columns: [String(block.axis ?? 'row'), ...series.map((x) => ({ label: String(x.label ?? x.key), ...(block.unit ? { unit: String(block.unit) } : {}) }))],
        rows: rows.map((r) => [r?.label ?? r?.key ?? r?.[String(block.axis ?? '')], ...series.map((x) => shown(value(r, x.key), block.unit))]) })
    } else sections.push({ kind: 'text', body: `${b.marker}: a block of kind ${String(block.type ?? '?')} that this surface cannot draw yet` })
  }
  // The time the answer covers goes where every surface already shows an answer's time: its periods.
  return { status: 'answered', category: 'reading', answer: prose, ...(periods.length ? { periods } : {}), ...(sections.length ? { sections } : {}) }
}

