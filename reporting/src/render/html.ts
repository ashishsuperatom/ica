// ── Answer → HTML ────────────────────────────────────────────────────────────
// ONE renderer, three consumers:
//   • the browser view  — this HTML, served as-is with the stylesheet in a <style>
//   • the image         — this same HTML, handed to the image renderer, which reads
//                         that <style> block through its own CSS engine
//   • email             — this same HTML with the stylesheet inlined onto elements
//                         (Outlook drops <style>); see email.ts
// Because all three consume one function, they cannot drift. That was the whole
// problem with the Adaptive-Card path: a second hand-written renderer that slowly
// stopped resembling the real UI.
//
// The markup stays deliberately plain — tables, divs, flex — because it has to
// survive both a WASM CSS engine and Outlook's renderer.

import type { Answer, AnswerSection, AnswerTable, Figure } from '../types.js'
import { stylesheet, type Theme } from './theme.js'

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Parse a formatted cell back to a number: "$4,200,000" → 4200000, "(1,200)" → -1200,
 *  "+12.2%" → 12.2. Returns null when the cell isn't a number at all. */
export function parseNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-') || s.startsWith('\u2212')
  const cleaned = s.replace(/[()\s,]/g, '').replace(/^[-+\u2212]/, '').replace(/^[$€£¥₹]/, '').replace(/%$/, '')
  if (!/^\d*\.?\d+$/.test(cleaned)) return null
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? (neg ? -n : n) : null
}

/** Which columns are numeric, so they can be right-aligned — decided from the DATA,
 *  not the header text, and only when a clear majority of non-empty cells parse as
 *  numbers (one stray "n/a" shouldn't left-align a column of money). */
function numericColumns(columns: string[], rows: unknown[][]): boolean[] {
  return columns.map((_, i) => {
    let num = 0, seen = 0
    for (const r of rows) {
      const v = r?.[i]
      if (v == null || v === '') continue
      seen++
      if (typeof v === 'number' || /^[-+(]?[$€£]?\s?[\d,]+(\.\d+)?\s?%?\)?$/.test(String(v).trim())) num++
    }
    return seen > 0 && num / seen >= 0.8
  })
}

/** A table lives in a card, so its header band and spill footer sit inside one
 *  rounded shell — the same shape the web app gives it. */
/** Pick ONE column to carry magnitude bars, or none.
 *
 *  A bar is a purely DESCRIPTIVE encoding — it says "this row is bigger than that
 *  row", which is always true of the numbers as printed. It asserts nothing about
 *  whether big is good. That's why it's safe to add without knowing the domain, and
 *  why we place it on a magnitude column rather than a delta column.
 *
 *  Requirements, all of them about not lying:
 *   • every value non-negative — a bar length can't express a sign
 *   • at least 3 rows and real spread — bars on 2 rows, or on near-identical values,
 *     invent a comparison that isn't there
 *   • not a percentage-ish column — those are usually rates or deltas, where relative
 *     bar length implies a ranking the numbers don't support
 */
function barColumn(cols: string[], rows: unknown[][], num: boolean[]): number {
  if (rows.length < 3) return -1
  for (let i = 0; i < cols.length; i++) {
    if (!num[i] || i === 0) continue
    if (/%|pct|percent|margin|rate|share|change|delta|yoy|growth/i.test(cols[i])) continue
    const vals = rows.map((r) => parseNum(r?.[i])).filter((n): n is number => n != null)
    if (vals.length < rows.length * 0.9) continue
    if (vals.some((v) => v < 0)) continue
    const max = Math.max(...vals), min = Math.min(...vals)
    // Only draw the comparison when the comparison is VISIBLE. At low spread every
    // bar is the same length, which is truthful and useless — it adds noise and
    // implies a distinction the eye can't read. 0.35 is a parameter, not a law.
    if (max <= 0 || (max - min) / max < 0.35) continue
    return i
  }
  return -1
}

