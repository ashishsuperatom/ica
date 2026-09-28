// The wire protocol, typed — and the readers that turn the server's JSON (untyped input) into these shapes.
//
// Nothing downstream reads a raw reply: `readCatalog`, `readAnswer`, `readReply` normalise every field, so a block
// missing a field renders as empty rather than crashing. See ../../server/index.mjs for the protocol itself.

export type FilterOp = 'is' | 'is not'
/** A filter's value is a key, or every key that carries one label (normalised: sorted, deduplicated, one key collapses to a string). */
export type MemberValue = string | string[]
export interface Filter { dim: string; op: FilterOp; value: MemberValue; label?: string }
export type WindowKind = 'months' | 'weeks' | 'days' | 'pastDays' | 'fiscal' | 'range'
/** A window's shape depends on its kind; the kind-specific fields are read by the window control. */
/** `said`: why the window is what it is ("the last week with entries"), shown quietly beside it. */
export interface Window { kind: WindowKind; months?: string[]; past?: number; future?: number; days?: number; year?: string; from?: string; through?: string; said?: string; /** The same span one period back comes beside each figure (range only). */ compare?: boolean }
export type AssumeValue = number | string | boolean | null
/** `pages`: the page each table of the answer is on, and the order the source reads it in (a column, "-" for largest first). */
export interface TablePage { page: number; order?: string }
/** A block that holds one page the source read: which (its id in the question's pages), which page, how many in all. */
export interface TablePageMeta { id: string; page: number; size: number; total: number; order?: string }
const readPageMeta = (v: unknown): TablePageMeta | undefined => { const x = obj(v); return str(x.id) ? { id: str(x.id), page: Math.max(1, num(x.page) || 1), size: Math.max(1, num(x.size) || 100), total: num(x.total), ...(str(x.order) ? { order: str(x.order) } : {}) } : undefined }
export interface Question { focus: string; where: Filter[]; by?: string; as?: string; window?: Window; assume?: Record<string, AssumeValue>; pages?: Record<string, TablePage> }

export type Op =
  | { op: 'push'; dim: string; value: MemberValue; label?: string; not?: boolean }
  | { op: 'pop'; dim: string }
  | { op: 'up' }
  | { op: 'clear' }
  | { op: 'by'; dim?: string }
  | { op: 'as'; lens: string }
  | { op: 'focus'; on: string }
  | { op: 'drill' }
  | { op: 'window'; window: Window }
  | { op: 'assume'; assume: Record<string, AssumeValue> }
  | { op: 'page'; block: string; page: number; order?: string }

export type Request =
  | { t: 'app:catalog' }
  | { t: 'app:start'; focus: string; where?: Filter[] }
  | { t: 'app:move'; question: Question; ops: Op[] }
  | { t: 'app:ask'; question: Question }
  | { t: 'app:members'; dim: string; typed: string }
  | { t: 'app:about' }
  | { t: 'app:say'; text: string; threadId: string; question: Question; title: string; headline: Headline[]; notes: string[]; asked: Asked[]; path: SayContext[] }

// ── catalog ──
export type DimKind = 'entity' | 'flag' | 'attribute' | 'calendar'
export interface Dimension { key: string; label: string; plural: string; grain: string; within?: string; means: string; kind: DimKind; entity?: string; /** A period of the window: a `by` option, never a filter. */ byOnly?: boolean; /** The application gives its members (app:members), even with nothing typed. */ searchable?: boolean }
export interface Capability {
  focus: string; label: string; whenToUse: string; scenario: string; root: boolean
  honours: string[]; by: string[]; lenses: string[]
  window?: { kind: WindowKind; default?: Window }
  assume?: Record<string, AssumeValue>
  start?: { where: Filter[] }
}
/** A starting point's look, as the project's application gives it: what it is called, its colour, icon and one line. */
export interface Scenario { key: string; label: string; accent: string; icon: string; says: string }
/** `financialYears`: the financial years a window can be set to, by name, in order. */
export interface Catalog { project: { name: string; locale: string; currency: string }; scenarios: Scenario[]; financialYears: string[]; dimensions: Dimension[]; capabilities: Capability[]; windows: Record<string, { note: string | null }>; problems: string[]; today: string }

// ── answer ──
export type State = 'ok' | 'warning' | 'critical'
export type CellState = 'under' | 'over' | 'ok' | 'none'
export type Unit = string
export type Row = Record<string, unknown>
/** `also`: more filters the same row sets (a lane is its from and its to). */
export interface RowMove { dim: string; key: string; label: string; focus?: string; also?: { dim: string; key: string; label: string }[] }
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
  | { type: 'text'; title: string; text: string }
  | { type: 'unknown'; title: string; raw: unknown }

