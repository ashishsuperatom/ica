// WHERE THE DATA COMES FROM — two semantic components for a project's data sources (design/semantic.css).
//
//   SourceHub    the project at the centre and every source branching out to it: what each is, how big, how its index
//                stands. Plain HTML; the branches are one SVG drawn to the same row geometry as the cards (no measuring,
//                nothing moves once drawn). The project is there at once, in the middle of the screen (its mark first, its
//                name and size growing in beneath as they are known, the whole kept centred); its sources come in
//                one after another, each with its branch (a short fade, in their order). A card chosen: tree columns (TreeColumns) — the sources, then what the chosen
//                one opens. On a phone they stack.
//   sourceColumns  one source as SourceHub's next columns: tables, a table's fields; and as the details the source, or the
//                chosen table or field — its type, key, references, the three descriptions (whose is used), whether it is
//                enabled (the agents see it) or no longer in the source (gone), and what can be done with it. The details'
//                head says what they are of: the data source, a table or a field, each with its icon.

import { useState, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import SuperatomMark from '../layout/SuperatomMark'
import { Status, type State } from './index'
import { TreeColumns, type TreeColumn, type TreeColumnRow } from './TreeColumns'

export interface HubSource { key: string; title: string; /** While searching: how many of its tables and fields match. */ found?: number; /** An iconify icon (the source's connector's). */ icon?: string; kind?: string; meta?: string; count?: string; state: State; stateLabel: string }

/** A source's mark: its icon, or — when it has none — its letters: the first of its name, or the first of each of its
 *  first two parts when the name is hyphenated (f5-usecases → F U). Always something to know it by. */
const MARK_ICON = { sm: 16, md: 32 } as const   // the icon inside the tile, in px (the tile: sa-srcmark in semantic.css)

export function SourceMark({ icon, name, size = 'md' }: { icon?: string; name: string; size?: 'sm' | 'md' }) {
  const parts = name.split('-').filter(Boolean)
  const letters = (parts.length > 1 ? parts.slice(0, 2).map((p) => p[0]) : [name.trim()[0] ?? '?']).join('').toUpperCase()
  return (
    <span className="sa-srcmark" data-size={size} aria-hidden>
      {icon ? <Icon icon={icon} className="sa-srcmark__icon" width={MARK_ICON[size]} height={MARK_ICON[size]} /> : <span className="sa-srcmark__letters">{letters}</span>}
    </span>
  )
}

const ROW = 92        // one card's row, in px (the same number the branches are drawn to)

export function SourceHub({ centre, sources, selected, onSelect, empty, opened, search }: {
  centre: { title: string; subtitle?: string }
  sources: HubSource[]
  selected?: string | null
  onSelect: (key: string) => void
  /** Said under the project when it has no source — given once that is known (never while loading). */
  empty?: ReactNode
  /** What the chosen source opens: the columns after the sources' (sourceColumns), and the detail of what is chosen. */
  opened?: { columns: TreeColumn[]; detail?: ReactNode; detailTitle?: string; detailIcon?: string }
  /** One search over every source, above the columns (searchTables narrows each). */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string }
}) {
  // Chosen: tree columns — the sources, then what the chosen one opens. The chosen source again (or Overview) goes back.
  if (selected && opened) return (
    <TreeColumns keep="data-sources" bleed search={search} detail={opened.detail} detailTitle={opened.detailTitle} detailIcon={opened.detailIcon} columns={[{
      key: 'sources', title: centre.title, selected, onSelect, action: { label: 'Overview', run: () => onSelect(selected) },
      rows: sources.map((s) => ({ key: s.key, title: s.title, mark: <SourceMark icon={s.icon} name={s.title} size="sm" />, opens: true, muted: s.found === 0,
        aside: s.found != null ? `${s.found.toLocaleString()} found` : <Status state={s.state}>{s.stateLabel}</Status> })),
    }, ...opened.columns]} />
  )
  const left = sources.filter((_, i) => i % 2 === 0), right = sources.filter((_, i) => i % 2 === 1)
  const rows = Math.max(left.length, right.length, 2)
  const h = rows * ROW
  const yOf = (n: number, i: number) => (h - n * ROW) / 2 + i * ROW + ROW / 2
  // x in a 1000-wide box stretched to the page: the card columns end at 30% and start at 70%; the centre spans 42–58%.
  const curve = (side: 'l' | 'r', y: number) => {
    const x0 = side === 'l' ? 300 : 700, x1 = side === 'l' ? 420 : 580, mid = (x0 + x1) / 2
    return `M ${x0} ${y} C ${mid} ${y}, ${mid} ${h / 2}, ${x1} ${h / 2}`
  }
  const order = (k: string) => sources.findIndex((x) => x.key === k)   // the order the sources come in, one after another
  const card = (s: HubSource) => (
    <button key={s.key} type="button" className="sa-hub__source" data-state={s.state} aria-pressed={selected === s.key} onClick={() => onSelect(s.key)} style={{ height: ROW - 16, ['--i' as string]: order(s.key) }}>
      <SourceMark icon={s.icon} name={s.title} />
      <span className="sa-hub__about">
        <span className="sa-hub__name">{s.title}</span>
        {s.meta && <span className="sa-hub__meta">{s.meta}</span>}
        <Status state={s.state}>{s.stateLabel}</Status>
      </span>
    </button>
  )
  return (
    <div className="sa-hub-stage">
    <div className="sa-hub" style={{ ['--hub-h' as string]: `${h}px` }}>
      <svg className="sa-hub__branches" viewBox={`0 0 1000 ${h}`} preserveAspectRatio="none" aria-hidden="true">
        {left.map((s, i) => <path key={s.key} d={curve('l', yOf(left.length, i))} data-on={selected === s.key} data-state={s.state} style={{ ['--i' as string]: order(s.key) }} />)}
        {right.map((s, i) => <path key={s.key} d={curve('r', yOf(right.length, i))} data-on={selected === s.key} data-state={s.state} style={{ ['--i' as string]: order(s.key) }} />)}
      </svg>
      {[...left.map((s, i) => [s, 'l', yOf(left.length, i)] as const), ...right.map((s, i) => [s, 'r', yOf(right.length, i)] as const)].map(([s, side, y]) => s.count &&
        <span key={`c-${s.key}`} className="sa-hub__count" data-on={selected === s.key} style={{ left: side === 'l' ? '36%' : '64%', top: (y + h / 2) / 2, ['--i' as string]: order(s.key) }}>{s.count}</span>)}
      <div className="sa-hub__col sa-hub__col--l" style={{ paddingTop: (h - left.length * ROW) / 2 + 8 }}>{left.map(card)}</div>
      <div className="sa-hub__centre">
        <span className="sa-hub__mark"><SuperatomMark size={34} /></span>
        {/* each line grows in when it is known, and the whole stays centred as it does */}
        <span className="sa-hub__line" data-shown={!!centre.title}><span><span className="sa-hub__title">{centre.title}</span></span></span>
        <span className="sa-hub__line" data-shown={!!centre.subtitle}><span><span className="sa-hub__subtitle">{centre.subtitle}</span></span></span>
      </div>
      <div className="sa-hub__col sa-hub__col--r" style={{ paddingTop: (h - right.length * ROW) / 2 + 8 }}>{right.map(card)}</div>
    </div>
      {!sources.length && empty && <div className="sa-hub__empty">{empty}</div>}
    </div>
  )
}