function tableHtml(t: AnswerTable & { fit?: { spill?: string } }, note?: string): string {
  const cols = t.columns ?? []
  const rows = t.rows ?? []
  const num = numericColumns(cols, rows)
  const barCol = barColumn(cols, rows, num)
  const barMax = barCol >= 0 ? Math.max(...rows.map((r) => parseNum(r?.[barCol]) ?? 0)) : 0
  // `first`/`last` let the rule chrome pull the outer padding to the page edge, so a
  // table's first column lines up with the prose above it.
  const cls = (i: number) => {
    const c = [num[i] ? 'num' : '', i === 0 ? 'first' : '', i === cols.length - 1 ? 'last' : ''].filter(Boolean)
    return c.length ? ` class="${c.join(' ')}"` : ''
  }
  const cell = (v: unknown, i: number) => {
    if (i !== barCol) return esc(v)
    const n = parseNum(v)
    const pct = n != null && barMax > 0 ? Math.max(2, Math.round((n / barMax) * 100)) : 0
    // The bar sits UNDER the number, in flow — no absolute positioning, which keeps
    // it identical in the browser, the image and email.
    return `${esc(v)}<span class="sa-barwrap"><span class="sa-bar" style="width:${pct}%"></span></span>`
  }
  const head = `<tr>${cols.map((c, i) => `<th${cls(i)}>${esc(c)}</th>`).join('')}</tr>`
  const body = rows.map((r) => `<tr>${cols.map((_, i) => `<td${cls(i)}>${cell(r?.[i], i)}</td>`).join('')}</tr>`).join('')
  const total = t.total ? `<tr class="total">${cols.map((_, i) => `<td${cls(i)}>${esc(t.total![i])}</td>`).join('')}</tr>` : ''
  // The spill line is the reduction notice; it reads as a table footer, in the
  // accent colour, because it is the thing a reader must not miss.
  const spill = t.fit?.spill ? `<div class="sa-spill">${esc(t.fit.spill)}</div>` : ''
  const n = note ? `<div class="sa-note">${esc(note)}</div>` : ''
  // The scroll wrapper is always emitted; only the web stylesheet gives it overflow.
  // In the image it is an inert div, so both surfaces share one markup tree.
  return `<div class="sa-card"><div class="sa-scroll"><table class="sa-table">` +
    `<thead>${head}</thead><tbody>${body}${total}</tbody></table></div>${n}${spill}</div>`
}

/** KPIs render as the web app's stat row: tiles sharing the width, separated by a
 *  left hairline. `first` suppresses the leading divider — the web CSS clips it with
 *  a negative margin, which we can't rely on across three renderers, so it's a class. */
function kpisHtml(items: Figure[]): string {
  if (!items.length) return ''
  const tile = (f: Figure, i: number) => {
    const tone = f.neg === true ? ' negative' : f.neg === false ? ' positive' : ''
    return `<div class="sa-stat${i === 0 ? ' first' : ''}"><div class="sa-stat-label">${esc(f.label)}</div>` +
      `<div class="sa-num${tone}">${esc(f.display)}</div>` +
      (f.sub ? `<div class="sa-stat-sub">${esc(f.sub)}</div>` : '') + `</div>`
  }
  return `<div class="sa-card sa-card-pad"><div class="sa-stats">${items.map(tile).join('')}</div></div>`
}

function sectionHtml(s: AnswerSection): string {
  const title = s.title ? `<div class="sa-sec-title">${esc(s.title)}</div>` : ''
  let inner = ''
  if (s.kind === 'table' && s.columns?.length) inner = tableHtml({ columns: s.columns, rows: s.rows ?? [], total: s.total, fit: s.fit } as AnswerTable & { fit?: { spill?: string } }, s.note)
  else if (s.kind === 'kpis') inner = kpisHtml(s.items ?? [])
  else if (s.kind === 'text' && s.body) inner = `<div class="sa-card sa-card-pad"><div class="sa-prose">${paragraphs(s.body)}</div></div>`
  return inner ? `${title}${inner}` : ''
}

/** Minimal prose handling: blank-line paragraphs and **bold**. Deliberately not a
 *  markdown engine — the engine's prose is plain, and every construct we support
 *  is one more thing that must render identically in three places. */
function paragraphs(text: string): string {
  return String(text).split(/\n{2,}/).map((p) =>
    esc(p.trim()).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br/>')
  ).filter(Boolean).map((p) => `<p>${p}</p>`).join('')
}