export interface Next { label: string; ops: Op[] }
export interface Used { settings: Record<string, unknown>; assumptions: Record<string, AssumeValue>; window: string | null; span: { from: string; to: string } | null; /** The latest day the fact has rows for, when the capability says. */ latest?: string }
export interface Answer {
  question: Question; focus: string; label: string; words: string; title: string
  blocks: Block[]; next: Next[]; used: Used; notes: string[]; asked: unknown[]; ms: number; today: string
  said?: string; dropped?: string[]
}

// ── say: a typed question, read in prose by the thread's reader agent ──
export interface Headline { label: string; value: unknown; unit: Unit }
/** What the reader is told about a block: its question and what it showed — never its rows. */
/** One ask a block made of the graph: the question in the graph's own shape, and how many rows came back. */
export interface Asked { question: unknown; rows?: number }
export interface SayContext { question: Question; title: string; headline: Headline[]; notes: string[]; asked: Asked[] }
export interface SaidCall { id: string; canonical: string; ms: number; at: string; refused?: string; error?: string }
/** `blocks`: what the markdown's marker lines (`:::table name.json`) name, resolved by the engine; each is drawn where its
 *  marker stands. A marker whose file could not be read carries `error` and is drawn as one line saying so. */
export interface SaidBlock { marker: string; block: Block | null; error?: string }
/** `agent`: the agent that answered, and how the thread came to it — picked from its first question, or the thread's agent since. */
export interface SaidAgent { name: string; how: string; terms: string[] }
export interface Said { text: string; qid: string; markdown: string; blocks: SaidBlock[]; calls: SaidCall[]; ms: number; question: Question; agent?: SaidAgent }

// ── about: where the numbers come from ──
/** Where the numbers come from: the sources, the programs the views read (each a domain's, one row per what), the
 *  organisation's settings in force, and the application. */
export interface About {
  sources: { id: string; kind: string; dialect: string; description: string }[]
  programs: { fact: string; program: string; domain: string; grain: string }[]
  settings: { name: string; value: string }[]
  application: { capabilities: number; loadedAt: string; problems: string[] }
  today: string
}

export type Reply =
  | { t: 'app:catalog'; catalog: Catalog }
  | { t: 'app:about'; about: About }
  | { t: 'app:said'; said: Said }
  | { t: 'app:answer'; answer: Answer }
  | { t: 'app:refused'; reason: string }
  | { t: 'app:members'; dim: string; matches: Member[] }
  | { t: 'app:error'; error: string }

/** One member of a dimension as the graph offers it: a label, and every key recorded under it. */
export interface Member { key: MemberValue; keys: string[]; label: string; recorded?: number }

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
const assumeValue = (v: unknown): AssumeValue => (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ? v : null)
const assumeMap = (v: unknown): Record<string, AssumeValue> => Object.fromEntries(Object.entries(obj(v)).map(([k, x]) => [k, assumeValue(x)]))

/** A member value in one shape: sorted, deduplicated, a single key as a string. */
export function memberValue(v: unknown): MemberValue {
  const keys = [...new Set((Array.isArray(v) ? v : [v]).map((x) => str(x)).filter((x) => x !== ''))].sort()
  return keys.length === 1 ? keys[0] : keys
}
export const memberKeys = (v: MemberValue): string[] => (Array.isArray(v) ? v : [v])
export const sameMember = (a: MemberValue, b: MemberValue): boolean => JSON.stringify(memberValue(a)) === JSON.stringify(memberValue(b))

export function readMember(v: unknown): Member | null {
  const o = obj(v)
  const label = str(o.label)
  const key = memberValue(o.keys !== undefined ? o.keys : o.key)
  const keys = memberKeys(key)
  if (!keys.length) return null
  const recorded = num(o.recorded)
  return { key, keys, label: label || keys.join(', '), ...(recorded > 1 ? { recorded } : {}) }
}

export function readFilter(v: unknown): Filter | null {
  const o = obj(v)
  const dim = str(o.dim)
  if (!dim) return null
  const value = memberValue(o.value)
  if (!memberKeys(value).length) return null
  return { dim, op: o.op === 'is not' ? 'is not' : 'is', value, ...(str(o.label) ? { label: str(o.label) } : {}) }
}
const KINDS: WindowKind[] = ['months', 'weeks', 'days', 'pastDays', 'fiscal', 'range']
export function readWindow(v: unknown): Window | undefined {
  const o = obj(v)
  const kind = o.kind
  if (!KINDS.includes(kind as WindowKind)) return undefined
  const w: Window = { kind: kind as WindowKind }
  if (Array.isArray(o.months)) w.months = strs(o.months)
  if (typeof o.past === 'number') w.past = o.past
  if (typeof o.future === 'number') w.future = o.future
  if (typeof o.days === 'number') w.days = o.days
  if (o.year !== undefined) w.year = str(o.year)
  if (str(o.from)) w.from = str(o.from)
  if (str(o.through)) w.through = str(o.through)
  if (str(o.said)) w.said = str(o.said)
  if (o.compare === true) w.compare = true
  return w
}
/** What a chip reads: the label; failing that, how many keys are held, never the keys themselves. */
export const filterLabel = (f: Filter): string => f.label ?? (Array.isArray(f.value) ? `${f.value.length} recorded` : f.value)

