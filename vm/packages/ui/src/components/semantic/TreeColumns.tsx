// TREE COLUMNS — a tree walked left to right, a folder per column: a row chosen in one column opens what belongs to it in
// the next, and only that (nothing else of its kind, so no lanes or edges). The columns sit edge to edge in one box of one
// height; each scrolls on its own and is as wide as it was dragged (kept in this browser; double-click its edge for the
// usual width); past the box's width they scroll sideways. Every column starts at its top: one opened by a new choice
// before it is a new column, and choosing inside a column never moves it. The box fills the screen
// down to its bottom. Arrow keys walk it like a grid: up and down choose the row before or after (scrolled into view),
// right goes into the next column (its chosen row, else its first), left back to the column before.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { recall, remember } from '../../lib/remember'

export interface TreeColumnRow {
  key: string; title: string
  /** An iconify icon before the title, or anything drawn there (a mark). */
  icon?: string; mark?: ReactNode
  /** What stands at the row's end (a count, a type, a state). */
  aside?: ReactNode
  /** Quieter (switched off), or struck through (no longer there). */
  muted?: boolean; struck?: boolean
  /** Choosing it opens another column (a chevron says so). */
  opens?: boolean
}
export interface TreeColumn {
  key: string; title: string
  rows: TreeColumnRow[]
  selected?: string | null
  onSelect: (key: string) => void
  /** One thing the column's head offers. */
  action?: { label: string; run: () => void }
  empty?: string
}

const WIDTH = 260, DETAIL = 340, MIN = 160

