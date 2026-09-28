// The thread as a page: the active path, root at the top, newest at the bottom. A BranchBar sits above any block
// whose parent has more than one child (the fork point), so the other branches are a click away.

import { useThread } from '@/runtime/thread'
import { useBlockKeys } from './navigation'
import BlockFrame from './BlockFrame'
import BranchBar from './BranchBar'
import BlockBody from '@/components/block/BlockBody'
import Home from './Home'
import AskBar from './AskBar'

/** Where one step ends and the next begins: a hairline with the time the next step was taken. */
function Separator({ at }: { at: string }) {
  const d = new Date(at)
  const time = Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })
  return (
    <div className="sa-separator" aria-hidden>
      <span className="sa-separator__line" />
      <span className="sa-separator__time"><span className="sa-separator__dot" />{time}</span>
      <span className="sa-separator__line sa-separator__line--r" />
    </div>
  )
}

export default function ThreadView() {
  const { blocks, siblingsOf, switchBranch } = useThread()
  useBlockKeys(blocks.map((b) => b.id))
  return (
    <div className="sa-thread">
      <div className="sa-thread__column thread-blocks">
        {blocks.length === 0 && <Home />}
        {blocks.map((block, i) => {
          const siblings = siblingsOf(block.id)
          return (
            <div key={block.id} className="sa-thread__item">
              {i > 0 && <Separator at={block.at} />}
              {siblings.length > 1 && <BranchBar siblings={siblings} onSwitch={switchBranch} />}
              <BlockFrame block={block}><BlockBody block={block} /></BlockFrame>
            </div>
          )
        })}
      </div>
      <AskBar />
    </div>
  )
}
