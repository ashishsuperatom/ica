// One block of this application's thread, in the platform's frame: what kind of step it is (a capability, a reading,
// where the numbers come from), its title and what opened it, from this application's runtime and catalogue.

import type { ReactNode } from 'react'
import { BlockFrame as Frame, ACCENT, revealBlock, type Accent } from '@superatom/ui'
import { useThread, type Node } from '@/runtime/thread'
import { capabilityOf, useApp } from '@/lib/catalog'

export default function BlockFrame({ block, children }: { block: Node; children: ReactNode }) {
  const { catalog } = useApp()
  const { remove, blocks } = useThread()
  const from = block.from && blocks.find((b) => b.id === block.from!.id)
  const cap = capabilityOf(catalog, block.question.focus)
  const isAbout = block.about || block.question.focus === 'about'
  const isSaid = block.kind === 'said'
  const label = isSaid ? 'Reader' : isAbout ? 'About' : cap?.label ?? block.question.focus
  const title = (isSaid ? block.said?.text ?? block.placeholder : block.answer?.title ?? block.placeholder) ?? label
  const accent = ACCENT[isSaid || isAbout ? 'neutral' : ((catalog.scenarios.find((s) => s.key === cap?.scenario)?.accent ?? 'series-1') as Accent)]
  const earlier = block.earlier ? ` · from earlier, ${new Date(block.earlier).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : ''
  return (
    <Frame id={block.id} step={block.step} accent={accent} label={label} title={title} arrangeScope={`block:${label}`}
      icon={isSaid ? 'lucide:book-open-text' : undefined}
      cause={block.cause} from={block.from ? { ...block.from, onPath: !!from } : undefined} onReveal={revealBlock}
      subtitle={`${block.answer?.said ?? cap?.whenToUse ?? ''}${earlier}`.trim() || undefined}
      busy={block.busy} words={block.answer?.words}
      onRemove={block.parentId ? () => remove(block.id) : undefined}>
      {children}
    </Frame>
  )
}