/** One source as the columns SourceHub opens: its tables; a chosen table's fields; and, as the details, the source itself
 *  (`source`) until a table is chosen, then the chosen table or field — what the index holds about it and what can be done
 *  with it (described, enabled or not, read again), each only when its handler is given. */
export function sourceColumns({ tables, loading, picked, onPick, source, onEnable, onDescribe, onReread, busy, searching }: {
  tables: TreeTable[]
  /** The words searched, when the tables are narrowed to them. */
  searching?: string
  loading?: boolean
  picked?: { table: string; field: string | null } | null
  onPick: (p: { table: string; field: string | null }) => void
  /** The details while no table is chosen. */
  source?: ReactNode
  /** Offer a table or a field to the agents, or not (field null: the table). */
  onEnable?: (table: string, field: string | null, enabled: boolean) => void
  /** A person's description of a table or a field (empty: none). */
  onDescribe?: (table: string, field: string | null, text: string) => void
  /** Read one table again from the source. */
  onReread?: (table: string) => void
  busy?: boolean
}): { columns: TreeColumn[]; detail?: ReactNode; detailTitle: string; detailIcon: string } {
  const table = picked ? tables.find((t) => t.name === picked.table) ?? null : null
  const field = table && picked?.field ? table.fields.find((f) => f.name === picked.field) ?? null : null
  const columns: TreeColumn[] = [{
    key: 'tables', title: 'Tables', selected: table?.name ?? null, onSelect: (k) => onPick({ table: k, field: null }),
    empty: loading ? 'Loading the index…' : searching?.trim() ? `Nothing in this source matches “${searching.trim()}”.` : 'No tables in the index yet.',
    rows: tableRows(tables),
  }]
  if (table) columns.push({
    key: 'fields', title: 'Fields', selected: field?.name ?? null, onSelect: (k) => onPick({ table: table.name, field: k }),
    empty: 'No fields read for this table.',
    rows: fieldRows(table),
  })
  const detail = table
    ? <Detail key={`${table.name}/${field?.name ?? ''}`} table={table} field={field} busy={busy}
        onEnable={onEnable ? (on) => onEnable(table.name, field?.name ?? null, on) : undefined}
        onDescribe={onDescribe ? (text) => onDescribe(table.name, field?.name ?? null, text) : undefined}
        onReread={onReread && !field ? () => onReread(table.name) : undefined} />
    : source
  const of = field ? DETAIL_OF.field : table ? DETAIL_OF.table : DETAIL_OF.source
  return { columns, detail, detailTitle: of.title, detailIcon: of.icon }
}
/** A source's tables narrowed to a search: a table whose name or description holds the words, with all its fields; else a
 *  table with fields whose name, type or description hold them, with only those. `found`: tables and fields that matched. */
