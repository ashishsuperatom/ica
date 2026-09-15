// Lightweight markdown → HTML for answer/log prose. Extracted from App.tsx.

function inlineMd(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}
// Light block markdown for answer/section prose: bold/italic/code inline, PLUS a run of lines that start with
// "- " (or "\u2022 ") becomes a real bulleted list. Everything else is plain paragraph text with <br/> line breaks.
// Not full markdown \u2014 just enough that a list-shaped takeaway reads as bullets and key figures can be bolded.
export function renderInlineMd(text: string): string {
  const clean = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, '').replace(/ {2,}/g, ' ')
  const esc = clean.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const out: string[] = []
  let para: string[] = [], bullets: string[] = [], numbers: string[] = [], tableRows: string[] = []
  // A PARAGRAPH IS A PARAGRAPH. These were pushed as bare text and the pieces joined with nothing between
  // them, so every blank line in every answer collapsed and prose arrived as one run-on wall — "…11:40 UTC).Re-run
  // with…". Wrapping restores the break the writer put there.
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join('<br/>')}</p>`); para = [] } }
  const flushBul = () => { if (bullets.length) { out.push(`<ul class="sa-list">${bullets.join('')}</ul>`); bullets = [] } }
  const flushNum = () => { if (numbers.length) { out.push(`<ol class="sa-olist">${numbers.join('')}</ol>`); numbers = [] } }
  const flushTable = () => {   // GFM pipe table: first row = header when row 2 is a `--- | ---` separator
    if (!tableRows.length) return
    const rows = tableRows.map(r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())); tableRows = []
    const isSep = (r: string[]) => r.length > 0 && r.every(c => /^:?-{2,}:?$/.test(c))
    let header: string[] | null = null, body: string[][] = rows
    if (rows.length >= 2 && isSep(rows[1])) { header = rows[0]; body = rows.slice(2) }
    const thead = header ? `<thead><tr>${header.map(c => `<th>${inlineMd(c)}</th>`).join('')}</tr></thead>` : ''
    const tbody = `<tbody>${body.map(r => `<tr>${r.map(c => `<td>${inlineMd(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
    out.push(`<table class="sa-mdtable">${thead}${tbody}</table>`)
  }
  const flushAll = () => { flushPara(); flushBul(); flushNum(); flushTable() }
  // A ``` fence becomes a real code block. `explain:` shows the SQL or the one line of logic that decides an
  // answer, and without this the fence markers render as literal text with the query flattened into a
  // paragraph — which is exactly the content the reader opened the explanation to see.
  let fence: string[] | null = null
  for (const ln of esc.split('\n')) {
    const isFence = /^\s*```/.test(ln)
    if (fence !== null) {
      if (isFence) { out.push(`<pre class="sa-code"><code>${fence.join('\n')}</code></pre>`); fence = null }
      else fence.push(ln)
      continue
    }
    if (isFence) { flushAll(); fence = []; continue }
    // ATX headings. Without this a `## Heading` reached the reader as literal hashes, and — worse — was glued
    // onto the paragraph after it, because a heading line is not blank and nothing else broke the paragraph.
    const h = ln.match(/^\s*(#{1,6})\s+(.*)$/)
    if (h) { flushAll(); out.push(`<div class="sa-h${h[1].length <= 2 ? '' : ' sm'}">${inlineMd(h[2].trim())}</div>`); continue }
    const isTable = /^\s*\|(.+)\|\s*$/.test(ln)
    const b = ln.match(/^\s*[-\u2022]\s+(.*)/)
    const n = ln.match(/^\s*\d+[.)]\s+(.*)/)   // "1. " / "2) " \u2192 a real numbered list (needs a . or ) right after the digits, so "1338 lanes" is NOT a list item)
    if (isTable) { flushPara(); flushBul(); flushNum(); tableRows.push(ln) }
    else if (b) { flushPara(); flushNum(); flushTable(); bullets.push(`<li>${inlineMd(b[1])}</li>`) }
    else if (n) { flushPara(); flushBul(); flushTable(); numbers.push(`<li>${inlineMd(n[1])}</li>`) }
    else if (ln.trim() === '') { flushAll() }
    else { flushBul(); flushNum(); flushTable(); para.push(inlineMd(ln)) }
  }
  // An unterminated fence still shows its content rather than swallowing it.
  if (fence !== null && fence.length) out.push(`<pre class="sa-code"><code>${fence.join('\n')}</code></pre>`)
  flushAll()
  return out.join('')
}

// A takeaway (answer/caveat) is EITHER a string (a paragraph) OR an array of item strings (a list) — the
// program returns one or the other; the UI decides how it renders. A string, or an array of ONE item, is
// plain text (no bullet). Only an array of MORE THAN ONE item becomes a list.
export function renderAnswerBody(answer: unknown): string {
  if (Array.isArray(answer)) {
    if (answer.length <= 1) return renderInlineMd(String(answer[0] ?? ''))   // single item → plain text, no bullet
    return renderInlineMd(answer.map((it) => `- ${String(it)}`).join('\n'))   // several → a list
  }
  return renderInlineMd(String(answer ?? ''))
}

// ── TABLE CELLS AND COLUMNS ─────────────────────────────────────────────────────────────────────────────────
// A cell is a scalar, or a scalar WITH an identity: `{ v: 'Acme Pty Ltd', id: 431 }`. Co-located, so the id
// can never drift out of step with the value it belongs to, and a row that has no id is simply a plain value
// with no special case anywhere.
//
// Every reader goes through these. The same rule spelled out at each `String(cell)` site is how it drifts —
// and there are five of them, two in copy and CSV rather than rendering, which is exactly where an
// "[object Object]" gets missed.
// ── ONE SHAPE FOR A CELL ────────────────────────────────────────────────────────────────────────────────────
// A cell is the VALUE. A number is a number, a name is a string — that is what sorts, right-aligns and totals,
// and the column says how it should look.
//
// It is wrapped only to carry what the value cannot:
//   { value, id }        it names a thing the reader can open on its own
//   { value, display }   its form cannot be derived from the number — a currency, say
//
// The keys are spelled out — `value`, `entity` — and never abbreviated. The short forms were a saving that
// does not exist: nobody writes this JSON. An agent writes a PROGRAM, so the object appears once in a loop and
// the rows come out of it. All the abbreviation ever bought was a second name for the same idea, which is how
// a renderer and a prompt drift apart. `value` is also already the contract's word: a headline is
// {label, display, value}.
//
// A cell does NOT carry a label — the column is its label. That asymmetry with headline/KPI is the whole rule:
// PRESENTATION LIVES WHERE THE THING IS NAMED. A headline names itself, so it carries its own; a cell is named
// once by its column, so the column carries it for every row.
export type CellObject = { value: unknown; display?: string; id?: string | number; entity?: string }
export type Cell = string | number | boolean | null | CellObject
const isObj = (c: unknown): c is CellObject =>
  !!c && typeof c === 'object' && !Array.isArray(c) && 'value' in (c as any)

export const cellValue = (c: Cell): any => isObj(c) ? c.value : c
export const cellText  = (c: Cell): string => {
  if (isObj(c) && typeof c.display === 'string') return c.display
  const v = cellValue(c)
  return v == null ? '' : String(v)
}
/** Does this cell bring its own wording? Only then does the column's formatting stand aside. */
export const isObj_display = (c: Cell): boolean =>
  !!c && typeof c === 'object' && !Array.isArray(c) && typeof (c as CellObject).display === 'string'
export const cellId    = (c: Cell): string | undefined => isObj(c) && c.id != null ? String(c.id) : undefined
/** The kind of thing a cell names: the column's, unless the cell overrides it — which a column mixing kinds
 *  needs, and which costs one word in a program that was going to be written anyway. */
export const cellEntity = (c: Cell, columnEntity?: string): string | undefined =>
  isObj(c) && c.id != null ? (c.entity || columnEntity) : undefined

// ── ONE SHAPE FOR A COLUMN ──────────────────────────────────────────────────────────────────────────────────
// A money column, an hours column and a percentage are the same thing: a number with a UNIT and a PRECISION.
// Giving money its own mechanism would mean the next unit needs one too, so there is one set of keys and money
// is just `unit: 'AUD'`.
//
// The program sends the raw number and says how it should read. It cannot send the formatted string instead —
// that loses the number, and with it sorting, alignment and the bar.
export interface ColumnSpec {
  label: string
  entity?: string                    // cells in this column name a thing of this kind, and carry its id
  unit?: string                      // 'AUD', 'h', '%', 'kg' — a currency code leads, anything else follows
  decimals?: number                  // how precise the figure actually is; 686.76895 hours is not 5-decimal data
  scale?: 'compact'                  // 4.16 M rather than 4,160,000
  good?: 'high' | 'low'              // which direction is favourable; absent ⇒ no colour
  mid?: number                       // the line `good` turns on (default 0, which is what a delta wants)
  bar?: boolean                      // shade the cell by magnitude, behind the figure
}
export type Column = string | ColumnSpec

// A currency reads before the number, a unit of measure after it — "AUD 4.16 M", "686.8 h", "83.4%". The test
// is what a currency code looks like, because that is the only class that leads.
const LEADS = /^[A-Z]{3}$|^[$€£¥₹]$/
export function formatNumber(n: number, c: ColumnSpec): string {
  const dp = c.decimals ?? (c.scale === 'compact' ? 2 : Number.isInteger(n) ? 0 : 1)
  const body = c.scale === 'compact'
    ? compact(n, dp)
    : n.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })
  if (!c.unit) return body
  return c.unit === '%' ? `${body}%`                       // no space, the way a percentage is written
       : LEADS.test(c.unit) ? `${c.unit} ${body}`
       : `${body} ${c.unit}`
}
function compact(n: number, dp: number): string {
  const abs = Math.abs(n)
  const [div, suffix] = abs >= 1e9 ? [1e9, ' B'] : abs >= 1e6 ? [1e6, ' M'] : abs >= 1e3 ? [1e3, ' K'] : [1, '']
  // Trailing zeros stripped from the NUMBER, before the suffix goes on — "2.5 B", not "2.50 B". Doing it after
  // meant the pattern never matched, because the string ended in " B".
  const body = (n / div).toFixed(suffix ? dp : Math.min(dp, 2)).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1')
  return body + suffix
}

export const colLabel = (c: Column): string => typeof c === 'string' ? c : (c?.label ?? '')
export const colSpec  = (c: Column): ColumnSpec => typeof c === 'string' ? { label: c } : (c ?? { label: '' })

// GROUPING THE BEATS — used by the live card AND by a finished question's card, because they show the same
// thing and drifted apart the moment only one of them learned to group. A run of consecutive PROGRAM beats
// collapses to its latest, which is what a progress line is for; a chevron opens the rest.
export type BeatMeta = { kind: 'narrator' | 'program'; detail?: string }
export interface BeatRow { key: string; text: string; secs: number; prog: boolean; past: boolean
                           detail?: string; chevron: 'none' | 'open' | 'closed'; count: number; head: number }
export function buildBeatRows(log: string[], meta: BeatMeta[], secs: (i: number) => number, expanded: Set<number>): BeatRow[] {
  const groups: Array<{ prog: boolean; idxs: number[] }> = []
  log.forEach((_, i) => {
    const prog = meta[i]?.kind === 'program'
    const last = groups[groups.length - 1]
    if (last && last.prog && prog) last.idxs.push(i)
    else groups.push({ prog, idxs: [i] })
  })
  const rows: BeatRow[] = []
  for (const g of groups) {
    const head = g.idxs[0]
    const open = expanded.has(head)
    const many = g.prog && g.idxs.length > 1
    const shown = g.prog && !open ? [g.idxs[g.idxs.length - 1]] : g.idxs
    // A COLLAPSED ROW STANDS FOR THE WHOLE RUN, so it carries the whole run's time. Showing the last beat's
    // own duration said "2s" for twelve steps that took the better part of a minute — the one number on the
    // row, and it was describing something the reader could not see.
    const total = g.idxs.reduce((sum, i) => sum + secs(i), 0)
    shown.forEach((i, n) => rows.push({
      key: `${head}:${i}`, text: log[i], secs: (g.prog && !open && many) ? total : secs(i), prog: g.prog,
      past: i !== log.length - 1, detail: open ? meta[i]?.detail : undefined,
      chevron: many && n === 0 ? (open ? 'open' : 'closed') : 'none',
      count: g.idxs.length, head,
    }))
  }
  return rows
}
