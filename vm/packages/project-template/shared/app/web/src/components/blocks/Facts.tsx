import { Section } from '@/components/ui/Section'
import { text } from '@/lib/format'
import type { Block } from '@/lib/wire'

export default function Facts({ block }: { block: Extract<Block, { type: 'facts' }> }) {
  return (
    <Section icon="lucide:list" accent="series-1" title={block.title}>
      <dl className="sa-facts">
        {block.items.map((f, i) => (
          <div key={i} data-copy="line" className="sa-facts__row">
            <dt className="sa-facts__key" title={f.label}>{f.label}</dt>
            <dd className="sa-facts__value truncate" title={text(f.value)}>{text(f.value)}</dd>
          </div>
        ))}
        {!block.items.length && <span className="sa-note">Nothing recorded.</span>}
      </dl>
    </Section>
  )
}
