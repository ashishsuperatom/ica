// ── The thread — a session's blocks, from the first to the current one ───────────────────────────────────────────────
//
// The blocks are a tree; the thread shows the path down to the current block. Where a block has siblings (someone
// changed an earlier block and the thread branched), the block says so and lets the person move between them. What a
// block shows is the caller's: the answer component, a program's view.

import { createElement as h, type ReactNode } from 'react'
import type { Session } from '@superatom/platform-types'

type Blocks = Session['blocks']

/** The blocks from the first down to one block. */
export function pathOf(blocks: Blocks, block: string): string[] {
  const out: string[] = []
  for (let b: string | null = block; b; b = blocks.find((x) => x.id === b)?.parent ?? null) {
    if (out.includes(b)) break
    out.unshift(b)
  }
  return out
}

/** The newest block at the end of a branch, from a block down (the last-made child each step). */
export function latestUnder(blocks: Blocks, block: string): string {
  let b = block
  for (;;) {
    const kids = blocks.filter((x) => x.parent === b)
    if (!kids.length) return b
    b = kids[kids.length - 1].id
  }
}

/** A block's siblings, itself among them, in the order they were made. */
export function siblingsOf(blocks: Blocks, block: string): string[] {
  const parent = blocks.find((x) => x.id === block)?.parent ?? null
  return blocks.filter((x) => x.parent === parent).map((x) => x.id)
}

export interface ThreadProps {
  session: Pick<Session, 'blocks' | 'leaf'>
  /** What a block shows. */
  renderBlock: (block: string) => ReactNode
  /** The person moved to another block (a branch). */
  onGoTo: (block: string) => void
}

export function Thread({ session, renderBlock, onGoTo }: ThreadProps) {
  return h('ol', { className: 'sa-thread' }, pathOf(session.blocks, session.leaf).map((id) => {
    const sibs = siblingsOf(session.blocks, id)
    const n = sibs.indexOf(id)
    const go = (to: string) => () => onGoTo(latestUnder(session.blocks, to))
    return h('li', { key: id, className: 'sa-block', 'data-block': id, 'aria-current': id === session.leaf ? 'true' : undefined },
      sibs.length > 1 && h('nav', { className: 'sa-branches', 'aria-label': 'Branches' },
        h('button', { type: 'button', disabled: n === 0, onClick: go(sibs[n - 1]), 'aria-label': 'Previous branch' }, '‹'),
        h('span', null, `${n + 1} of ${sibs.length}`),
        h('button', { type: 'button', disabled: n === sibs.length - 1, onClick: go(sibs[n + 1]), 'aria-label': 'Next branch' }, '›')),
      renderBlock(id))
  }))
}
