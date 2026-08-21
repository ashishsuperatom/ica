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
function tableHtml(t: AnswerTable & { fit?: { spill?: string } }, note?: string): string {
  const cols = t.columns ?? []
  const rows = t.rows ?? []
  const num = numericColumns(cols, rows)
  const cls = (i: number) => (num[i] ? ' class="num"' : '')
  const head = `<tr>${cols.map((c, i) => `<th${cls(i)}>${esc(c)}</th>`).join('')}</tr>`
  const body = rows.map((r) => `<tr>${cols.map((_, i) => `<td${cls(i)}>${esc(r?.[i])}</td>`).join('')}</tr>`).join('')
  const total = t.total ? `<tr class="total">${cols.map((_, i) => `<td${cls(i)}>${esc(t.total![i])}</td>`).join('')}</tr>` : ''
  // The spill line is the reduction notice; it reads as a table footer, in the
  // accent colour, because it is the thing a reader must not miss.
  const spill = t.fit?.spill ? `<div class="sa-spill">${esc(t.fit.spill)}</div>` : ''
  const n = note ? `<div class="sa-note">${esc(note)}</div>` : ''
  return `<div class="sa-card"><table class="sa-table"><thead>${head}</thead><tbody>${body}${total}</tbody></table>${n}${spill}</div>`
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
  parts.push(`<div class="sa-head"><div class="sa-brand">${brandInner}</div>` +
    (a.category ? `<div class="sa-cat">${esc(String(a.category).replace(/_/g, ' '))}</div>` : '') + `</div>`)
  if (o.title) parts.push(`<div class="sa-title">${esc(o.title)}</div>`)
  const scope = [a.period, a.scope].filter(Boolean).join(' · ')
  if (scope) parts.push(`<div class="sa-scope">${esc(scope)}</div>`)
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
  return `<div class="sa-report">${parts.join('')}</div>`
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
