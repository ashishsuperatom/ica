// EXPLORER — a warehouse, the whole page, as Rill lays it out: what can be explored on the left (its tables, then saved
// queries), the chosen one's rows in the middle, its columns profiled on the right; each pane scrolls on its own. One
// search above them: on the left it finds tables by their names, columns and descriptions; in the middle it searches the
// open table's data — in the warehouse, not only the rows on screen. A query's result is explored exactly like a table.
//
// The rows are a sheet: a click selects a cell (shift-click, shift-arrows: a range), arrow keys move and keep it in view,
// Ctrl/⌘-C copies it. The columns on the right: sorted by type, name, empty share or as in the table; a summary (a small
// histogram, or distinct against rows) or an example beside each; a column opens to its distribution and commonest values,
// each one a filter on the rows.
//
// It reads through one function, `read`, with structured requests — never SQL but a query's own — so one explorer serves
// whoever may read what. What it read is kept in this browser (an LRU of its own): shown at once when seen before, and
// always asked again.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { recall, remember } from '../../lib/remember'
import { notify } from '../../lib/toast'
import { lru } from '../../lib/lru'
import Histogram from '../ui/Histogram'

export interface ExplorerColumn { name: string; type: string; required?: boolean }
export interface ExplorerTable { name: string; columns: ExplorerColumn[]; rows?: number; appended?: number; owner?: string | null; description?: string; group?: string }
/** One of the reader's queries: named (saved) or not (recent), with when it last ran and how many rows it gave. */
export interface ExplorerQuery { id: number; name: string; sql: string; columns?: ExplorerColumn[] | null; runs?: number; lastRun?: string | null; lastRows?: number | null }
export interface ExplorerFilter { column: string; value: string | null }
type Narrow = { q: string; where: ExplorerFilter[] }
type Source = { table: string } | { query: { sql: string; columns?: ExplorerColumn[] } }
export type ExplorerRequest = Source & (
  | ({ op: 'rows'; sort?: string | null; dir?: 'asc' | 'desc'; page: number; size: number } & Narrow)
  | ({ op: 'values'; column: string } & Narrow)
  | { op: 'profile' }
  | ({ op: 'spread'; column: string } & Narrow)
  | { op: 'bins'; ranges: Record<string, [number, number]> })
interface Page { total: number; page: number; size: number; rows: Record<string, unknown>[]; columns?: ExplorerColumn[]; skipped?: string[]; recorded?: { id: number } }
interface ColumnProfile { name: string; type: string; kind: Kind; distinct: number | null; nulls: number; min: string | null; max: string | null; mean: number | null; q1: number | null; median: number | null; q3: number | null; trues: number | null }
interface Profile { rows: number; columns: ColumnProfile[] }
type Spread = { kind: 'numbers'; lo: number; hi: number; bins: number[] } | { kind: 'time'; unit: 'day' | 'month'; bins: { at: string; rows: number }[] } | { kind: 'none' }
export interface ExplorerPlace { key: string; label: string; icon: string; render: () => ReactNode }
type Read = (r: ExplorerRequest) => Promise<any>

type Kind = 'number' | 'time' | 'bool' | 'text'
const kindOf = (type: string): Kind => (/^(long|int|integer|double|float|decimal)/.test(type) ? 'number' : /^(date|timestamp|time)/.test(type) ? 'time' : type === 'boolean' ? 'bool' : 'text')
const GLYPH: Record<Kind, string> = { number: '#', text: 'A', time: '◷', bool: '◐' }
const SIZES = [50, 100, 250, 500]
const N = new Intl.NumberFormat()
const COMPACT = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const count = (n: number | null | undefined) => (n == null ? '—' : N.format(n))
const stat = (n: number | string | null | undefined) => { if (n == null) return '—'; const v = Number(n); return Number.isFinite(v) ? (Math.abs(v) >= 1000 ? N.format(Math.round(v)) : String(Math.round(v * 1000) / 1000)) : String(n) }
const shown = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const pct = (n: number) => (n > 0 && n < 0.1 ? '<0.1' : n.toFixed(1))

/** A read through the browser's cache: what was read before at once, then the warehouse's answer when it differs. */
function useRead<T>(read: Read, cache: ReturnType<typeof lru>, space: string, req: ExplorerRequest | null): { data: T | null; loading: boolean; error: string } {
  const key = req ? `${space}|${JSON.stringify(req)}` : ''
  const [state, setState] = useState<{ key: string; data: T | null; loading: boolean; error: string }>(() => ({ key, data: key ? cache.get<T>(key) ?? null : null, loading: !!key, error: '' }))
  useEffect(() => {
    if (!req) { setState({ key: '', data: null, loading: false, error: '' }); return }
    let live = true
    const kept = cache.get<T>(key) ?? null
    setState((s) => ({ key, data: kept ?? (s.key === key ? s.data : null), loading: true, error: '' }))
    read(req).then((fresh: T) => { if (!live) return; cache.set(key, fresh); setState({ key, data: fresh, loading: false, error: '' }) })
      .catch((e) => { if (live) setState((s) => ({ ...s, loading: false, error: message(e) })) })
    return () => { live = false }
  }, [key])   // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === key ? state : { data: key ? cache.get<T>(key) ?? null : null, loading: !!key, error: '' }
}

interface Opened { key: string; name: string; source: Source; columns: ExplorerColumn[]; table?: ExplorerTable; query?: ExplorerQuery | 'new' }

