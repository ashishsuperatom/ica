// Render an engine Answer for Teams. Teams messages support only a thin markdown
// subset (no reliable tables), so anything with figures or a table becomes an
// Adaptive Card; a plain prose answer can go as text. This mirrors the web UI's
// AnswerCard at a basic level — prose, a figures FactSet, and a compact table.

import { CardFactory, type Attachment } from 'botbuilder'
import type { Answer as EngineAnswer } from '../../protocol.js'

const MAX_ROWS = 12   // keep the card small; note the rest

/** Plain-text fallback (DMs, or when there's nothing structured to show). */
export function toText(a: EngineAnswer): string {
  const lines: string[] = []
  if (a.answer) lines.push(a.answer)
  for (const f of a.figures ?? []) lines.push(`• **${f.label}**: ${f.display}${f.sub ? ` (${f.sub})` : ''}`)
  if (a.period) lines.push(`_${a.period}_`)
  return lines.join('\n\n') || 'No answer.'
}

/** True when the answer has structure worth a card (figures or a table). */
export function hasStructure(a: EngineAnswer): boolean {
  return !!(a.figures?.length || a.table?.columns?.length)
}

/** Build an Adaptive Card attachment for a structured answer. */
export function toAdaptiveCard(a: EngineAnswer): Attachment {
  const body: any[] = []

  if (a.category) body.push({ type: 'TextBlock', text: String(a.category).replace(/_/g, ' ').toUpperCase(), weight: 'Bolder', size: 'Small', isSubtle: true, spacing: 'None' })
  if (a.answer)   body.push({ type: 'TextBlock', text: a.answer, wrap: true, spacing: 'Small' })

  if (a.figures?.length) {
    body.push({
      type: 'FactSet',
      facts: a.figures.map((f) => ({ title: f.label, value: f.sub ? `${f.display}  (${f.sub})` : f.display })),
      spacing: 'Medium',
    })
  }

  if (a.table?.columns?.length) {
    const cols = a.table.columns
    const rows = a.table.rows ?? []
    const shown = rows.slice(0, MAX_ROWS)
    body.push({
      type: 'Table',
      columns: cols.map(() => ({ width: 1 })),
      firstRowAsHeaders: true,
      rows: [
        tableRow(cols.map(String), true),
        ...shown.map((r) => tableRow(cols.map((_, i) => fmt(r[i])))),
      ],
      spacing: 'Medium',
    })
    const total = typeof a.table.totalRows === 'number' ? a.table.totalRows : rows.length
    if (total > shown.length) body.push({ type: 'TextBlock', text: `Showing ${shown.length} of ${total} rows`, size: 'Small', isSubtle: true, spacing: 'Small' })
  }

  if (a.period) body.push({ type: 'TextBlock', text: a.period, size: 'Small', isSubtle: true, wrap: true, spacing: 'Small' })

  return CardFactory.adaptiveCard({
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.5',
    body,
  })
}

function tableRow(cells: string[], header = false): any {
  return {
    type: 'TableRow',
    cells: cells.map((c) => ({
      type: 'TableCell',
      items: [{ type: 'TextBlock', text: c, wrap: true, weight: header ? 'Bolder' : 'Default', size: 'Small' }],
    })),
  }
}

function fmt(v: any): string {
  if (v == null) return ''
  return typeof v === 'number' ? v.toLocaleString() : String(v)
}
