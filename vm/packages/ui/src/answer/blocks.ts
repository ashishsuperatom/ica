// The blocks an answer carries, by type — what the platform's one answer component draws (KPIs, a figure, bars or a
// ring, a grid, a table, facts, text) — and the reader that turns anything received into one, never throwing.
// To add a block type: its shape here (and a case in readBlock), a renderer in components/blocks, registered there.

export type WindowKind = 'months' | 'weeks' | 'days' | 'pastDays' | 'fiscal' | 'range'
const KINDS: WindowKind[] = ['months', 'weeks', 'days', 'pastDays', 'fiscal', 'range']
/** One page of a table the source read: which, its size, how many in all, its order. */
export interface TablePageMeta { id: string; page: number; size: number; total: number; order?: string }

export type State = 'ok' | 'warning' | 'critical'
export type CellState = 'under' | 'over' | 'ok' | 'none'
export type Unit = string
export type Row = Record<string, unknown>
/** `also`: more filters the same row sets (a lane is its from and its to). */
/** A row's move: the dimension it narrows to (the row's key and label), and — when the row opens another view — that
 *  view (`focus`). With a focus the row opens a new block; without one it narrows this block in place. */
export interface RowMove { dim: string; key: string; label: string; focus?: string; /** The program whose answer drew the block (set by the platform): its row() takes the click. */ package?: string; also?: { dim: string; key: string; label: string }[] }
export interface KpiItem { label: string; value: unknown; unit: Unit; hint?: string; state?: State }
export interface Series { key: string; label: string; stack?: string; line?: boolean; state?: State }
/** `fields`: more of the row a move may need (a lane's from and to). */
export interface BarRow { label: string; key?: string; group?: string; values: Record<string, unknown>; fields?: Record<string, string> }
export interface GridCell { period: string; value: unknown; state: CellState }
export interface GridRow { key: string; label: string; group?: string; cells: GridCell[] }
/** `delta`: a change — drawn with its sign and its meaning (a loss below nothing, a win above). */
/** `order`: on a table the source pages, the column it orders by when this one is sorted. */
export interface Column { key: string; label: string; unit?: Unit; delta?: boolean; order?: string }

export type Block =
  | { type: 'kpis'; items: KpiItem[] }
  | { type: 'figure'; label: string; value: unknown; unit: Unit; compare?: { label: string; value: unknown }; because: string[] }
  | { type: 'bars'; title: string; axis: string; series: Series[]; unit: Unit; rows: BarRow[]; rowMove?: RowMove; rowWindow?: { kind: WindowKind; key: string }; lens?: string; /** The rows are parts of one whole (a count split by category), so a ring may draw them. */ whole?: boolean }
  | { type: 'grid'; title: string; periods: string[]; threshold: unknown; unit: Unit; rows: GridRow[]; rowMove?: RowMove; lens?: string; page?: TablePageMeta }
  /** `page`: the table is one page the source read (`id` names it in the question's pages); its columns' `order` is the column the source orders by. */
  | { type: 'table'; title: string; columns: Column[]; rows: Row[]; rowMove?: RowMove; rowState?: string; rowWindow?: { kind: WindowKind; key: string }; page?: TablePageMeta }
  | { type: 'facts'; title: string; items: { label: string; value: unknown }[] }
  /** Values over time: periods (ISO days or months) in order, one or more series, drawn as an area, a line or columns;
   *  `rowWindow` makes a period clickable (the view narrows to it). */
  | { type: 'trend'; title: string; unit: Unit; periods: string[]; series: Series[]; values: Record<string, Record<string, unknown>>; draw?: 'area' | 'line' | 'columns'; note?: string; rowWindow?: { kind: WindowKind; key: string } }
  | { type: 'text'; title: string; text: string }
  | { type: 'unknown'; title: string; raw: unknown }


// ── readers: unknown → typed, never throwing ──
type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const obj = (v: unknown): Obj => (isObj(v) ? v : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback)
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const bool = (v: unknown): boolean => v === true
const strs = (v: unknown): string[] => arr(v).map((x) => str(x)).filter((x) => x !== '')
const opt = <T>(v: T | ''): T | undefined => (v === '' ? undefined : v)
const STATES: State[] = ['ok', 'warning', 'critical']
const state = (v: unknown): State | undefined => (STATES.includes(v as State) ? (v as State) : undefined)
const CELLS: CellState[] = ['under', 'over', 'ok', 'none']
const cellState = (v: unknown): CellState => (CELLS.includes(v as CellState) ? (v as CellState) : 'none')

const readPageMeta = (v: unknown): TablePageMeta | undefined => { const x = obj(v); return str(x.id) ? { id: str(x.id), page: Math.max(1, num(x.page) || 1), size: Math.max(1, num(x.size) || 100), total: num(x.total), ...(str(x.order) ? { order: str(x.order) } : {}) } : undefined }
const readWindow = (v: unknown): { kind: WindowKind } | undefined => { const k = obj(v).kind; return KINDS.includes(k as WindowKind) ? { kind: k as WindowKind } : undefined }

