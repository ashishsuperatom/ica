// EXPLORER — a warehouse's tables, the whole page, in three panes that scroll on their own: the tables on the left
// (searched by table and column name, grouped), the chosen table's rows in the middle (searched across every column,
// filtered by values picked on the right, sorted by a header, paged), and its columns profiled on the right (distinct
// values, how much is empty; a column opens to its spread and commonest values, each one a filter). A click copies a
// cell, shift-click the row. What the reader may do to a table (add rows, set its owner, grant it) comes in as `actions`;
// other places beside the tables (asking in SQL, the record) as `places`, shown in the middle when picked.
//
// It reads through one function, `read`, with structured requests — never SQL — so the same explorer serves whoever may
// read what: the organisation's administrator (everything) and a project (only its grant).

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { recall, remember } from '../../lib/remember'
import { notify } from '../../lib/toast'

export interface ExplorerColumn { name: string; type: string; required?: boolean }
export interface ExplorerTable { name: string; columns: ExplorerColumn[]; rows?: number; appended?: number; owner?: string | null; description?: string; group?: string }
export interface ExplorerFilter { column: string; value: string | null }
type Narrow = { q: string; where: ExplorerFilter[] }
export type ExplorerRequest =
  | ({ op: 'rows'; table: string; sort?: string | null; dir?: 'asc' | 'desc'; page: number; size: number } & Narrow)
  | ({ op: 'values'; table: string; column: string } & Narrow)
  | { op: 'profile'; table: string }
  | ({ op: 'spread'; table: string; column: string } & Narrow)
interface Page { total: number; page: number; size: number; rows: Record<string, unknown>[] }
interface ColumnProfile { name: string; type: string; kind: Kind; distinct: number | null; nulls: number; min: string | null; max: string | null; mean: number | null; q1: number | null; median: number | null; q3: number | null; trues: number | null }
interface Profile { rows: number; columns: ColumnProfile[] }
type Spread = { kind: 'numbers'; lo: number; hi: number; bins: number[] } | { kind: 'time'; unit: 'day' | 'month'; bins: { at: string; rows: number }[] } | { kind: 'none' }
export interface ExplorerPlace { key: string; label: string; icon: string; render: () => ReactNode }

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

