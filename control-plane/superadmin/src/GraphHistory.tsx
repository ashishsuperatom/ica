// THE GRAPH'S HISTORY, drawn like a git graph: every run of changes is a step (v1, v2, …, with when and by whom), newest
// at the top; a name is a tag on a step. Going back to an older step starts a new line from it — the line left behind
// stays, ending where it was left. Used by the graph page (its versions) and by the changes page (its graph view).

import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@superatom/ui'

export interface Step {
  n: number; from: number; upto: number; startAt: number; at: number; by: string; count: number
  names: string[]; reasons: string[]; tags: string[]; parent: number | null; restoredTo: number | null
}

const ROW = 64, LANE = 18, PAD = 12

/** Lanes: the line that leads to now is lane 0; each line left behind by a going back gets a lane of its own. */
function lanesOf(steps: Step[]): Map<number, number> {
  const by = new Map(steps.map((s) => [s.n, s]))
  const lane = new Map<number, number>()
  const head = steps[steps.length - 1]
  for (let s: Step | undefined = head; s && !lane.has(s.n); s = s.parent ? by.get(s.parent) : undefined) lane.set(s.n, 0)
  let next = 1
  for (const s of [...steps].reverse()) {
    if (lane.has(s.n)) continue
    const l = next++
    for (let x: Step | undefined = s; x && !lane.has(x.n); x = x.parent ? by.get(x.parent) : undefined) lane.set(x.n, l)
  }
  return lane
}

export const stepWhen = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const who = (by: string) => by.replace(/^user:/, '').replace(/^agent:/, 'agent ')
/** What a step did, in a line: its reason, else the nodes it changed. */
export const stepSays = (s: Step) => s.reasons.find((r) => !/^back to /.test(r)) ?? `${s.count} change${s.count === 1 ? '' : 's'} to ${s.names.slice(0, 3).join(', ')}${s.names.length > 3 ? ', …' : ''}`

export function HistoryGraph({ steps, current, onPick, actions, empty = 'No changes yet.' }: {
  steps: Step[]
  /** The step being looked at (its last change), or null: now. */
  current: number | null
  onPick?: (s: Step) => void
  /** Buttons for a step, shown when it is pointed at. */
  actions?: (s: Step, isHead: boolean) => ReactNode
  empty?: string
}) {
  const lane = useMemo(() => lanesOf(steps), [steps])
  if (!steps.length) return <p className="sa-note">{empty}</p>
  const rows = [...steps].reverse()                     // newest at the top
  const row = new Map(rows.map((s, i) => [s.n, i]))
  const lanes = Math.max(...lane.values()) + 1
  const x = (n: number) => PAD + (lane.get(n) ?? 0) * LANE
  const y = (n: number) => (row.get(n) ?? 0) * ROW + ROW / 2
  const head = steps[steps.length - 1]
  const shown = current ?? head.upto
  return (
    <div className="sa-history" style={{ '--gutter': `${PAD * 2 + (lanes - 1) * LANE}px`, '--row': `${ROW}px` } as CSSProperties}>
      <svg className="sa-history__lines" width={PAD * 2 + (lanes - 1) * LANE} height={rows.length * ROW} aria-hidden>
        {steps.filter((s) => s.parent).map((s) => {
          const p = s.parent!, x1 = x(s.n), y1 = y(s.n), x2 = x(p), y2 = y(p)
          const d = x1 === x2 ? `M${x1},${y1} V${y2}` : `M${x1},${y1} V${y2 - ROW / 2} C${x1},${y2 - ROW / 4} ${x2},${y2 - ROW / 4} ${x2},${y2}`
          return <path key={s.n} d={d} data-lane={Math.min(lane.get(s.n) ?? 0, 3)} />
        })}
        {rows.map((s) => <circle key={s.n} cx={x(s.n)} cy={y(s.n)} r={s.tags.length ? 6 : 4.5} data-lane={Math.min(lane.get(s.n) ?? 0, 3)} data-on={s.upto === shown} data-head={s === head} />)}
      </svg>
      <ol className="sa-history__rows">
        {rows.map((s) => (
          <li key={s.n} className="sa-history__row" data-on={s.upto === shown}>
            <button className="sa-history__main" onClick={() => onPick?.(s)} disabled={!onPick} title={`v${s.n} — ${stepWhen(s.startAt)}${s.at - s.startAt > 60_000 ? ` to ${stepWhen(s.at)}` : ''}`}>
              <span className="sa-history__top">
                <span className="sa-history__n">v{s.n}</span>
                {s === head && <span className="sa-history__tag sa-history__tag--now">now</span>}
                {s.tags.map((t) => <span key={t} className="sa-history__tag"><Icon icon="lucide:tag" />{t}</span>)}
                {s.restoredTo && <span className="sa-history__back"><Icon icon="lucide:undo-2" />back to v{s.restoredTo}</span>}
                <span className="sa-history__says">{stepSays(s)}</span>
              </span>
              <span className="sa-history__meta">{who(s.by)} · {stepWhen(s.at)} · {s.count} change{s.count === 1 ? '' : 's'}</span>
            </button>
            {actions && <span className="sa-history__acts">{actions(s, s === head)}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