export function readRowMove(v: unknown): RowMove | undefined {
  const o = obj(v)
  if (!str(o.dim) || !str(o.key)) return undefined
  const also = arr(o.also).map((a) => { const x = obj(a); return { dim: str(x.dim), key: str(x.key), label: str(x.label, str(x.key)) } }).filter((a) => a.dim && a.key)
  return { dim: str(o.dim), key: str(o.key), label: str(o.label, str(o.key)), ...(str(o.focus) ? { focus: str(o.focus) } : {}), ...(str(o.package) ? { package: str(o.package) } : {}), ...(also.length ? { also } : {}) }
}
const rows = (v: unknown): Row[] => arr(v).filter(isObj)

export function readBlock(v: unknown): Block {
  const o = obj(v)
  const title = str(o.title)
  const unit = str(o.unit, 'text')
  switch (o.type) {
    case 'kpis':
      return { type: 'kpis', items: arr(o.items).map((i) => { const x = obj(i); return { label: str(x.label), value: x.value, unit: str(x.unit, 'text'), ...(str(x.hint) ? { hint: str(x.hint) } : {}), ...(state(x.state) ? { state: state(x.state) } : {}) } }) }
    case 'figure': {
      const c = obj(o.compare)
      return { type: 'figure', label: str(o.label), value: o.value, unit, because: strs(o.because), ...(isObj(o.compare) ? { compare: { label: str(c.label), value: c.value } } : {}) }
    }
    case 'bars':
      return {
        type: 'bars', title, axis: str(o.axis), unit,
        series: arr(o.series).map((s) => { const x = obj(s); return { key: str(x.key), label: str(x.label, str(x.key)), ...(str(x.stack) ? { stack: str(x.stack) } : {}), ...(bool(x.line) ? { line: true } : {}), ...(state(x.state) ? { state: state(x.state) } : {}) } }).filter((s) => s.key),
        rows: rows(o.rows).map((r) => { const f = Object.fromEntries(Object.entries(obj(r.fields)).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)])); return { label: str(r.label), key: opt(str(r.key)), group: opt(str(r.group)), values: obj(r.values), ...(Object.keys(f).length ? { fields: f } : {}) } }),
        rowMove: readRowMove(o.rowMove), lens: opt(str(o.lens)), ...(bool(o.whole) ? { whole: true } : {}),
        ...((() => { const rw = obj(o.rowWindow); const k = readWindow({ kind: rw.kind })?.kind; return k && str(rw.key) ? { rowWindow: { kind: k, key: str(rw.key) } } : {} })()),
      }
    case 'grid':
      return {
        type: 'grid', title, periods: strs(o.periods), threshold: o.threshold, unit,
        rows: rows(o.rows).map((r) => ({ key: str(r.key), label: str(r.label), group: opt(str(r.group)), cells: arr(r.cells).map((c) => { const x = obj(c); return { period: str(x.period), value: x.value, state: cellState(x.state) } }) })),
        rowMove: readRowMove(o.rowMove), lens: opt(str(o.lens)), ...(readPageMeta(o.page) ? { page: readPageMeta(o.page) } : {}),
      }
    case 'table': {
      const rw = obj(o.rowWindow)
      const rwKind = readWindow({ kind: rw.kind })?.kind
      return {
        type: 'table', title,
        columns: arr(o.columns).map((c) => { const x = obj(c); return { key: str(x.key), label: str(x.label, str(x.key)), ...(str(x.unit) ? { unit: str(x.unit) } : {}), ...(bool(x.delta) ? { delta: true } : {}), ...(str(x.order) ? { order: str(x.order) } : {}) } }).filter((c) => c.key),
        rows: rows(o.rows), rowMove: readRowMove(o.rowMove), rowState: opt(str(o.rowState)),
        ...(readPageMeta(o.page) ? { page: readPageMeta(o.page) } : {}),
        ...(rwKind && str(rw.key) ? { rowWindow: { kind: rwKind, key: str(rw.key) } } : {}),
      }
    }
    case 'facts':
      return { type: 'facts', title, items: arr(o.items).map((i) => { const x = obj(i); return { label: str(x.label), value: x.value } }) }
    case 'text':
      return { type: 'text', title, text: str(o.text) }
    case 'trend': {
      const draw = ['area', 'line', 'columns'].includes(str(o.draw)) ? (str(o.draw) as 'area' | 'line' | 'columns') : undefined
      const values = Object.fromEntries(Object.entries(obj(o.values)).map(([p, v]) => [p, obj(v)]))
      return { type: 'trend', title, unit: str(o.unit), periods: strs(o.periods), series: arr(o.series).map((s) => { const x = obj(s); return { key: str(x.key), label: str(x.label, str(x.key)), ...(state(x.state) ? { state: state(x.state) } : {}) } }).filter((s) => s.key), values,
        ...(draw ? { draw } : {}), ...(str(o.note) ? { note: str(o.note) } : {}) }
    }
    default:
      return { type: 'unknown', title: title || str(o.type, 'block'), raw: v }
  }
}


/** One line of the narrator's story of a piece of work, as it happened. */
export interface Beat { text: string; at: number }
