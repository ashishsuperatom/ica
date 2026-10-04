// The program's React side: one export per ui block, named in PascalCase (block "example" → Example), drawn with
// { slice, state }. Controls are <Intent>s — the one way a screen changes STATE. Only the platform's libraries are imported.
import { Intent } from '@superatom/ui'

type Slice = { filter: string | null; rows: { key: string; value: number }[]; total: number }

export function Example({ slice }: { slice?: Slice }) {
  if (!slice?.rows?.length) return null
  return (
    <div className="sa-session-actions">
      {slice.filter
        ? <Intent ops={[{ op: 'set', path: 'example.filter', value: null }]} className="sa-session-action">All keys</Intent>
        : slice.rows.slice(0, 8).map((r) => <Intent key={r.key} ops={[{ op: 'set', path: 'example.filter', value: r.key }]} to="new" className="sa-session-action">{r.key} · {r.value}</Intent>)}
    </div>
  )
}
