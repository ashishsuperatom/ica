import { Section } from '../ui/Section'
import type { Block } from '../../answer/blocks'

export default function Text({ block }: { block: Extract<Block, { type: 'text' }> }) {
  return (
    <Section icon="lucide:text" accent="neutral" title={block.title}>
      <p data-copy="line" className="sa-section__text">{block.text || '—'}</p>
    </Section>
  )
}
