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
  const flushPara = () => { if (para.length) { out.push(para.join('<br/>')); para = [] } }
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
// A cell is a scalar, or a scalar WITH an identity: `{ v: 'Fusion5 PTY LTD', id: 431 }`. Co-located, so the id
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
export const cellId    = (c: Cell): string | undefined => isObj(c) && c.id != null ? String(c.id) : undefined
/** The kind of thing a cell names: the column's, unless the cell overrides it — which a column mixing kinds
 *  needs, and which costs one word in a program that was going to be written anyway. */
export const cellEntity = (c: Cell, columnEntity?: string): string | undefined =>
  isObj(c) && c.id != null ? (c.entity || columnEntity) : undefined

// A column is a label, or a label with what the renderer needs to present it properly. `good` says which
// DIRECTION is favourable — only the program knows whether high utilisation or low cost is the good news, and
// a renderer that guesses will confidently colour a number wrong, which is worse than leaving it plain.
export interface ColumnSpec {
  label: string
  entity?: string                    // cells in this column identify an entity of this type
  format?: 'percent' | 'number'      // percent renders 0.83 as 83%
  good?: 'high' | 'low'              // colour by direction; absent ⇒ no colour
  mid?: number                       // the dividing line for `good` (default 0, which is right for deltas)
  bar?: boolean                      // an in-cell proportional bar, scaled to the column's largest value
}
export type Column = string | ColumnSpec
export const colLabel = (c: Column): string => typeof c === 'string' ? c : (c?.label ?? '')
export const colSpec  = (c: Column): ColumnSpec => typeof c === 'string' ? { label: c } : (c ?? { label: '' })