const queryTitle = (x: ExplorerQuery) => x.name || x.sql.replace(/\s+/g, ' ').slice(0, 80)
const ago = (iso?: string | null) => { if (!iso) return ''; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d` }

export function Explorer({ tables, read, actions, places = [], keep = 'explorer', empty, tablesHead, queries, onSaveQuery, onDeleteQuery, onQueriesChanged }: {
  tables: ExplorerTable[] | null
  read: Read
  /** What may be done to the chosen table: buttons in its head. */
  actions?: (t: ExplorerTable) => ReactNode
  /** Other places beside the tables, shown in the middle when picked. */
  places?: ExplorerPlace[]
  /** Where this browser keeps the explorer's settings and cache (one per warehouse and reader). */
  keep?: string
  empty?: ReactNode
  /** Beside the tables' heading (making a table). */
  tablesHead?: ReactNode
  /** Saved queries, explored like tables; with onSaveQuery, new ones can be written and saved. */
  queries?: ExplorerQuery[] | null
  onSaveQuery?: (q: { id?: number; name: string; sql: string; columns?: ExplorerColumn[] }) => Promise<ExplorerQuery>
  onDeleteQuery?: (id: number) => Promise<void>
  /** A query ran and the platform recorded it: read the reader's queries again. */
  onQueriesChanged?: () => Promise<void>
}) {
  const cache = useMemo(() => lru(`explorer.${keep}`), [keep])
  const [picked, setPicked] = useState<string | null>(() => recall<string | null>(`${keep}:open`, null))
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  useEffect(() => { const h = setTimeout(() => setQ(search.trim()), 350); return () => clearTimeout(h) }, [search])
  const [where, setWhere] = useState<ExplorerFilter[]>([])
  const [profileOpen, setProfileOpen] = useState(() => recall(`${keep}:profile`, true))
  const [learnt, setLearnt] = useState<Record<string, ExplorerColumn[]>>({})
  const [draft, setDraft] = useState<{ name: string; sql: string; ran: string | null }>({ name: '', sql: '', ran: null })
  const [runNo, setRunNo] = useState(0)
  // Folded groups (tables, queries, each owner's, saved, recent), kept in this browser; a search opens them all.
  const [closed, setClosed] = useState<Set<string>>(() => new Set(recall<string[]>(`${keep}:closed`, [])))
  const toggle = (id: string) => setClosed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); remember(`${keep}:closed`, [...n]); return n })
  const shut = (id: string) => closed.has(id) && !search.trim()
  const pick = (k: string) => { setPicked(k); remember(`${keep}:open`, k); setWhere([]) }
  const term = search.trim().toLowerCase()
  const matches = (t: ExplorerTable) => !term || t.name.toLowerCase().includes(term) || t.columns.some((c) => c.name.toLowerCase().includes(term)) || (t.description ?? '').toLowerCase().includes(term) || (t.owner ?? '').toLowerCase().includes(term)
  const groups = useMemo(() => {
    const out = new Map<string, ExplorerTable[]>()
    for (const t of tables ?? []) if (matches(t) || `t:${t.name}` === picked) out.set(t.group ?? '', [...(out.get(t.group ?? '') ?? []), t])
    return [...out]
  }, [tables, term, picked])   // eslint-disable-line react-hooks/exhaustive-deps
  const shownQueries = (queries ?? []).filter((x) => !term || x.name.toLowerCase().includes(term) || x.sql.toLowerCase().includes(term) || `q:${x.id}` === picked)
  const saved = shownQueries.filter((x) => x.name), recent = shownQueries.filter((x) => !x.name)
  /** Run SQL: as it is (again), or as a new query — recorded by the platform, then opened as one of the reader's. */
  const runSql = (sql: string, from: ExplorerQuery | null) => {
    if (from && sql.trim() === from.sql.trim()) { setRunNo((n) => n + 1); return }
    setDraft({ name: '', sql, ran: sql.trim() }); setLearnt((l) => ({ ...l, 'q:new': [] })); pick('q:new')
  }
  const recorded = useCallback(async (id: number) => {
    await onQueriesChanged?.()
    setPicked((p) => (p === 'q:new' ? `q:${id}` : p)); remember(`${keep}:open`, `q:${id}`)
  }, [onQueriesChanged, keep])
  const queryItem = (x: ExplorerQuery) => (
    <button key={x.id} className="sa-explorer__item" data-selected={picked === `q:${x.id}`} onClick={() => pick(`q:${x.id}`)} title={x.sql}>
      <Icon icon={x.name ? 'lucide:file-code-2' : 'lucide:history'} /><span className={`sa-explorer__name${x.name ? '' : ' sa-explorer__sqlname'}`}>{queryTitle(x)}</span>
      <span className="sa-explorer__n" title={x.lastRun ? `last ran ${new Date(x.lastRun).toLocaleString()}${x.lastRows != null ? ` · ${N.format(x.lastRows)} rows` : ''}` : undefined}>{x.lastRun ? ago(x.lastRun) : ''}</span>
    </button>)

  const opened: Opened | null = useMemo(() => {
    if (picked?.startsWith('t:')) { const t = tables?.find((x) => x.name === picked.slice(2)); return t ? { key: picked, name: t.name, source: { table: t.name }, columns: t.columns, table: t } : null }
    if (picked?.startsWith('q:') && picked !== 'q:new') {
      const x = queries?.find((y) => String(y.id) === picked.slice(2)); if (!x) return null
      const columns = learnt[picked] ?? x.columns ?? []
      return { key: picked, name: queryTitle(x), source: { query: { sql: x.sql, ...(columns.length ? { columns } : {}) } }, columns, query: x }
    }
    if (picked === 'q:new') {
      const columns = learnt['q:new'] ?? []
      return { key: picked, name: draft.name || 'New query', source: { query: { sql: draft.ran ?? '', ...(columns.length ? { columns } : {}) } }, columns, query: 'new' }
    }
    return null
  }, [picked, tables, queries, learnt, draft.ran, draft.name])
  const place = places.find((p) => `place:${p.key}` === picked) ?? null
  const togglePanel = () => setProfileOpen((o) => { remember(`${keep}:profile`, !o); return !o })
  const ready = !!opened && opened.columns.length > 0 && !(opened.query === 'new' && !draft.ran)
  const onColumns = useCallback((k: string, cols: ExplorerColumn[]) => setLearnt((l) => (JSON.stringify(l[k]) === JSON.stringify(cols) ? l : { ...l, [k]: cols })), [])

  return (
    <div className="sa-explorer">
      <div className="sa-explorer__panes" data-profile={ready && profileOpen && !place}>
        <aside className="sa-explorer__tables" aria-label="Tables and queries">
          {/* One search: it finds tables and queries here, and searches the open table's rows in the warehouse. */}
          <div className="sa-explorer__search" title={opened ? `Finds tables and columns, and searches the rows of ${opened.name}` : 'Finds tables and columns'}>
            <Icon icon="lucide:search" />
            <input id={`${keep}-search`} className="sa-col__input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={opened ? 'Search tables and rows' : 'Search tables and columns'} />
            {search && <button className="sa-icon-btn" aria-label="Clear the search" onClick={() => setSearch('')}><Icon icon="lucide:x" /></button>}
          </div>
          <div className="sa-explorer__list">
            <header className="sa-explorer__head">
              <button className="sa-explorer__fold" onClick={() => toggle('tables')} aria-expanded={!shut('tables')}><Icon icon={shut('tables') ? 'lucide:chevron-right' : 'lucide:chevron-down'} /><span className="sa-explorer__title">Tables</span>{tables && <span className="sa-col__count">{tables.length}</span>}</button>{tablesHead}</header>
            {!shut('tables') && <>
            {tables === null && Array.from({ length: 5 }, (_, i) => <div key={i} className="sa-explorer__item" aria-hidden><span /><span className="sa-skeleton" style={{ width: `${45 + ((i * 19) % 40)}%`, height: 11 }} /></div>)}
            {tables !== null && !tables.length && <p className="sa-col__empty">{empty ?? 'No tables yet.'}</p>}
            {tables !== null && tables.length > 0 && !groups.length && <p className="sa-col__empty">No table matches.</p>}
            {groups.map(([g, list]) => (
              <div key={g}>
                {g && <button className="sa-explorer__grouphead" onClick={() => toggle(`g:${g}`)} aria-expanded={!shut(`g:${g}`)}><Icon icon={shut(`g:${g}`) ? 'lucide:chevron-right' : 'lucide:chevron-down'} /><span className="sa-explorer__name">{g}</span><span className="sa-explorer__n">{list.length}</span></button>}
                {!(g && shut(`g:${g}`)) && list.map((t) => {
                  const col = term && !t.name.toLowerCase().includes(term) ? t.columns.find((c) => c.name.toLowerCase().includes(term)) : undefined
                  return (
                    <button key={t.name} className="sa-explorer__item" data-selected={picked === `t:${t.name}`} onClick={() => pick(`t:${t.name}`)} title={t.description || t.name}>
                      <Icon icon="lucide:table-2" />
                      <span className="sa-explorer__name">{t.name}{col && <span className="sa-muted"> · {col.name}</span>}</span>
                      <span className="sa-explorer__n">{t.rows != null ? COMPACT.format(t.rows) : ''}</span>
                    </button>
                  )
                })}
              </div>
            ))}
            </>}
            {(queries !== undefined || onSaveQuery) && <>
              <header className="sa-explorer__head sa-explorer__head--queries">
                <button className="sa-explorer__fold" onClick={() => toggle('queries')} aria-expanded={!shut('queries')}><Icon icon={shut('queries') ? 'lucide:chevron-right' : 'lucide:chevron-down'} /><span className="sa-explorer__title">Queries</span>{queries && <span className="sa-col__count">{queries.length}</span>}</button>
                {onSaveQuery && <button className="sa-btn sa-btn--link" onClick={() => { setDraft({ name: '', sql: '', ran: null }); setLearnt((l) => ({ ...l, 'q:new': [] })); pick('q:new') }}><Icon icon="lucide:plus" className="sa-btn__icon" />New</button>}</header>
              {!shut('queries') && <>
              {queries === null && <div className="sa-explorer__item" aria-hidden><span /><span className="sa-skeleton" style={{ width: '60%', height: 11 }} /></div>}
              {picked === 'q:new' && <button className="sa-explorer__item" data-selected><Icon icon="lucide:file-code-2" /><span className="sa-explorer__name">{draft.name || 'New query'}</span><span /></button>}
              {saved.length > 0 && <button className="sa-explorer__grouphead" onClick={() => toggle('saved')} aria-expanded={!shut('saved')}><Icon icon={shut('saved') ? 'lucide:chevron-right' : 'lucide:chevron-down'} /><span className="sa-explorer__name">Saved</span><span className="sa-explorer__n">{saved.length}</span></button>}
              {!shut('saved') && saved.map(queryItem)}
              {recent.length > 0 && <button className="sa-explorer__grouphead" onClick={() => toggle('recent')} aria-expanded={!shut('recent')}><Icon icon={shut('recent') ? 'lucide:chevron-right' : 'lucide:chevron-down'} /><span className="sa-explorer__name">Recent</span><span className="sa-explorer__n">{recent.length}</span></button>}
              {!shut('recent') && recent.map(queryItem)}
              {queries && !queries.length && picked !== 'q:new' && <p className="sa-col__empty">Your queries appear here once you run one.</p>}
              </>}
            </>}
          </div>
          {places.length > 0 && (
            <nav className="sa-explorer__places">
              {places.map((p) => <button key={p.key} className="sa-explorer__item" data-selected={picked === `place:${p.key}`} onClick={() => pick(`place:${p.key}`)}><Icon icon={p.icon} /><span className="sa-explorer__name">{p.label}</span><span /></button>)}
            </nav>
          )}
        </aside>
        <section className="sa-explorer__rows">
          {place ? <div className="sa-explorer__place">{place.render()}</div>
            : opened ? <>
              {opened.query ? <QueryHead key={opened.key} opened={opened} draft={draft} setDraft={setDraft} onRun={runSql} onSave={onSaveQuery} onDelete={onDeleteQuery} onSaved={async (x) => { setLearnt((l) => ({ ...l, [`q:${x.id}`]: opened.columns })); await onQueriesChanged?.(); pick(`q:${x.id}`) }} onGone={async () => { setPicked(null); await onQueriesChanged?.() }} profileOpen={profileOpen} togglePanel={togglePanel} ready={ready} />
                : <TableHead t={opened.table!} actions={actions} profileOpen={profileOpen} togglePanel={togglePanel} />}
              {ready || (opened.query && (opened.query !== 'new' || draft.ran))
                ? <Rows key={`${opened.key}|${JSON.stringify(opened.source)}|${runNo}`} opened={opened} read={read} cache={cache} space={keep} narrow={{ q, where }} setWhere={setWhere} keep={keep} onColumns={onColumns} onRecorded={recorded} />
                : <div className="sa-graphpage__hint"><Icon icon="lucide:file-code-2" /><span>Write a query and run it (⌘/Ctrl-Enter): its result is explored like a table — searched, filtered, sorted, its columns profiled.</span></div>}
            </>
            : <div className="sa-graphpage__hint"><Icon icon="lucide:table-2" /><span>{tables?.length ? 'Pick a table or a query on the left to see its rows and columns.' : tables === null ? 'Reading the tables…' : empty ?? 'No tables yet.'}</span></div>}
        </section>
        {opened && ready && profileOpen && !place && <aside className="sa-explorer__profile" aria-label="Its columns"><Columns key={`${opened.key}|${JSON.stringify(opened.source)}|${runNo}`} opened={opened} read={read} cache={cache} space={keep} narrow={{ q, where }} setWhere={setWhere} keep={keep} /></aside>}
      </div>
    </div>
  )
}

function PanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button className="sa-icon-btn" title={open ? 'Hide the columns' : 'Show the columns'} aria-label={open ? 'Hide the columns' : 'Show the columns'} onClick={onToggle}><Icon icon={open ? 'lucide:panel-right-close' : 'lucide:panel-right-open'} /></button>
}

function TableHead({ t, actions, profileOpen, togglePanel }: { t: ExplorerTable; actions?: (t: ExplorerTable) => ReactNode; profileOpen: boolean; togglePanel: () => void }) {
  return (
    <header className="sa-explorer__tablehead">
      <div className="sa-explorer__what"><strong>{t.name}</strong><span className="sa-muted">{[t.owner ? `owned by ${t.owner}` : 'no owner set', t.description].filter(Boolean).join(' · ')}</span></div>
      <span className="sa-explorer__acts">{actions?.(t)}<PanelToggle open={profileOpen} onToggle={togglePanel} /></span>
    </header>
  )
}

/** A query's head: its name and SQL (open to edit), run, save, delete. */
function QueryHead({ opened, draft, setDraft, onRun, onSave, onDelete, onSaved, onGone, profileOpen, togglePanel, ready }: {
  opened: Opened; draft: { name: string; sql: string; ran: string | null }; setDraft: (d: { name: string; sql: string; ran: string | null }) => void
  onRun: (sql: string, from: ExplorerQuery | null) => void
  onSave?: (q: { id?: number; name: string; sql: string; columns?: ExplorerColumn[] }) => Promise<ExplorerQuery>; onDelete?: (id: number) => Promise<void>
  onSaved: (q: ExplorerQuery) => Promise<void>; onGone: () => Promise<void>; profileOpen: boolean; togglePanel: () => void; ready: boolean
}) {
  const saved = opened.query !== 'new' ? opened.query as ExplorerQuery : null
  const [name, setName] = useState(saved?.name ?? draft.name)
  const [sql, setSql] = useState(saved?.sql ?? draft.sql)
  const [open, setOpen] = useState(!saved)
  const changed = !!saved && (sql.trim() !== saved.sql.trim() || name !== saved.name)
  const run = () => { if (sql.trim()) onRun(sql, saved) }
  const save = async () => {
    if (!onSave) return
    if (!name.trim()) { notify('Name the query to save it', 'refused'); return }
    try { const x = await onSave({ ...(saved ? { id: saved.id } : {}), name: name.trim(), sql: sql.trim(), ...(opened.columns.length && (!saved || sql.trim() === saved.sql.trim()) ? { columns: opened.columns } : {}) }); notify(`Saved ${x.name}`, 'note'); await onSaved(x) }
    catch (e) { notify(message(e), 'refused') }
  }
  return (
    <header className="sa-explorer__queryhead">
      <div className="sa-explorer__tablehead sa-explorer__tablehead--query">
        <Icon icon="lucide:file-code-2" />
        <input id="explorer-query-name" className="sa-explorer__qname" value={name} placeholder="Name it to save it" onChange={(e) => { setName(e.target.value); if (!saved) setDraft({ ...draft, name: e.target.value }) }} />
        <span className="sa-explorer__acts">
          <button className="sa-btn sa-btn--link" onClick={() => setOpen((o) => !o)}><Icon icon={open ? 'lucide:chevron-up' : 'lucide:code'} className="sa-btn__icon" />{open ? 'Hide SQL' : 'SQL'}</button>
          <button className="sa-btn sa-btn--primary" disabled={!sql.trim()} onClick={run} title="⌘/Ctrl-Enter"><Icon icon="lucide:play" className="sa-btn__icon" />{saved && sql.trim() === saved.sql.trim() ? 'Run again' : 'Run'}</button>
          {onSave && (!saved || changed || !saved.name) && <button className="sa-btn" onClick={() => void save()}><Icon icon="lucide:save" className="sa-btn__icon" />Save</button>}
          {saved && onDelete && <button className="sa-icon-btn" title="Remove from your queries" aria-label="Remove from your queries" onClick={() => { if (confirm(`Remove ${saved.name || 'this query'} from your queries?`)) void onDelete(saved.id).then(onGone) }}><Icon icon="lucide:trash-2" /></button>}
          {ready && <PanelToggle open={profileOpen} onToggle={togglePanel} />}
        </span>
      </div>
      {open && <textarea id="explorer-query-sql" className="sa-input sa-input--mono sa-explorer__sql" rows={Math.min(14, Math.max(3, sql.split('\n').length + 1))} value={sql} spellCheck={false}
        placeholder="SELECT … FROM a table, named plainly — name each computed column with AS so it can be searched and profiled"
        onChange={(e) => { setSql(e.target.value); if (!saved) setDraft({ ...draft, sql: e.target.value }) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); run() } }} />}
    </header>
  )
}

function Rows({ opened, read, cache, space, narrow, setWhere, keep, onColumns, onRecorded }: { opened: Opened; read: Read; cache: ReturnType<typeof lru>; space: string; narrow: Narrow; setWhere: (w: ExplorerFilter[]) => void; keep: string; onColumns: (key: string, cols: ExplorerColumn[]) => void; onRecorded: (id: number) => void }) {
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null)
  const [pageNo, setPageNo] = useState(1)
  const [size, setSize] = useState(() => { const n = recall(`${keep}:size`, 100); return SIZES.includes(n) ? n : 100 })
  const [goto, setGoto] = useState('')
  const narrowKey = JSON.stringify([narrow, sort, size])
  useEffect(() => setPageNo(1), [narrowKey])
  const { data: page, loading, error } = useRead<Page>(read, cache, space, { ...opened.source, op: 'rows', q: narrow.q, where: narrow.where, sort: sort?.column ?? null, dir: sort?.dir, page: pageNo, size } as ExplorerRequest)
  useEffect(() => { if (page?.columns?.length) onColumns(opened.key, page.columns) }, [page?.columns, opened.key, onColumns])
  useEffect(() => { if (page?.recorded?.id && !loading) onRecorded(page.recorded.id) }, [page?.recorded?.id, loading])   // eslint-disable-line react-hooks/exhaustive-deps
  const columns = page?.columns?.length ? page.columns : opened.columns
  const rows = page?.rows ?? []

  // The sheet: a selected cell (and a range from the anchor), moved by the keys, kept in view, copied with Ctrl/⌘-C.
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null)
  const [anchor, setAnchor] = useState<{ r: number; c: number } | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  useEffect(() => { setSel(null); setAnchor(null) }, [pageNo, narrowKey, opened.key])
  useEffect(() => { if (sel) grid.current?.querySelector<HTMLElement>(`[data-cell="${sel.r}:${sel.c}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }, [sel])
  const range = sel && anchor ? { r0: Math.min(sel.r, anchor.r), r1: Math.max(sel.r, anchor.r), c0: Math.min(sel.c, anchor.c), c1: Math.max(sel.c, anchor.c) } : sel ? { r0: sel.r, r1: sel.r, c0: sel.c, c1: sel.c } : null
  const inRange = (r: number, c: number) => !!range && r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1
  const choose = (r: number, c: number, extend: boolean) => { if (extend && sel) { setAnchor(anchor ?? sel); setSel({ r, c }) } else { setSel({ r, c }); setAnchor(null) } }
  const copy = () => {
    if (!range) return
    const lines: string[] = []
    for (let r = range.r0; r <= range.r1; r++) lines.push(columns.slice(range.c0, range.c1 + 1).map((col) => shown(rows[r]?.[col.name]) ?? '').join('\t'))
    const n = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1)
    navigator.clipboard?.writeText(lines.join('\n')).then(() => notify(n === 1 ? 'Copied' : `Copied ${n} cells`, 'note'), () => notify('Could not copy', 'refused'))
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!sel) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(); return }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); setAnchor({ r: 0, c: 0 }); setSel({ r: rows.length - 1, c: columns.length - 1 }); return }
    if (e.key === 'Escape') { setSel(null); setAnchor(null); return }
    const step: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-20, 0], PageDown: [20, 0], Tab: [0, e.shiftKey ? -1 : 1], Enter: [e.shiftKey ? -1 : 1, 0] }
    let next: { r: number; c: number } | null = null
    if (e.key === 'Home') next = { r: (e.metaKey || e.ctrlKey) ? 0 : sel.r, c: 0 }
    else if (e.key === 'End') next = { r: (e.metaKey || e.ctrlKey) ? rows.length - 1 : sel.r, c: columns.length - 1 }
    else if (step[e.key]) { const [dr, dc] = step[e.key]; next = { r: sel.r + dr, c: sel.c + dc } }
    if (!next) return
    e.preventDefault()
    next = { r: Math.max(0, Math.min(rows.length - 1, next.r)), c: Math.max(0, Math.min(columns.length - 1, next.c)) }
    if (e.shiftKey && e.key.startsWith('Arrow')) { setAnchor(anchor ?? sel); setSel(next) } else { setSel(next); setAnchor(null) }
  }

  const pages = page ? Math.max(1, Math.ceil(page.total / size)) : 1
  const go = (n: number) => setPageNo(Math.min(Math.max(1, n), pages))
  const from = (pageNo - 1) * size
  const selected = sel ? shown(rows[sel.r]?.[columns[sel.c]?.name ?? '']) : null
  return (<>
    {(narrow.where.length > 0 || (page?.skipped?.length ?? 0) > 0) && (
      <div className="sa-explorer__narrow">
        {narrow.where.map((w) => (
          <button key={w.column} className="sa-chip" title="Remove this filter" onClick={() => setWhere(narrow.where.filter((x) => x !== w))}><span>{w.column} = {w.value ?? 'empty'}</span><Icon icon="lucide:x" /></button>))}
        {page?.skipped?.length ? <span className="sa-note">Not shown, unnamed: {page.skipped.join(', ')} — name them with AS</span> : null}
      </div>
    )}
    <div className="sa-explorer__grid" data-loading={loading && !!page} ref={grid} tabIndex={0} onKeyDown={onKey} aria-label="Rows — arrow keys move, Ctrl/⌘-C copies">
      {error && <p className="sa-col__empty sa-explorer__error">{error}</p>}
      {!page && !error && <table className="sa-explorer__table" aria-hidden><tbody>{Array.from({ length: 12 }, (_, i) => <tr key={i}><td className="sa-explorer__no" />{(columns.length ? columns : Array.from({ length: 5 }, (_, k) => ({ name: String(k) }))).slice(0, 8).map((c, k) => <td key={c.name}><span className="sa-skeleton" style={{ width: `${40 + ((i * 13 + k * 17) % 50)}%`, height: 10 }} /></td>)}</tr>)}</tbody></table>}
      {page && (
        <table className="sa-explorer__table">
          <thead><tr>
            <th className="sa-explorer__no">#</th>
            {columns.map((c) => (
              <th key={c.name} data-kind={kindOf(c.type)} title={`${c.name} · ${c.type} — click to sort`} onClick={() => setSort(sort?.column === c.name && sort.dir === 'asc' ? { column: c.name, dir: 'desc' } : sort?.column === c.name ? null : { column: c.name, dir: 'asc' })}>
                <span className="sa-explorer__glyph">{GLYPH[kindOf(c.type)]}</span>{c.name}
                {sort?.column === c.name && <Icon icon={sort.dir === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'} />}
              </th>))}
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} data-row-sel={sel?.r === i}>
                <td className="sa-explorer__no">{from + i + 1}</td>
                {columns.map((c, k) => { const v = shown(r[c.name]); return (
                  <td key={c.name} data-cell={`${i}:${k}`} data-kind={kindOf(c.type)} data-sel={sel?.r === i && sel?.c === k} data-range={inRange(i, k) && !(sel?.r === i && sel?.c === k)}
                    onMouseDown={(e) => { if (e.shiftKey) e.preventDefault(); choose(i, k, e.shiftKey) }} title={v ?? 'empty'}>{v ?? <span className="sa-explorer__null">empty</span>}</td>) })}
              </tr>))}
          </tbody>
        </table>
      )}
      {page && !rows.length && <p className="sa-col__empty">No rows{narrow.q || narrow.where.length ? ' match' : ''}.</p>}
    </div>
    <footer className="sa-explorer__pager">
      <span className="sa-explorer__n">{page ? `${count(page.total ? from + 1 : 0)}–${count(Math.min(from + size, page.total))} of ${count(page.total)} rows${narrow.q || narrow.where.length ? ' matching' : ''}` : '…'}</span>
      {loading && <Icon icon="lucide:loader-2" className="sa-spin" />}
      <span className="sa-note sa-explorer__cell">{sel ? <>{columns[sel.c]?.name}: <strong>{selected ?? 'empty'}</strong>{range && (range.r1 > range.r0 || range.c1 > range.c0) ? ` · ${(range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1)} cells` : ''} · ⌘/Ctrl-C copies</> : 'Click a cell to select it · arrows move · ⇧ extends'}</span>
      <span className="sa-explorer__pagerright">
        <select id={`${keep}-size`} className="sa-input sa-input--compact" value={size} title="Rows a page" onChange={(e) => { const n = Number(e.target.value); setSize(n); remember(`${keep}:size`, n) }}>{SIZES.map((n) => <option key={n} value={n}>{n} a page</option>)}</select>
        <button className="sa-icon-btn" disabled={pageNo <= 1} onClick={() => go(1)} aria-label="First page" title="First page"><Icon icon="lucide:chevrons-left" /></button>
        <button className="sa-icon-btn" disabled={pageNo <= 1} onClick={() => go(pageNo - 1)} aria-label="Previous page" title="Previous page"><Icon icon="lucide:chevron-left" /></button>
        <span className="sa-explorer__n">Page <input id={`${keep}-page`} className="sa-input sa-input--compact sa-explorer__goto" value={goto || String(pageNo)} onChange={(e) => setGoto(e.target.value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && goto) { go(Number(goto)); setGoto('') } }} onBlur={() => setGoto('')} /> of {count(pages)}</span>
        <button className="sa-icon-btn" disabled={pageNo >= pages} onClick={() => go(pageNo + 1)} aria-label="Next page" title="Next page"><Icon icon="lucide:chevron-right" /></button>
        <button className="sa-icon-btn" disabled={pageNo >= pages} onClick={() => go(pages)} aria-label="Last page" title="Last page"><Icon icon="lucide:chevrons-right" /></button>
      </span>
    </footer>
  </>)
}

