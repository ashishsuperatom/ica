// One figure — a what-if's answer — with what it is compared against and why it comes out that way.

import { Section } from '@/components/ui/Section'
import { fmt, asNumber } from '@/lib/format'
import type { Block } from '@/lib/wire'

export default function Figure({ block }: { block: Extract<Block, { type: 'figure' }> }) {
  const v = asNumber(block.value), c = asNumber(block.compare?.value)
  const share = v !== null && c !== null && c !== 0 ? v / c : null
  return (
    <Section icon="lucide:sigma" accent="series-2" title={block.label}>
      <div className="sa-section__body sa-headline">
        <div data-copy="line">
          <div className="sa-figure sa-key sa-headline__value">{fmt(block.value, block.unit)}</div>
          {block.compare && <div className="sa-note">against {block.compare.label} <b>{fmt(block.compare.value, block.unit)}</b>{share !== null && <> · {fmt(share, 'ratio')}</>}</div>}
        </div>
        {block.because.length > 0 && <ul className="sa-headline__because">{block.because.map((b, i) => <li key={i} data-copy="line">{b}</li>)}</ul>}
      </div>
    </Section>
  )
}