export function readQuestion(v: unknown): Question {
  const o = obj(v)
  const q: Question = { focus: str(o.focus), where: arr(o.where).map(readFilter).filter((f): f is Filter => f !== null) }
  if (str(o.by)) q.by = str(o.by)
  if (str(o.as)) q.as = str(o.as)
  const w = readWindow(o.window)
  if (w) q.window = w
  if (isObj(o.assume) && Object.keys(o.assume).length) q.assume = assumeMap(o.assume)
  if (isObj(o.pages)) { const pages = Object.fromEntries(Object.entries(o.pages).map(([k, v]) => { const x = obj(v); return [k, { page: Math.max(1, Math.round(num(x.page) || 1)), ...(str(x.order) ? { order: str(x.order) } : {}) }] })); if (Object.keys(pages).length) q.pages = pages }
  return q
}

export function readOp(v: unknown): Op | null {
  const o = obj(v)
  switch (o.op) {
    case 'push': return { op: 'push', dim: str(o.dim), value: memberValue(o.value), ...(str(o.label) ? { label: str(o.label) } : {}), ...(bool(o.not) ? { not: true } : {}) }
    case 'pop': return { op: 'pop', dim: str(o.dim) }
    case 'up': return { op: 'up' }
    case 'clear': return { op: 'clear' }
    case 'by': return { op: 'by', ...(str(o.dim) ? { dim: str(o.dim) } : {}) }
    case 'as': return { op: 'as', lens: str(o.lens) }
    case 'focus': return { op: 'focus', on: str(o.on) }
    case 'drill': return { op: 'drill' }
    case 'window': { const w = readWindow(o.window); return w ? { op: 'window', window: w } : null }
    case 'assume': return { op: 'assume', assume: assumeMap(o.assume) }
    default: return null
  }
}

function readRowMove(v: unknown): RowMove | undefined {
  const o = obj(v)
  if (!str(o.dim) || !str(o.key)) return undefined
  const also = arr(o.also).map((a) => { const x = obj(a); return { dim: str(x.dim), key: str(x.key), label: str(x.label, str(x.key)) } }).filter((a) => a.dim && a.key)
  return { dim: str(o.dim), key: str(o.key), label: str(o.label, str(o.key)), ...(str(o.focus) ? { focus: str(o.focus) } : {}), ...(also.length ? { also } : {}) }
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
    default:
      return { type: 'unknown', title: title || str(o.type, 'block'), raw: v }
  }
}

export function readAnswer(v: unknown): Answer {
  const o = obj(v)
  const used = obj(o.used)
  const span = obj(used.span)
  return {
    question: readQuestion(o.question), focus: str(o.focus), label: str(o.label), words: str(o.words), title: str(o.title, str(o.label)),
    blocks: arr(o.blocks).map(readBlock),
    next: arr(o.next).map((n) => { const x = obj(n); return { label: str(x.label), ops: arr(x.ops).map(readOp).filter((op): op is Op => op !== null) } }).filter((n) => n.label),
    used: { settings: obj(used.settings), assumptions: assumeMap(used.assumptions), window: str(used.window) || null, span: str(span.from) && str(span.to) ? { from: str(span.from), to: str(span.to) } : null, ...(str(used.latest) ? { latest: str(used.latest) } : {}) },
    notes: strs(o.notes), asked: arr(o.asked), ms: num(o.ms), today: str(o.today),
    ...(str(o.said) ? { said: str(o.said) } : {}), ...(Array.isArray(o.dropped) ? { dropped: strs(o.dropped) } : {}),
  }
}