type SortBy = 'type' | 'name' | 'empty' | 'table'
const TYPE_RANK: Record<Kind, number> = { time: 0, number: 1, bool: 2, text: 3 }
const epoch = (s: string | null) => { if (!s) return NaN; const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s); return t / 1000 }

function Columns({ opened, read, cache, space, narrow, setWhere, keep }: { opened: Opened; read: Read; cache: ReturnType<typeof lru>; space: string; narrow: Narrow; setWhere: (w: ExplorerFilter[]) => void; keep: string }) {
  const { data: profile, error } = useRead<Profile>(read, cache, space, { ...opened.source, op: 'profile' } as ExplorerRequest)
  const ranges = useMemo(() => {
    if (!profile) return null
    const out: Record<string, [number, number]> = {}
    for (const p of profile.columns) {
      if (p.kind === 'number') { const lo = Number(p.min), hi = Number(p.max); if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) out[p.name] = [lo, hi] }
      if (p.kind === 'time') { const lo = epoch(p.min), hi = epoch(p.max); if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) out[p.name] = [lo, hi] }
    }
    return Object.keys(out).length ? out : null
  }, [profile])
  const { data: bins } = useRead<{ bins: Record<string, number[]> }>(read, cache, space, ranges ? { ...opened.source, op: 'bins', ranges } as ExplorerRequest : null)
  const [open, setOpen] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<SortBy>(() => recall<SortBy>(`${keep}:colsort`, 'table'))
  const [show, setShow] = useState<'summary' | 'example'>(() => recall<'summary' | 'example'>(`${keep}:colshow`, 'summary'))
  const by = new Map((profile?.columns ?? []).map((p) => [p.name, p]))
  const rows = profile?.rows ?? opened.table?.rows ?? null
  const emptyPct = profile && profile.rows ? (profile.columns.reduce((a, p) => a + p.nulls, 0) / (profile.rows * Math.max(1, profile.columns.length))) * 100 : null
  const list = opened.columns.map((c, i) => ({ c, i, p: by.get(c.name), k: kindOf(c.type) }))
  if (sortBy === 'type') list.sort((a, b) => TYPE_RANK[a.k] - TYPE_RANK[b.k] || (a.k === 'text' ? (b.p?.distinct ?? 0) - (a.p?.distinct ?? 0) : a.i - b.i))
  if (sortBy === 'name') list.sort((a, b) => a.c.name.localeCompare(b.c.name))
  if (sortBy === 'empty') list.sort((a, b) => (b.p?.nulls ?? 0) - (a.p?.nulls ?? 0))
  return (
    <div className="sa-explorer__cols">
      <div className="sa-explorer__facts">
        <div><strong>{count(rows)}</strong><span>rows</span></div>
        <div><strong>{opened.columns.length}</strong><span>columns</span></div>
        <div><strong>{emptyPct == null ? '—' : `${pct(emptyPct)}%`}</strong><span>empty</span></div>
      </div>
      {opened.query && opened.query !== 'new' && <dl className="sa-explorer__meta">
        <dt>{opened.query.name ? 'Saved query' : 'Recent query'}</dt><dd>{opened.query.runs ? `ran ${opened.query.runs} time${opened.query.runs === 1 ? '' : 's'}` : ''}</dd>
        {opened.query.lastRun && <><dt>Last ran</dt><dd>{new Date(opened.query.lastRun).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd></>}
        {opened.query.lastRows != null && <><dt>Rows then</dt><dd>{count(opened.query.lastRows)}</dd></>}
      </dl>}
      {opened.table && (opened.table.owner || opened.table.appended) && <dl className="sa-explorer__meta">
        {opened.table.owner && <><dt>Owner</dt><dd>{opened.table.owner}</dd></>}
        {opened.table.appended && <><dt>Last added to</dt><dd>{new Date(opened.table.appended).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd></>}
      </dl>}
      <div className="sa-explorer__colshead">
        <h3 className="sa-label">Columns</h3>
        <select id={`${keep}-colsort`} className="sa-explorer__mini" value={sortBy} onChange={(e) => { setSortBy(e.target.value as SortBy); remember(`${keep}:colsort`, e.target.value) }}>
          <option value="table">as in the table</option><option value="type">sort by type</option><option value="name">sort by name</option><option value="empty">sort by empty %</option>
        </select>
        <select id={`${keep}-colshow`} className="sa-explorer__mini" value={show} onChange={(e) => { setShow(e.target.value as 'summary' | 'example'); remember(`${keep}:colshow`, e.target.value) }}>
          <option value="summary">show summary</option><option value="example">show example</option>
        </select>
      </div>
      {error && <p className="sa-col__empty sa-explorer__error">{error}</p>}
      <ul className="sa-explorer__collist">
        {list.map(({ c, p, k }) => {
          const isOpen = open === c.name
          const nulls = p && rows ? (p.nulls / Math.max(1, rows)) * 100 : 0
          const spark = bins?.bins?.[c.name]
          return (
            <li key={c.name}>
              <button className="sa-explorer__col" data-open={isOpen} onClick={() => setOpen(isOpen ? null : c.name)} title={`${c.name} · ${c.type}${p ? ` · ${count(p.distinct)} distinct · ${pct(nulls)}% empty` : ''}`}>
                <span className="sa-explorer__glyph">{GLYPH[k]}</span>
                <span className="sa-explorer__name">{c.name}</span>
                {show === 'example'
                  ? <span className="sa-explorer__example">{p ? (p.min ?? p.max ?? <i className="sa-explorer__null">empty</i>) : ''}</span>
                  : <>
                    <span className="sa-explorer__bar" title={spark ? 'How its values spread' : 'Distinct values, against the rows'}>
                      {!p ? <span className="sa-skeleton" style={{ width: '60%', height: 8 }} />
                        : spark ? <Spark bins={spark} />
                        : <><span className="sa-explorer__distinct" style={{ width: `${Math.min(100, Math.max(2, ((p.distinct ?? 0) / Math.max(1, rows ?? 1)) * 100))}%` }} /><em>{COMPACT.format(p.distinct ?? 0)}</em></>}
                    </span>
                    <span className="sa-explorer__empty" data-much={nulls >= 50} data-some={nulls > 0}>{p ? `${pct(nulls)}%` : ''}</span>
                  </>}
              </button>
              {isOpen && <ColumnDetail opened={opened} c={c} p={p} rows={rows} read={read} cache={cache} space={space} narrow={narrow} setWhere={setWhere} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** The small chart beside a column: its twenty bins, scaled to the tallest. */
function Spark({ bins }: { bins: number[] }) {
  const max = Math.max(1, ...bins)
  return <span className="sa-explorer__spark">{bins.map((n, i) => <span key={i} style={{ height: `${n ? Math.max(8, (n / max) * 100) : 0}%` }} />)}</span>
}

function ColumnDetail({ opened, c, p, rows, read, cache, space, narrow, setWhere }: { opened: Opened; c: ExplorerColumn; p?: ColumnProfile; rows: number | null; read: Read; cache: ReturnType<typeof lru>; space: string; narrow: Narrow; setWhere: (w: ExplorerFilter[]) => void }) {
  const k = kindOf(c.type)
  const others = narrow.where.filter((w) => w.column !== c.name)
  const { data: spread } = useRead<Spread>(read, cache, space, k === 'number' || k === 'time' ? { ...opened.source, op: 'spread', column: c.name, q: narrow.q, where: narrow.where } as ExplorerRequest : null)
  const { data: values, error } = useRead<{ values: { value: string | null; rows: number }[] }>(read, cache, space, { ...opened.source, op: 'values', column: c.name, q: narrow.q, where: others } as ExplorerRequest)
  const top = values?.values?.[0]?.rows ?? 1
  const total = Math.max(1, rows ?? 1)
  const pick = (value: string | null) => setWhere([...others, { column: c.name, value }])
  return (
    <div className="sa-explorer__detail">
      {error && <p className="sa-explorer__error">{error}</p>}
      <div className="sa-explorer__detailhead"><span className="sa-label">{k === 'text' || k === 'bool' ? 'Commonest values' : 'Distribution'}{narrow.q || others.length ? ', within the search and filters' : ''}</span>
        <button className="sa-btn sa-btn--link" onClick={() => navigator.clipboard?.writeText(c.name).then(() => notify(`Copied ${c.name}`, 'note'))}><Icon icon="lucide:copy" className="sa-btn__icon" />Name</button></div>
      {(k === 'number' || k === 'time') && !spread && <span className="sa-skeleton" style={{ width: '100%', height: 120 }} />}
      {spread?.kind === 'numbers' && <><Histogram bins={spread.bins} labels={spread.bins.map((_, i) => { const w = (spread.hi - spread.lo) / spread.bins.length; return `${stat(spread.lo + i * w)} – ${stat(spread.lo + (i + 1) * w)}` })} />
        <div className="sa-explorer__axis"><span>{stat(spread.lo)}</span><span>{stat(spread.hi)}</span></div></>}
      {spread?.kind === 'time' && <><Histogram bins={spread.bins.map((b) => b.rows)} labels={spread.bins.map((b) => b.at)} />
        <div className="sa-explorer__axis"><span>{spread.bins[0]?.at ?? ''}</span><span>rows a {spread.unit}</span><span>{spread.bins[spread.bins.length - 1]?.at ?? ''}</span></div></>}
      {p && k === 'number' && <dl className="sa-explorer__stats">{([['min', p.min], ['first quarter', p.q1], ['median', p.median], ['third quarter', p.q3], ['max', p.max], ['mean', p.mean], ['distinct', p.distinct], ['empty', p.nulls]] as const).map(([l, v]) => <div key={l}><dt>{l}</dt><dd>{stat(v)}</dd></div>)}</dl>}
      {p && k === 'time' && <dl className="sa-explorer__stats"><div><dt>first</dt><dd>{p.min ?? '—'}</dd></div><div><dt>last</dt><dd>{p.max ?? '—'}</dd></div><div><dt>distinct</dt><dd>{count(p.distinct)}</dd></div><div><dt>empty</dt><dd>{count(p.nulls)}</dd></div></dl>}
      {p && k === 'bool' && <dl className="sa-explorer__stats"><div><dt>true</dt><dd>{count(p.trues)}</dd></div><div><dt>false</dt><dd>{count(total - (p.trues ?? 0) - p.nulls)}</dd></div><div><dt>empty</dt><dd>{count(p.nulls)}</dd></div></dl>}
      {p && k === 'text' && <dl className="sa-explorer__stats"><div><dt>distinct</dt><dd>{count(p.distinct)}</dd></div><div><dt>empty</dt><dd>{count(p.nulls)}</dd></div><div><dt>first, last</dt><dd>{p.min ?? '—'} … {p.max ?? '—'}</dd></div></dl>}
      {k !== 'text' && k !== 'bool' && <span className="sa-label">Commonest values</span>}
      {!values ? <span className="sa-skeleton" style={{ width: '70%', height: 10 }} /> : (
        <ul className="sa-explorer__values">
          {values.values.map((v) => (
            <li key={String(v.value)}><button onClick={() => pick(v.value)} title={`${v.value ?? 'empty'} — show only these rows`}>
              <span className="sa-explorer__valuebar" style={{ width: `${Math.max(2, (v.rows / top) * 100)}%` }} />
              <span className="sa-explorer__name">{v.value ?? <i className="sa-explorer__null">empty</i>}</span>
              <span className="sa-explorer__n">{count(v.rows)} <em>{pct((v.rows / total) * 100)}%</em></span>
            </button></li>))}
          {!values.values.length && <li className="sa-note">No values.</li>}
        </ul>
      )}
    </div>
  )
}