export interface RenderHtmlOptions {
  theme: Theme
  /** Which surface this document is for. The markup is IDENTICAL either way — only the
   *  stylesheet differs, scoped by a class on the root. It has to: a browser can scroll
   *  a wide table sideways, and an image cannot scroll at all. Rules that assume a
   *  viewport (overflow, nowrap, a centred max-width column) would silently break the
   *  image, where the frame is the whole world. */
  surface?: 'web' | 'image'
  scale?: number           // px multiplier baked into the stylesheet (see theme.ts)
  title?: string           // the question, normally
  footerLeft?: string      // e.g. "Generated 21 Aug 2026"
  footerRight?: string     // e.g. "View full report ↗" (the caller supplies the words)
  fitNotes?: string[]      // reductions to announce (image only; empty for html/email)
}

/** The report body — no <html>/<head>. `fragment` is what the image renderer and
 *  the email inliner want; `document()` wraps it for the browser. */
export function renderFragment(a: Answer, o: RenderHtmlOptions): string {
  const prose = Array.isArray(a.answer) ? a.answer : a.answer ? [a.answer] : []
  const caveats = Array.isArray(a.caveat) ? a.caveat : a.caveat ? [a.caveat] : []
  const brandInner = o.theme.logoUrl
    ? `<img class="sa-logo" src="${esc(o.theme.logoUrl)}"/><span>${esc(o.theme.wordmark ?? '')}</span>`
    : `<span>${esc(o.theme.wordmark ?? '')}</span>`

  const parts: string[] = []
  parts.push(`<div class="sa-masthead"></div>`)
  parts.push(`<div class="sa-head"><div class="sa-brand">${brandInner}</div>` +
    (a.category ? `<div class="sa-cat">${esc(String(a.category).replace(/_/g, ' '))}</div>` : '') + `</div>`)
  if (o.title) parts.push(`<div class="sa-title">${esc(o.title)}</div>`)
  // The period is a labelled fact ("TIME FILTER — …"), not a caption: it changes
  // what every number below it means, so it gets the accent pill.
  if (a.period || a.scope) {
    // Every child is an explicit element: a bare text node inside a flex row becomes
    // an anonymous item and lays out unpredictably.
    const pill = a.period ? `<span class="pk">Time filter</span>` : ''
    const value = [a.period ? `<b>${esc(a.period)}</b>` : '', a.scope ? `${a.period ? ' &middot; ' : ''}${esc(a.scope)}` : '']
      .filter(Boolean).join('')
    parts.push(`<div class="sa-period">${pill}<span class="pv">${value}</span></div>`)
  }
  if (prose.length) parts.push(`<div class="sa-card sa-card-pad"><div class="sa-prose">${prose.map((p) => paragraphs(String(p))).join('')}</div></div>`)
  if (a.figures?.length) parts.push(kpisHtml(a.figures))
  if (a.table?.columns?.length) parts.push(tableHtml(a.table as AnswerTable))
  for (const s of a.sections ?? []) parts.push(sectionHtml(s))
  for (const c of caveats) parts.push(`<div class="sa-caveat">${esc(c)}</div>`)
  // Reductions are announced in the artefact itself — an image must never be
  // mistaken for the whole answer.
  if (o.fitNotes?.length) parts.push(`<div class="sa-card"><div class="sa-spill">${esc(o.fitNotes.join('  ·  '))}</div></div>`)
  if (o.footerLeft || o.footerRight) {
    parts.push(`<div class="sa-foot"><div>${esc(o.footerLeft ?? '')}</div><div class="link">${esc(o.footerRight ?? '')}</div></div>`)
  }
  return `<div class="sa-report ${o.surface === 'image' ? 'img' : 'web'}">${parts.join('')}</div>`
}

/** A full standalone document — what the browser gets, and what the image renderer
 *  is handed (it reads the <style> block through its own CSS engine). */
export function renderDocument(a: Answer, o: RenderHtmlOptions): string {
  // NOTE: `.sa-report` deliberately has NO width. The image renderer's frame width
  // (and the browser viewport) define it, and the report fills what it's given.
  // Setting an explicit width *and* padding overflowed the frame and silently
  // clipped the right edge — titles cut mid-word, table columns lost.
  return `<!doctype html><html><head><meta charset="utf-8"/>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"/>` +
    `<title>${esc(o.title ?? 'Report')}</title>` +
    `<style>${stylesheet(o.theme, o.scale ?? 1)}</style>` +
    `</head><body>${renderFragment(a, o)}</body></html>`
}
