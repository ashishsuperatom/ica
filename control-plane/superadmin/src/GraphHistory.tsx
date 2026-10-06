// THE GRAPH'S VERSIONS, drawn like a git graph: each PUBLISHED version (v1, v2, …) a dot on its line, newest at the top,
// the draft — what is edited and not yet published — a hollow dot above the published one. Bringing an older version
// back and publishing it starts a new line from it; the line left behind stays, ending where it was left. Used by the
// graph page (its history) and by the changes page (its graph view).

import { useMemo, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@superatom/ui'

/** A published version on its line (composition-graph versionLine). */
export interface Line {
  id: number; name: string; message: string; upto: number; at: number; by: string; changes: number
  n: number; from: number; count: number; names: string[]; parent: string | null; restoredFrom: string | null
}
/** A node of the draft: how it differs from the published graph (null: not there). */
export interface DraftNode { name: string; kind: string; was: string | null; now: string | null }

const ROW = 64, LANE = 18, PAD = 12
const DRAFT = '\u0000draft' as const

/** Lanes: the line that leads to the published version is lane 0; each line left behind gets a lane of its own. */
function lanesOf(versions: Line[], head: Line | undefined): Map<string, number> {
  const by = new Map(versions.map((v) => [v.name, v]))
  const lane = new Map<string, number>()
  for (let v: Line | undefined = head; v && !lane.has(v.name); v = v.parent ? by.get(v.parent) : undefined) lane.set(v.name, 0)
  let next = 1
  for (const v of [...versions].reverse()) {
    if (lane.has(v.name)) continue
    const l = next++
    for (let x: Line | undefined = v; x && !lane.has(x.name); x = x.parent ? by.get(x.parent) : undefined) lane.set(x.name, l)
  }
  return lane
}

export const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
/** Who did it, as a person reads it: their address when the project knows it, else a short form of the id. */
export const whoOf = (by: string, people: Record<string, string> = {}) => people[by] ?? (by.startsWith('agent:') ? `agent key ${by.slice(6, 14)}` : by.replace(/^user:(user_)?/, '').slice(0, 8) + '…')

export function VersionGraph({ versions, published, draft, current, onPick, actions, draftActions, people = {} }: {
  versions: Line[]
  /** The version the agents read. */
  published: string | null
  /** What is edited and not yet published (empty: the draft is the published graph). */
  draft: DraftNode[]
  /** The version being looked at, or null: the draft (the graph as it is). */
  current: string | null
  onPick?: (v: Line | null) => void
  actions?: (v: Line) => ReactNode
  draftActions?: ReactNode
  /** Who is who: an id to the person's address. */
  people?: Record<string, string>
}) {
  const head = versions.find((v) => v.name === published) ?? versions[versions.length - 1]
  const lane = useMemo(() => lanesOf(versions, head), [versions, head])
  const rows: (Line | typeof DRAFT)[] = [...(draft.length || !versions.length ? [DRAFT] : []), ...[...versions].reverse()]
  const row = new Map(rows.map((r, i) => [typeof r === 'string' ? r : r.name, i]))
  const lanes = Math.max(1, ...lane.values()) + (lane.size ? 1 : 0)
  const x = (name: string) => PAD + (name === DRAFT ? 0 : lane.get(name) ?? 0) * LANE
  const y = (name: string) => (row.get(name) ?? 0) * ROW + ROW / 2
  const width = PAD * 2 + Math.max(0, lanes - 1) * LANE
  return (
    <div className="sa-history" style={{ '--gutter': `${width}px`, '--row': `${ROW}px` } as CSSProperties}>
      <svg className="sa-history__lines" width={width} height={rows.length * ROW} aria-hidden>
        {row.has(DRAFT) && head && <path d={`M${x(DRAFT)},${y(DRAFT)} V${y(head.name)}`} data-lane="0" data-draft />}
        {versions.filter((v) => v.parent && row.has(v.parent)).map((v) => {
          const p = v.parent!, x1 = x(v.name), y1 = y(v.name), x2 = x(p), y2 = y(p)
          const d = x1 === x2 ? `M${x1},${y1} V${y2}` : `M${x1},${y1} V${y2 - ROW / 2} C${x1},${y2 - ROW / 4} ${x2},${y2 - ROW / 4} ${x2},${y2}`
          return <path key={v.name} d={d} data-lane={Math.min(lane.get(v.name) ?? 0, 3)} />
        })}
        {row.has(DRAFT) && <circle cx={x(DRAFT)} cy={y(DRAFT)} r={5} data-lane="0" data-draft data-on={current === null} />}
        {versions.map((v) => <circle key={v.name} cx={x(v.name)} cy={y(v.name)} r={v === head ? 6 : 4.5} data-lane={Math.min(lane.get(v.name) ?? 0, 3)} data-on={current === v.name} data-head={v === head} />)}
      </svg>
      <ol className="sa-history__rows">
        {rows.map((r) => r === DRAFT ? (
          <li key="draft" className="sa-history__row" data-on={current === null}>
            <button className="sa-history__main" onClick={() => onPick?.(null)} disabled={!onPick}>
              <span className="sa-history__top"><span className="sa-history__n">Draft</span>
                <span className="sa-history__says">{draft.length ? `${draft.length} change${draft.length === 1 ? '' : 's'} not yet published` : 'Nothing published yet — the agents read the graph as it is'}</span></span>
              <span className="sa-history__meta">{draft.length ? draft.slice(0, 6).map((d) => d.name).join(', ') + (draft.length > 6 ? ', …' : '') : 'Publish it to make v1'}</span>
            </button>
            {draftActions && <span className="sa-history__acts sa-history__acts--shown">{draftActions}</span>}
          </li>
        ) : (
          <li key={r.name} className="sa-history__row" data-on={current === r.name}>
            <button className="sa-history__main" onClick={() => onPick?.(r)} disabled={!onPick} title={`${r.name} — published ${when(r.at)}`}>
              <span className="sa-history__top">
                <span className="sa-history__n">{r.name}</span>
                {r === head && <span className="sa-history__tag sa-history__tag--now">live</span>}
                {r.restoredFrom && <span className="sa-history__back"><Icon icon="lucide:undo-2" />from {r.restoredFrom}</span>}
                <span className="sa-history__says">{r.message}</span>
              </span>
              <span className="sa-history__meta">{whoOf(r.by, people)} · {when(r.at)} · {r.count} change{r.count === 1 ? '' : 's'}</span>
            </button>
            {actions && <span className="sa-history__acts">{actions(r)}</span>}
          </li>
        ))}
      </ol>
    </div>
  )
}