export function readCatalog(v: unknown): Catalog {
  const o = obj(v)
  return {
    project: { name: str(obj(o.project).name, 'Superatom'), locale: str(obj(o.project).locale, 'en-AU'), currency: str(obj(o.project).currency, 'AUD') },
    financialYears: strs(o.financialYears),
    scenarios: arr(o.scenarios).map((s) => { const x = obj(s); return { key: str(x.key), label: str(x.label, str(x.key)), accent: str(x.accent, 'neutral'), icon: str(x.icon, 'lucide:layout-grid'), says: str(x.says) } }).filter((s) => s.key),
    dimensions: arr(o.dimensions).map((d) => { const x = obj(d); return { key: str(x.key), label: str(x.label, str(x.key)), plural: str(x.plural, str(x.label)), grain: str(x.grain), within: opt(str(x.within)), means: str(x.means), kind: x.kind === 'flag' ? 'flag' : x.kind === 'attribute' ? 'attribute' : x.kind === 'calendar' ? 'calendar' : 'entity', entity: opt(str(x.entity)), ...(bool(x.byOnly) ? { byOnly: true } : {}), ...(bool(x.searchable) ? { searchable: true } : {}) } as Dimension }).filter((d) => d.key),
    capabilities: arr(o.capabilities).map((c) => {
      const x = obj(c)
      const w = obj(x.window)
      const wk = readWindow({ kind: w.kind })?.kind
      const cap: Capability = { focus: str(x.focus), label: str(x.label, str(x.focus)), whenToUse: str(x.whenToUse), scenario: str(x.scenario, 'other'), root: bool(x.root), honours: strs(x.honours), by: strs(x.by), lenses: strs(x.lenses).length ? strs(x.lenses) : ['table'] }
      if (wk) cap.window = { kind: wk, ...(isObj(w.default) ? { default: readWindow({ ...w.default, kind: wk }) } : {}) }
      if (isObj(x.assume)) cap.assume = assumeMap(x.assume)
      if (isObj(x.start)) cap.start = { where: arr(obj(x.start).where).map(readFilter).filter((f): f is Filter => f !== null) }
      return cap
    }).filter((c) => c.focus),
    windows: Object.fromEntries(Object.entries(obj(o.windows)).map(([k, w]) => [k, { note: str(obj(w).note) || null }])),
    problems: strs(o.problems), today: str(o.today),
  }
}

/** One block a reading's markdown named, as the engine resolved it. */
export function readSaidBlock(b: unknown): SaidBlock { const x = obj(b); return { marker: str(x.marker), block: isObj(x.block) ? readBlock(x.block) : null, ...(str(x.error) ? { error: str(x.error) } : {}) } }

export function readSaid(v: unknown): Said {
  const o = obj(v)
  return {
    text: str(o.text), qid: str(o.qid), markdown: str(o.markdown), blocks: arr(o.blocks).map(readSaidBlock).filter((b) => b.marker), ms: num(o.ms), question: readQuestion(o.question),
    calls: arr(o.calls).map((c) => { const x = obj(c); return { id: str(x.id), canonical: str(x.canonical), ms: num(x.ms), at: str(x.at), ...(str(x.refused) ? { refused: str(x.refused) } : {}), ...(str(x.error) ? { error: str(x.error) } : {}) } }).filter((c) => c.canonical || c.id),
  }
}

export function readAbout(v: unknown): About {
  const o = obj(v)
  const app = obj(o.application)
  return {
    sources: arr(o.sources).map((x) => { const y = obj(x); return { id: str(y.id), kind: str(y.kind), dialect: str(y.dialect), description: str(y.description) } }).filter((x) => x.id),
    programs: arr(o.programs).map((x) => { const y = obj(x); return { fact: str(y.fact), program: str(y.program), domain: str(y.domain), grain: str(y.grain) } }).filter((x) => x.fact),
    settings: arr(o.settings).map((x) => { const y = obj(x); return { name: str(y.name), value: typeof y.value === 'string' ? y.value : JSON.stringify(y.value ?? null) } }).filter((x) => x.name),
    application: { capabilities: num(app.capabilities), loadedAt: str(app.loadedAt), problems: strs(app.problems) },
    today: str(o.today),
  }
}

/** Frames that are not replies and carry no answer: an agent's hello and its output as it works (a chunk with the
 * pending request's `reqId` is a sign of life for that request), the hub's own. Tolerated, never a Reply. */
export const CONTROL_FRAMES = new Set(['narration', 'app:said:part', 'agent:hello', 'agent:chunk', 'agent:event', 'agent:status', 'log:attached', 'log:line', 'welcome', 'tick', 'machine:waking'])
export const isControlFrame = (t: unknown): boolean => typeof t === 'string' && CONTROL_FRAMES.has(t)

/** One incoming payload as a typed reply, or null when it is not one of ours (hub control frames, ticks). */
export function readReply(v: unknown): Reply | null {
  const o = obj(v)
  switch (o.t) {
    case 'app:catalog': return { t: 'app:catalog', catalog: readCatalog(o) }
    case 'app:about': return { t: 'app:about', about: readAbout(o) }
    case 'app:said': return { t: 'app:said', said: readSaid(o) }
    case 'app:answer': return { t: 'app:answer', answer: readAnswer(o) }
    case 'app:refused': return { t: 'app:refused', reason: str(o.reason, 'refused') }
    case 'app:members': return { t: 'app:members', dim: str(o.dim), matches: arr(o.matches).map(readMember).filter((m): m is Member => m !== null) }
    case 'app:error': return { t: 'app:error', error: str(o.error, 'error') }
    default: return null
  }
}