export function TreeColumns({ columns, detail, detailTitle = 'Details', detailIcon, keep = 'tree-columns', search, bleed }: {
  columns: TreeColumn[]; detail?: ReactNode
  /** One search over the whole tree, above the columns (the caller narrows what they hold); its words are marked in the rows. */
  search?: { value: string; onChange: (v: string) => void; placeholder?: string }
  /** What the detail is of, for its head (a table, a field…), and its icon. */
  detailTitle?: string; detailIcon?: string
  keep?: string
  /** The whole page, edge to edge: no frame around it, and the page's own padding taken away. */
  bleed?: boolean
}) {
  const [widths, setWidths] = useState<Record<string, number>>(() => recall<Record<string, number>>(`tcols:${keep}`, {}))
  const drag = useRef<{ key: string; x: number; w: number } | null>(null)
  useEffect(() => {
    const move = (e: PointerEvent) => { const d = drag.current; if (d) setWidths((w) => ({ ...w, [d.key]: Math.max(MIN, Math.round(d.w + e.clientX - d.x)) })) }
    const up = () => { if (!drag.current) return; drag.current = null; document.body.classList.remove('sa-resizing'); setWidths((w) => { remember(`tcols:${keep}`, w); return w }) }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [keep])
  const box = useRef<HTMLDivElement>(null)
  // The box reaches down to the bottom of the screen and no further: first to the window's bottom, then less by whatever
  // the page still overflows below it (the padding and anything under it), so the page itself never scrolls for it.
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    const scroller = (el: HTMLElement) => {
      for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowY; if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p }
      return document.scrollingElement as HTMLElement | null
    }
    let frame = 0
    const fit = () => {
      const el = box.current; if (!el) return
      const first = Math.max(360, Math.floor(window.innerHeight - el.getBoundingClientRect().top))
      el.style.height = `${first}px`
      const sc = scroller(el), over = sc ? sc.scrollHeight - sc.clientHeight : 0
      setHeight(Math.max(360, first - Math.max(0, over)))
    }
    const soon = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit) }
    fit(); window.addEventListener('resize', soon)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', soon) }
  }, [])
  // Arrow keys, as in a grid. What is focused follows what is chosen, once the columns are drawn; the row is brought into
  // view by its own column scrolling up or down — nothing scrolls sideways.
  const focusRow = (j: number, key: string) => requestAnimationFrame(() => {
    const el = box.current?.querySelectorAll<HTMLElement>('.sa-tcols > .sa-tcols__col')[j]?.querySelector<HTMLElement>(`.sa-tcols__row[data-key="${CSS.escape(key)}"]`)
    if (!el) return
    el.focus({ preventScroll: true })
    const body = el.closest<HTMLElement>('.sa-tcols__body'); if (!body) return
    const r = el.getBoundingClientRect(), b = body.getBoundingClientRect()
    if (r.top < b.top) body.scrollTop -= b.top - r.top
    else if (r.bottom > b.bottom) body.scrollTop += r.bottom - b.bottom
  })
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, j: number, key: string) => {
    const c = columns[j], at = c.rows.findIndex((r) => r.key === key)
    let to: [number, string] | null = null, choose = true
    if (e.key === 'ArrowDown' && at < c.rows.length - 1) to = [j, c.rows[at + 1].key]
    else if (e.key === 'ArrowUp' && at > 0) to = [j, c.rows[at - 1].key]
    else if (e.key === 'ArrowRight' && columns[j + 1]?.rows.length) { const n = columns[j + 1]; to = [j + 1, n.selected ?? n.rows[0].key]; choose = !n.selected }
    else if (e.key === 'ArrowLeft' && j > 0 && columns[j - 1].selected) { to = [j - 1, columns[j - 1].selected!]; choose = false }
    else if (e.key.startsWith('Arrow')) { e.preventDefault(); return }
    if (!to) return
    e.preventDefault()
    if (choose) columns[to[0]].onSelect(to[1])
    focusRow(to[0], to[1])
  }
  // The rows are drawn once and kept: a choice redraws only the row it leaves and the row it lands on (Row is memoised;
  // what it calls reads the columns of now through a ref, so it never changes).
  const now = useRef({ columns, onKey }); now.current = { columns, onKey }
  const act = useCallback((kind: 'click' | 'key', j: number, key: string, e?: KeyboardEvent<HTMLButtonElement>) => {
    if (kind === 'click') now.current.columns[j]?.onSelect(key); else if (e) now.current.onKey(e, j, key)
  }, [])
  const edge = (k: string) => (
    <span className="sa-tcols__resize" role="separator" aria-orientation="vertical" aria-label="Resize the column" title="Drag to resize · double-click for its usual width"
      onPointerDown={(e) => { e.preventDefault(); drag.current = { key: k, x: e.clientX, w: (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect().width }; document.body.classList.add('sa-resizing') }}
      onDoubleClick={() => setWidths((w) => { const { [k]: _gone, ...rest } = w; remember(`tcols:${keep}`, rest); return rest })} />
  )
  return (
    <div className={bleed ? 'sa-tcols-box sa-tcols-box--bleed' : 'sa-tcols-box'} ref={box} style={height ? { height } : undefined}>
      {search && (
        <div className="sa-tcols__search">
          <Icon icon="lucide:search" className="sa-tcols__search-icon" width={16} height={16} />
          <input id="tcols-search" className="sa-tcols__search-input" placeholder={search.placeholder ?? 'Search everything…'} aria-label={search.placeholder ?? 'Search everything'} value={search.value} onChange={(e) => search.onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') search.onChange('') }} />
          {search.value && <button type="button" className="sa-icon-btn" aria-label="Clear the search" onClick={() => search.onChange('')}><Icon icon="lucide:x" width={16} height={16} /></button>}
        </div>
      )}
    <div className="sa-tcols">
      {columns.map((c, j) => (
        <section key={`${c.key}|${columns.slice(0, j).map((p) => p.selected ?? '').join('/')}`} className="sa-tcols__col" aria-label={c.title} style={{ width: widths[c.key] ?? WIDTH }}>
          <header className="sa-tcols__head">
            <span className="sa-tcols__title">{c.title}</span>
            {c.action ? <button type="button" className="sa-btn sa-btn--link sa-tcols__action" onClick={c.action.run}>{c.action.label}</button>
              : <span className="sa-tcols__count">{c.rows.length.toLocaleString()}</span>}
          </header>
          <ul className="sa-tcols__body">
            {c.rows.map((r) => <Row key={r.key} r={r} j={j} pressed={c.selected === r.key} words={search?.value ?? ''} act={act} />)}
            {!c.rows.length && <li className="sa-tcols__empty">{c.empty ?? 'Nothing here.'}</li>}
          </ul>
          {edge(c.key)}
        </section>
      ))}
      {detail && (
        <section key={columns.map((p) => p.selected ?? '').join('/')} className="sa-tcols__col sa-tcols__col--detail" aria-label={detailTitle} data-of={detailTitle} style={{ width: widths.detail ?? DETAIL }}>
          <header className="sa-tcols__head sa-tcols__head--detail">{detailIcon && <Icon icon={detailIcon} className="sa-tcols__head-icon" width={16} height={16} />}<span className="sa-tcols__title">{detailTitle}</span></header>
          <div className="sa-tcols__body"><div className="sa-tcols__detail">{detail}</div></div>
          {edge('detail')}
        </section>
      )}
    </div>
    </div>
  )
}

/** One row. Drawn again only when what it shows changes. */
const Row = memo(function Row({ r, j, pressed, words, act }: {
  r: TreeColumnRow; j: number; pressed: boolean; words: string
  act: (kind: 'click' | 'key', j: number, key: string, e?: KeyboardEvent<HTMLButtonElement>) => void
}) {
  return (
    <li data-muted={r.muted || undefined} data-struck={r.struck || undefined}>
      <button type="button" className="sa-tcols__row" aria-pressed={pressed} data-key={r.key} onClick={() => act('click', j, r.key)} onKeyDown={(e) => act('key', j, r.key, e)} title={r.title}>
        {r.mark ?? (r.icon && <Icon icon={r.icon} className="sa-tcols__icon" />)}
        <span className="sa-tcols__name"><Marked text={r.title} words={words} /></span>
        {r.aside != null && r.aside !== '' && <span className="sa-tcols__aside">{r.aside}</span>}
        {r.opens && <span className="sa-tcols__chev" aria-hidden />}
      </button>
    </li>
  )
})

/** A name with the searched words marked. */
function Marked({ text, words }: { text: string; words: string }) {
  const w = words.trim().toLowerCase()
  const at = w ? text.toLowerCase().indexOf(w) : -1
  if (at < 0) return <>{text}</>
  return <>{text.slice(0, at)}<mark className="sa-tcols__mark">{text.slice(at, at + w.length)}</mark>{text.slice(at + w.length)}</>
}
