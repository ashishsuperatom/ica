// ONE CARD (answer/cards.ts, the contract): its rows, drawn as a table — wherever it is put: inside an answer, inside a
// program's block, inside a UI. A card hinted as a chart (:::bar, :::line) is drawn as its table until this runtime draws
// charts from the same rows.

import { BlockView } from '../blocks'
import type { Card } from '../../answer/cards'

export function CardView({ card }: { card: Card }) {
  return <BlockView block={{ type: 'table', title: card.title ?? '', columns: card.columns, rows: card.rows }} />
}
