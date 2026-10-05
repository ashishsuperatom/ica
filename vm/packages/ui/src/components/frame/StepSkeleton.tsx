// A step on its way: the shape an answer takes (four figure tiles, then a card of lines), so the step appears at once in
// its place and the answer fills it without the page moving.

import { Skeleton } from '../ui/Section'

export default function StepSkeleton({ label = 'Working' }: { label?: string }) {
  return (
    <div className="sa-skeleton-block" aria-busy="true" aria-label={label}>
      <div className="sa-kpi-grid sa-kpi-grid--4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="sa-card sa-skeleton-block__tile"><Skeleton w="60%" h={10} /><Skeleton w="45%" h={20} /><Skeleton w="70%" h={9} /></div>)}
      </div>
      <div className="sa-card sa-skeleton-block__card">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={12} w={`${90 - i * 9}%`} />)}</div>
    </div>
  )
}