export function Explorer({ tables, read, actions, places = [], keep = 'explorer', empty, tablesHead }: {
  tables: ExplorerTable[] | null
  read: (r: ExplorerRequest) => Promise<any>
  /** What may be done to the chosen table: buttons in its head. */
  actions?: (t: ExplorerTable) => ReactNode
  /** Other places beside the tables, shown in the middle when picked. */
  places?: ExplorerPlace[]
  /** Where this browser keeps the explorer's settings. */
  keep?: string
  /** Said when there are no tables. */
  empty?: ReactNode
  /** Beside the tables' heading (making a table). */
  tablesHead?: ReactNode
}) {
  const [picked, setPicked] = useState<string | null>(() => recall<string | null>(`${keep}:table`, null))
  const [find, setFind] = useState('')
  const [profileOpen, setProfileOpen] = useState(() => recall(`${keep}:profile`, true))
  const [narrow, setNarrow] = useState<Narrow>({ q: '', where: [] })
  const pick = (k: string) => { setPicked(k); remember(`${keep}:table`, k); setNarrow({ q: '', where: [] }) }
  const term = find.trim().toLowerCase()
  const groups = useMemo(() => {
    const out = new Map<string, ExplorerTable[]>()
    for (const t of tables ?? []) {
      if (term && !t.name.toLowerCase().includes(term) && !t.columns.some((c) => c.name.toLowerCase().includes(term)) && !(t.description ?? '').toLowerCase().includes(term)) continue
      const g = t.group ?? ''
      out.set(g, [...(out.get(g) ?? []), t])
    }
    return [...out]
  }, [tables, term])
  const table = tables?.find((t) => t.name === picked) ?? null
  const place = places.find((p) => `place:${p.key}` === picked) ?? null
  const togglePanel = () => setProfileOpen((o) => { remember(`${keep}:profile`, !o); return !o })

  return (
    <div className="sa-explorer" data-profile={!!table && profileOpen}>
      <aside className="sa-explorer__tables" aria-label="Tables">
        <header className="sa-explorer__head">
          <span className="sa-explorer__title">Tables{tables && <span className="sa-col__count">{tables.length}</span>}</span>
          {tablesHead}
        </header>
        <div className="sa-explorer__find"><Icon icon="lucide:search" /><input id={`${keep}-find`} className="sa-col__input" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Table or column" /></div>
        <div className="sa-explorer__list">
          {tables === null && Array.from({ length: 6 }, (_, i) => <div key={i} className="sa-explorer__item" aria-hidden><span className="sa-skeleton" style={{ width: `${45 + ((i * 19) % 40)}%`, height: 11 }} /></div>)}
          {tables !== null && !tables.length && <p className="sa-col__empty">{empty ?? 'No tables yet.'}</p>}
          {tables !== null && tables.length > 0 && !groups.length && <p className="sa-col__empty">Nothing matches.</p>}
          {groups.map(([g, list]) => (
            <div key={g}>
              {g && <div className="sa-col__group">{g} <span className="sa-col__count">{list.length}</span></div>}
              {list.map((t) => {
                const col = term && !t.name.toLowerCase().includes(term) ? t.columns.find((c) => c.name.toLowerCase().includes(term)) : undefined
                return (
                  <button key={t.name} className="sa-explorer__item" data-selected={picked === t.name} onClick={() => pick(t.name)} title={t.description || t.name}>
                    <Icon icon="lucide:table-2" />
                    <span className="sa-explorer__name">{t.name}{col && <span className="sa-muted"> · {col.name}</span>}</span>
                    <span className="sa-explorer__n">{t.rows != null ? COMPACT.format(t.rows) : ''}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {places.length > 0 && (
          <nav className="sa-explorer__places">
            {places.map((p) => <button key={p.key} className="sa-explorer__item" data-selected={picked === `place:${p.key}`} onClick={() => pick(`place:${p.key}`)}><Icon icon={p.icon} /><span className="sa-explorer__name">{p.label}</span></button>)}
          </nav>
        )}
      </aside>
      <section className="sa-explorer__rows">
        {place ? <div className="sa-explorer__place">{place.render()}</div>
          : table ? <Rows key={table.name} t={table} read={read} narrow={narrow} setNarrow={setNarrow} actions={actions} profileOpen={profileOpen} togglePanel={togglePanel} keep={keep} />
          : <div className="sa-graphpage__hint"><Icon icon="lucide:table-2" /><span>{tables?.length ? 'Pick a table on the left to see its rows and columns.' : tables === null ? 'Reading the tables…' : empty ?? 'No tables yet.'}</span></div>}
      </section>
      {table && profileOpen && !place && <aside className="sa-explorer__profile" aria-label="Its columns"><Columns key={table.name} t={table} read={read} narrow={narrow} setNarrow={setNarrow} /></aside>}
    </div>
  )
}

function Rows({ t, read, narrow, setNarrow, actions, profileOpen, togglePanel, keep }: { t: ExplorerTable; read: (r: ExplorerRequest) => Promise<any>; narrow: Narrow; setNarrow: (n: Narrow) => void; actions?: (t: ExplorerTable) => ReactNode; profileOpen: boolean; togglePanel: () => void; keep: string }) {
  const [typed, setTyped] = useState(narrow.q)
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | null>(null)
  const [pageNo, setPageNo] = useState(1)
  const [size, setSize] = useState(() => { const n = recall(`${keep}:size`, 100); return SIZES.includes(n) ? n : 100 })
  const [page, setPage] = useState<Page | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [goto, setGoto] = useState('')
  useEffect(() => { const h = setTimeout(() => { if (typed !== narrow.q) setNarrow({ ...narrow, q: typed }) }, 300); return () => clearTimeout(h) }, [typed])   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setTyped(narrow.q), [narrow.q])
  const key = JSON.stringify([narrow, sort, size])
  useEffect(() => setPageNo(1), [key])
  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    read({ op: 'rows', table: t.name, q: narrow.q, where: narrow.where, sort: sort?.column ?? null, dir: sort?.dir, page: pageNo, size })
      .then((r) => { if (live) setPage(r) }).catch((e) => { if (live) setError(message(e)) }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [t.name, key, pageNo])   // eslint-disable-line react-hooks/exhaustive-deps
  const copy = (e: React.MouseEvent, r: Record<string, unknown>, column: string) => {
    if (!e.shiftKey && window.getSelection()?.toString()) return
    if (e.shiftKey) window.getSelection()?.removeAllRanges()
    const text = e.shiftKey ? `${t.columns.map((c) => c.name).join('\t')}\n${t.columns.map((c) => shown(r[c.name]) ?? '').join('\t')}` : shown(r[column]) ?? ''
    navigator.clipboard?.writeText(text).then(() => notify(e.shiftKey ? 'Row copied' : `Copied ${text.length > 40 ? `${text.slice(0, 40)}…` : text || '(empty)'}`, 'note'), () => notify('Could not copy', 'refused'))
  }
  const pages = page ? Math.max(1, Math.ceil(page.total / size)) : 1
  const go = (n: number) => setPageNo(Math.min(Math.max(1, n), pages))
  const from = (pageNo - 1) * size
  return (<>
    <header className="sa-explorer__tablehead">
      <div className="sa-explorer__what">
        <strong>{t.name}</strong>
        <span className="sa-muted">{[t.owner ? `owned by ${t.owner}` : 'no owner set', t.description].filter(Boolean).join(' · ')}</span>
      </div>
      <span className="sa-explorer__acts">{actions?.(t)}
        <button className="sa-icon-btn" title={profileOpen ? 'Hide the columns' : 'Show the columns'} aria-label={profileOpen ? 'Hide the columns' : 'Show the columns'} onClick={togglePanel}><Icon icon={profileOpen ? 'lucide:panel-right-close' : 'lucide:panel-right-open'} /></button></span>
    </header>
    <div className="sa-explorer__narrow">
      <div className="sa-explorer__find sa-explorer__find--rows"><Icon icon="lucide:search" /><input id={`${keep}-q`} className="sa-col__input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search every column" /></div>
      {narrow.where.map((w) => (
        <button key={w.column} className="sa-chip" title="Remove this filter" onClick={() => setNarrow({ ...narrow, where: narrow.where.filter((x) => x !== w) })}>
          <span>{w.column} = {w.value ?? 'empty'}</span><Icon icon="lucide:x" /></button>))}
    </div>
    <div className="sa-explorer__grid" data-loading={loading && !!page}>
      {error && <p className="sa-col__empty sa-explorer__error">{error}</p>}
      {!page && !error && <table className="sa-explorer__table" aria-hidden><tbody>{Array.from({ length: 12 }, (_, i) => <tr key={i}><td className="sa-explorer__no" />{t.columns.slice(0, 8).map((c) => <td key={c.name}><span className="sa-skeleton" style={{ width: `${40 + ((i * 13 + c.name.length * 7) % 50)}%`, height: 10 }} /></td>)}</tr>)}</tbody></table>}
      {page && (
        <table className="sa-explorer__table">
          <thead><tr>
            <th className="sa-explorer__no">#</th>
            {t.columns.map((c) => (
              <th key={c.name} data-kind={kindOf(c.type)} title={`${c.name} · ${c.type} — click to sort`} onClick={() => setSort(sort?.column === c.name && sort.dir === 'asc' ? { column: c.name, dir: 'desc' } : sort?.column === c.name ? null : { column: c.name, dir: 'asc' })}>
                <span className="sa-explorer__glyph">{GLYPH[kindOf(c.type)]}</span>{c.name}
                {sort?.column === c.name && <Icon icon={sort.dir === 'asc' ? 'lucide:arrow-up' : 'lucide:arrow-down'} />}
              </th>))}
          </tr></thead>
          <tbody>
            {page.rows.map((r, i) => (
              <tr key={i}>
                <td className="sa-explorer__no">{from + i + 1}</td>
                {t.columns.map((c) => { const v = shown(r[c.name]); return <td key={c.name} data-kind={kindOf(c.type)} onClick={(e) => copy(e, r, c.name)} onMouseDown={(e) => e.shiftKey && e.preventDefault()} title={`${v ?? 'empty'}\nClick: copy · Shift-click: copy the row`}>{v ?? <span className="sa-explorer__null">empty</span>}</td> })}
              </tr>))}
          </tbody>
        </table>
      )}
      {page && !page.rows.length && <p className="sa-col__empty">No rows{narrow.q || narrow.where.length ? ' match' : ''}.</p>}
    </div>
    <footer className="sa-explorer__pager">
      <span className="sa-explorer__n">{page ? `${count(page.total ? from + 1 : 0)}–${count(Math.min(from + size, page.total))} of ${count(page.total)} rows${narrow.q || narrow.where.length ? ' matching' : ''}` : '…'}</span>
      {loading && <Icon icon="lucide:loader-2" className="sa-spin" />}
      <span className="sa-note">Click a cell to copy it · ⇧ click: the row</span>
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

function Columns({ t, read, narrow, setNarrow }: { t: ExplorerTable; read: (r: ExplorerRequest) => Promise<any>; narrow: Narrow; setNarrow: (n: Narrow) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => { let live = true; read({ op: 'profile', table: t.name }).then((p) => { if (live) setProfile(p) }).catch((e) => { if (live) setError(message(e)) }); return () => { live = false } }, [t.name])   // eslint-disable-line react-hooks/exhaustive-deps
  const by = new Map((profile?.columns ?? []).map((p) => [p.name, p]))
  const rows = profile?.rows ?? t.rows ?? null
  const emptyPct = profile && profile.rows ? (profile.columns.reduce((a, p) => a + p.nulls, 0) / (profile.rows * Math.max(1, profile.columns.length))) * 100 : null
  return (
    <div className="sa-explorer__cols">
      <div className="sa-explorer__facts">
        <div><strong>{count(rows)}</strong><span>rows</span></div>
        <div><strong>{t.columns.length}</strong><span>columns</span></div>
        <div><strong>{emptyPct == null ? '—' : `${emptyPct < 0.1 && emptyPct > 0 ? '<0.1' : emptyPct.toFixed(1)}%`}</strong><span>empty</span></div>
      </div>
      {(t.owner || t.appended) && <dl className="sa-explorer__meta">
        {t.owner && <><dt>Owner</dt><dd>{t.owner}</dd></>}
        {t.appended && <><dt>Last added to</dt><dd>{new Date(t.appended).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })}</dd></>}
      </dl>}
      <h3 className="sa-label sa-explorer__colshead">Columns</h3>
      {error && <p className="sa-col__empty sa-explorer__error">{error}</p>}
      <ul className="sa-explorer__collist">
        {t.columns.map((c) => {
          const p = by.get(c.name), k = kindOf(c.type), isOpen = open === c.name
          const nulls = p && rows ? (p.nulls / Math.max(1, rows)) * 100 : 0
          return (
            <li key={c.name}>
              <button className="sa-explorer__col" data-open={isOpen} onClick={() => setOpen(isOpen ? null : c.name)} title={`${c.name} · ${c.type}${p ? ` · ${count(p.distinct)} distinct · ${nulls.toFixed(1)}% empty` : ''}`}>
                <span className="sa-explorer__glyph">{GLYPH[k]}</span>
                <span className="sa-explorer__name">{c.name}</span>
                <span className="sa-explorer__bar" title="Distinct values, against the rows">{p ? <><span style={{ width: `${Math.min(100, Math.max(2, ((p.distinct ?? 0) / Math.max(1, rows ?? 1)) * 100))}%` }} /><em>{COMPACT.format(p.distinct ?? 0)}</em></> : <span className="sa-skeleton" style={{ width: '60%', height: 8 }} />}</span>
                <span className="sa-explorer__empty" data-much={nulls >= 50} data-some={nulls > 0}>{p ? `${nulls > 0 && nulls < 0.1 ? '<0.1' : nulls.toFixed(1)}%` : ''}</span>
              </button>
              {isOpen && <ColumnDetail t={t} c={c} p={p} read={read} narrow={narrow} setNarrow={setNarrow} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function ColumnDetail({ t, c, p, read, narrow, setNarrow }: { t: ExplorerTable; c: ExplorerColumn; p?: ColumnProfile; read: (r: ExplorerRequest) => Promise<any>; narrow: Narrow; setNarrow: (n: Narrow) => void }) {
  const k = kindOf(c.type)
  const [spread, setSpread] = useState<Spread | null>(null)
  const [values, setValues] = useState<{ value: string | null; rows: number }[] | null>(null)
  const [error, setError] = useState('')
  const others = narrow.where.filter((w) => w.column !== c.name)
  const key = JSON.stringify([narrow.q, others])
  useEffect(() => {
    let live = true
    setError('')
    const fail = (e: unknown) => { if (live) setError(message(e)) }
    if (k === 'number' || k === 'time') read({ op: 'spread', table: t.name, column: c.name, q: narrow.q, where: narrow.where }).then((s) => { if (live) setSpread(s) }).catch(fail)
    read({ op: 'values', table: t.name, column: c.name, q: narrow.q, where: others }).then((v) => { if (live) setValues(v.values) }).catch(fail)
    return () => { live = false }
  }, [t.name, c.name, key])   // eslint-disable-line react-hooks/exhaustive-deps
  const top = values?.[0]?.rows ?? 1
  const pick = (value: string | null) => setNarrow({ ...narrow, where: [...others, { column: c.name, value }] })
  return (
    <div className="sa-explorer__detail">
      {error && <p className="sa-explorer__error">{error}</p>}
      {spread?.kind === 'numbers' && <Bars counts={spread.bins} left={stat(spread.lo)} right={stat(spread.hi)} />}
      {spread?.kind === 'time' && <Bars counts={spread.bins.map((b) => b.rows)} left={spread.bins[0]?.at ?? ''} right={spread.bins[spread.bins.length - 1]?.at ?? ''} note={`rows a ${spread.unit}`} labels={spread.bins.map((b) => `${b.at}: ${count(b.rows)} rows`)} />}
      {p && k === 'number' && <dl className="sa-explorer__stats">{([['min', p.min], ['first quarter', p.q1], ['median', p.median], ['third quarter', p.q3], ['max', p.max], ['mean', p.mean]] as const).map(([l, v]) => <div key={l}><dt>{l}</dt><dd>{stat(v)}</dd></div>)}</dl>}
      {p && k === 'time' && <dl className="sa-explorer__stats"><div><dt>first</dt><dd>{p.min ?? '—'}</dd></div><div><dt>last</dt><dd>{p.max ?? '—'}</dd></div></dl>}
      {p && k === 'bool' && <dl className="sa-explorer__stats"><div><dt>true</dt><dd>{count(p.trues)}</dd></div><div><dt>empty</dt><dd>{count(p.nulls)}</dd></div></dl>}
      <p className="sa-note">Commonest values{narrow.q || others.length ? ', within the search and filters' : ''} — click one to filter the rows</p>
      {!values ? <span className="sa-skeleton" style={{ width: '70%', height: 10 }} /> : (
        <ul className="sa-explorer__values">
          {values.map((v) => (
            <li key={String(v.value)}><button onClick={() => pick(v.value)} title={`${v.value ?? 'empty'} — show only these rows`}>
              <span className="sa-explorer__valuebar" style={{ width: `${Math.max(2, (v.rows / top) * 100)}%` }} />
              <span className="sa-explorer__name">{v.value ?? <i className="sa-explorer__null">empty</i>}</span><span className="sa-explorer__n">{count(v.rows)}</span>
            </button></li>))}
          {!values.length && <li className="sa-note">No values.</li>}
        </ul>
      )}
    </div>
  )
}

/** A small histogram: one bar a bin, scaled to the tallest. */
function Bars({ counts, left, right, note, labels }: { counts: number[]; left: string; right: string; note?: string; labels?: string[] }) {
  const max = Math.max(1, ...counts)
  return (
    <div className="sa-explorer__hist">
      <div className="sa-explorer__bars">{counts.map((n, i) => <span key={i} style={{ height: `${n ? Math.max(3, (n / max) * 100) : 0}%` }} title={labels?.[i] ?? `${count(n)} rows`} />)}</div>
      <div className="sa-explorer__axis"><span>{left}</span>{note && <span>{note}</span>}<span>{right}</span></div>
    </div>
  )
}
