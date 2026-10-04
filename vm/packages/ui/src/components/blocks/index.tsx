// The block renderers, one per block type in the answer envelope. To add a block type: add its shape to
// `Block` in lib/wire.ts (and a case in `readBlock`), write a renderer here on the design system's primitives,
// and register it in RENDERERS. Renderers are pure: a block in, elements out, with two callbacks.

import type { Block, Row, RowMove, WindowKind } from '../../answer/blocks'
import { Section } from '../ui/Section'
import Kpis from './Kpis'
import Figure from './Figure'
import Bars from './Bars'
import Grid from './Grid'
import Table from './Table'
import Facts from './Facts'
import Text from './Text'

export interface BlockCallbacks {
  onRow?: (move: RowMove, row: Row) => void
  onRowWindow?: (kind: WindowKind, value: string) => void
  /** Turn a table the source pages: which page, in which order. */
  onPage?: (table: string, page: number, order?: string) => void
}
export type Renderer<B extends Block = Block> = React.ComponentType<{ block: B } & BlockCallbacks>

type ByType = { [K in Block['type']]: Renderer<Extract<Block, { type: K }>> }
const Unknown: Renderer<Extract<Block, { type: 'unknown' }>> = ({ block }) => (
  <Section icon="lucide:circle-help" accent="neutral" title={block.title}>
    <p className="sa-note sa-section__empty">This answer has a block of a kind this client cannot draw yet ({block.title}).</p>
  </Section>
)
const RENDERERS: ByType = { kpis: Kpis, figure: Figure, bars: Bars, grid: Grid, table: Table, facts: Facts, text: Text, unknown: Unknown }

/**
 * A renderer is RENDERED as a component, never called as a function: called, its hooks would run inside this
 * component, and a block of another type at the same position (a fresh answer replacing a cached one, an edit whose
 * answer has a different block list) would change the hook count between renders — React error #311. Keyed by
 * position and type, a change of type remounts.
 */
export function BlockView({ block, ...cb }: { block: Block } & BlockCallbacks) {
  const R = RENDERERS[block.type] as Renderer
  return <R block={block} {...cb} />
}

export function Blocks({ blocks, ...cb }: { blocks: Block[] } & BlockCallbacks) {
  return <>{blocks.map((b, i) => <BlockView key={`${i}:${b.type}`} block={b} {...cb} />)}</>
}
