import { Part } from '../ui/Section'
import type { Block } from '../../answer/blocks'

export default function Text({ block }: { block: Extract<Block, { type: 'text' }> }) {
  return (
    <Part title={block.title}>
      <p data-copy="line" className="sa-part__text">{block.text || '—'}</p>
    </Part>
  )
}