export function searchTables(tables: TreeTable[], words: string): { tables: TreeTable[]; found: number } {
  const w = words.trim().toLowerCase()
  if (!w) return { tables, found: 0 }
  const has = (...xs: (string | null | undefined)[]) => xs.some((x) => x?.toLowerCase().includes(w))
  let found = 0
  const out: TreeTable[] = []
  for (const t of tables) {
    const fields = t.fields.filter((f) => has(f.name, f.type, f.descHuman, f.descSource, f.descAi))
    const self = has(t.name, t.descHuman, t.descSource, t.descAi)
    if (!self && !fields.length) continue
    found += (self ? 1 : 0) + fields.length
    out.push(self && !fields.length ? t : { ...t, fields })
  }
  return { tables: out, found }
}

/** A field's kind, from its type as the source names it, and the icon that shows it. */
const KINDS: [RegExp, string, string][] = [
  [/^(bit|bool|boolean)$/, 'yes / no', 'lucide:toggle-left'],
  [/^(tinyint|smallint|int|integer|bigint|int\d*|serial|bigserial)$/, 'whole number', 'lucide:hash'],
  [/^(decimal|numeric|number|float\d*|real|double( precision)?|money|smallmoney|currency)$/, 'number', 'lucide:sigma'],
  [/^(datetime\w*|timestamp\w*|smalldatetime)$/, 'date and time', 'lucide:calendar-clock'],
  [/^date$/, 'date', 'lucide:calendar'],
  [/^time\w*$/, 'time', 'lucide:clock'],
  [/^(uniqueidentifier|uuid|guid)$/, 'identifier', 'lucide:fingerprint'],
  [/^(json|jsonb|xml)$/, 'structured', 'lucide:braces'],
  [/^(binary|varbinary|image|blob|bytea|rowversion)$/, 'binary', 'lucide:binary'],
  [/^(n?varchar|n?char|n?text|string|clob|citext|varchar2|nvarchar2|character( varying)?)$/, 'text', 'lucide:type'],
]
function kindOf(type?: string | null): { label: string; icon: string } {
  const t = (type ?? '').toLowerCase().replace(/\(.*\)/, '').trim()
  const k = KINDS.find(([re]) => re.test(t))
  return k ? { label: k[1], icon: k[2] } : { label: t || 'unknown', icon: 'lucide:circle-dashed' }
}

/** The rows of a table list and of a table's fields, made once per list (the same list, the same rows). */
const tableRowsOf = new WeakMap<TreeTable[], TreeColumnRow[]>(), fieldRowsOf = new WeakMap<TreeTable, TreeColumnRow[]>()
function tableRows(tables: TreeTable[]): TreeColumnRow[] {
  let rows = tableRowsOf.get(tables)
  if (!rows) tableRowsOf.set(tables, rows = tables.map((t) => ({ key: t.name, title: t.name, muted: !t.enabled, struck: t.gone, opens: true,
    aside: t.gone ? 'gone' : !t.enabled ? 'disabled' : t.fields.filter((f) => !f.gone).length.toLocaleString() })))
  return rows
}
function fieldRows(table: TreeTable): TreeColumnRow[] {
  let rows = fieldRowsOf.get(table)
  if (!rows) fieldRowsOf.set(table, rows = table.fields.map((f) => ({ key: f.name, title: f.name, icon: kindOf(f.type).icon, muted: !f.enabled, struck: f.gone,
    aside: f.gone ? 'gone' : !f.enabled ? 'disabled' : [f.key ? 'key' : '', f.type ?? ''].filter(Boolean).join(' · ') })))
  return rows
}

/** What the details are of, as their column's head says it. */
const DETAIL_OF = { source: { title: 'Data source', icon: 'lucide:database' }, table: { title: 'Table', icon: 'lucide:table-2' }, field: { title: 'Field', icon: 'lucide:text-cursor-input' } }

export interface TreeField { name: string; type?: string | null; key?: boolean | null; optional?: boolean | null; references?: string | null
  description?: string; descSource?: string | null; descHuman?: string | null; descAi?: string | null; enabled: boolean; gone: boolean }
export interface TreeTable { name: string; rows?: number | null; description?: string; descSource?: string | null; descHuman?: string | null; descAi?: string | null
  enabled: boolean; gone: boolean; fields: TreeField[] }

function Detail({ table, field, busy, onEnable, onDescribe, onReread }: { table: TreeTable; field: TreeField | null; busy?: boolean; onEnable?: (on: boolean) => void; onDescribe?: (text: string) => void; onReread?: () => void }) {
  const it = field ?? table
  const [text, setText] = useState(it.descHuman ?? '')
  const used = it.descHuman?.trim() ? 'person' : it.descSource?.trim() ? 'source' : it.descAi?.trim() ? 'ai' : null
  const desc = (who: 'person' | 'source' | 'ai', label: string, value?: string | null) => (
    <div className="sa-stree__desc" data-used={used === who}><span className="sa-stree__desc-who">{label}{used === who ? ' · used' : ''}</span><span>{value?.trim() || <span className="sa-faint">—</span>}</span></div>
  )
  return (
    <div className="sa-stree__card">
      <div className="sa-stree__card-head">
        <span className="sa-stree__card-title">{field ? <><span className="sa-faint">{table.name}.</span>{field.name}</> : table.name}</span>
        {it.gone ? <Status state="neutral">gone from the source</Status> : it.enabled ? <Status state="ok">enabled</Status> : <Status state="attention">disabled</Status>}
      </div>
      <dl className="sa-stree__facts">
        {field ? <>
          <dt>Type</dt><dd className="sa-row sa-row--tight"><Icon icon={kindOf(field.type).icon} width={14} height={14} />{field.type ?? '—'}<span className="sa-faint">{kindOf(field.type).label}</span></dd>
          <dt>Key</dt><dd>{field.key ? 'part of the key' : '—'}</dd>
          <dt>Optional</dt><dd>{field.optional == null ? '—' : field.optional ? 'may be empty' : 'always set'}</dd>
          <dt>References</dt><dd>{field.references ?? '—'}</dd>
        </> : <>
          <dt>Fields</dt><dd>{table.fields.filter((f) => !f.gone).length}{table.fields.some((f) => f.gone) ? ` (and ${table.fields.filter((f) => f.gone).length} gone)` : ''}</dd>
          <dt>Rows</dt><dd>{table.rows == null ? 'not counted' : table.rows.toLocaleString()}</dd>
        </>}
      </dl>
      <div className="sa-stree__descs">
        {desc('person', 'A person', it.descHuman)}
        {desc('source', 'The source', it.descSource)}
        {desc('ai', 'An AI', it.descAi)}
      </div>
      {onDescribe && !it.gone && (
        <form className="sa-stree__write" onSubmit={(e) => { e.preventDefault(); onDescribe(text.trim()) }}>
          <textarea className="sa-input" rows={3} placeholder="What it holds, in a sentence a colleague would understand" aria-label="A person's description" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="sa-btn sa-btn--primary" disabled={busy || text.trim() === (it.descHuman ?? '').trim()}>Save description</button>
        </form>
      )}
      {onEnable && !it.gone && (
        <div className="sa-stree__actions">
          <button type="button" className="sa-btn" disabled={busy} onClick={() => onEnable(!it.enabled)}>{it.enabled ? `Disable this ${field ? 'field' : 'table'}` : `Enable this ${field ? 'field' : 'table'}`}</button>
          <span className="sa-faint">{field ? 'A disabled field is left out of find-schema and get-schema.' : 'A disabled table hides all its fields from find-schema and get-schema.'} Queries are not blocked.</span>
        </div>
      )}
      {onReread && (
        <div className="sa-stree__actions">
          <button type="button" className="sa-btn" disabled={busy} onClick={onReread}><Icon icon="lucide:refresh-cw" className="sa-btn__icon" />Read this table again</button>
          <span className="sa-faint">Its fields as the source has them now; a field it no longer has is marked gone.</span>
        </div>
      )}
    </div>
  )
}
