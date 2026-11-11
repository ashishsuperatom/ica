// THE STEP STANDARD (design/DESIGN-SYSTEM.md "A step — the standard"): what every program step looks like by default,
// checked on the markup the framework draws and on its stylesheets — no browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { BlockView, TablesOpen, readBlock, choiceNote, shownFilters, clearOps, FILTERS_SHOWN, Kpi, type FilterRow } from '../src/index.ts'
import Answer from '../src/components/answer/Answer.tsx'

const doc = (html: string) => new JSDOM(`<main>${html}</main>`).window.document
const filter = (over: Partial<FilterRow> = {}): FilterRow => ({ path: 'stock.plant', label: 'Plant', size: 'medium', many: false, value: [], noun: ['SKU', 'SKUs'], unit: 'count', choices: [{ value: 'P1', label: 'Pune', count: 776, amount: 1478 }], ...over })

test('the filter row: every filter in a slot of one grid, its choices computed — each saying what it holds — Fewer/More, Break down by and Clear all in the same row', () => {
  // as the platform sends it: a choice that holds nothing is never offered, a size it does not know is medium
  const read = readBlock({ type: 'filters', filters: [{ path: 'stock.plant', label: 'Plant', size: 'huge', value: ['P1'], choices: [{ value: 'P1', label: 'Pune', count: 776 }, { value: 'P2', label: 'Goa', count: 0 }] }],
    breakdown: { path: 'stock.by', label: 'Break down by', value: null, choices: [{ value: 'plant', label: 'Plant' }] } })
  assert.equal(read.type, 'filters')
  if (read.type !== 'filters') return
  assert.deepEqual(read.filters[0].choices.map((c) => c.value), ['P1'])
  assert.equal(read.filters[0].size, 'medium')

  const filters = [filter({ size: 'small', value: ['P1'] }), filter({ path: 'stock.kind', label: 'Kind', size: 'large', many: true }), filter({ path: 'stock.a', label: 'A' }), filter({ path: 'stock.b', label: 'B' }), filter({ path: 'stock.c', label: 'C' })]
  const d = doc(renderToStaticMarkup(<BlockView block={{ type: 'filters', filters, breakdown: read.breakdown }} />))
  const slots = [...d.querySelectorAll('.sa-filters > .sa-filter')]
  assert.deepEqual(slots.map((s) => [s.querySelector('.sa-filter__label')?.textContent, s.getAttribute('data-size')]), [['Plant', 'small'], ['Kind', 'large'], ['A', 'medium'], ['B', 'medium']])
  const end = d.querySelector('.sa-filters > .sa-filters__end')!
  assert.match(end.textContent ?? '', /More \(1\)/)
  assert.match(end.textContent ?? '', /Break down by/)
  assert.match(end.textContent ?? '', /Clear all/)
  // nothing in force: no Clear all
  assert.doesNotMatch(renderToStaticMarkup(<BlockView block={{ type: 'filters', filters: [filter()] }} />), /Clear all/)

  assert.equal(choiceNote({ value: 'P1', label: 'Pune', count: 776, amount: 1478 }, { noun: ['SKU', 'SKUs'], unit: 'count' }, (v) => String(v)), '776 SKUs · 1478')
  assert.equal(choiceNote({ value: 'P1', label: 'Pune', count: 1 }, {}, (v) => String(v)), '1 item')
  // the first few show, and any with a choice in force; More shows them all
  const many = Array.from({ length: FILTERS_SHOWN + 2 }, (_, i) => filter({ path: `s.f${i}`, value: i === FILTERS_SHOWN + 1 ? ['x'] : [] }))
  assert.deepEqual(shownFilters(many, false).map((f) => f.path), [...many.slice(0, FILTERS_SHOWN), many[FILTERS_SHOWN + 1]].map((f) => f.path))
  assert.equal(shownFilters(many, true).length, many.length)
  // Clear all: one choice back to all (null), several back to none chosen ([]); filters not in force are left alone
  assert.deepEqual(clearOps([filter({ value: ['P1'] }), filter({ path: 'stock.kind', many: true, value: ['FG', 'RM'] }), filter({ path: 'stock.c' })]),
    [{ op: 'set', path: 'stock.plant', value: null }, { op: 'set', path: 'stock.kind', value: [] }])
})

test('a KPI card is flat: label, one figure, one line, an arrow when it opens something — never a lift', () => {
  const d = doc(renderToStaticMarkup(<Kpi label="Stock" value="14.78 Cr" foot="776 SKUs" accent="warn" onClick={() => {}} />))
  const card = d.querySelector('.sa-kpi')!
  assert.doesNotMatch(card.className, /lift/)
  assert.equal(card.querySelector('.sa-kpi__label')!.children.length, 2, 'the label, then the arrow')
  assert.equal(doc(renderToStaticMarkup(<Kpi label="Stock" value="1" />)).querySelector('.sa-kpi__label')!.children.length, 1, 'no arrow when it opens nothing')
  assert.equal(d.querySelector('.sa-kpi__value')?.textContent, '14.78 Cr')
  assert.equal(d.querySelector('.sa-kpi__foot')?.textContent, '776 SKUs')
})

test('a section with a chart opens on its chart, one view at a time: the table a click away, a ring behind the ▾ — never a ring beside its bars', () => {
  const bars = { type: 'bars', title: 'Stock by plant', says: 'What each plant holds', axis: 'plant', unit: 'count', whole: true, series: [{ key: 'n', label: 'SKUs' }],
    rows: [{ label: 'Pune', values: { n: 3 } }, { label: 'Goa', values: { n: 1 } }] }
  const d = doc(renderToStaticMarkup(<BlockView block={readBlock(bars)} />))
  const radios = [...d.querySelectorAll('[role=radio]')]
  assert.deepEqual(radios.map((r) => [r.getAttribute('aria-label'), r.getAttribute('aria-checked')]), [['Table', 'false'], ['Bars — choose another', 'true']])
  assert.equal(d.querySelectorAll('.sa-section__chart').length, 1, 'one picture')
  assert.equal(d.querySelector('table'), null, 'the table waits a click away')
  assert.equal(d.querySelector('.sa-chart-pair'), null)
  assert.equal(d.querySelector('.sa-section__subtitle')?.textContent, 'What each plant holds', 'the one line under its title')
  // a trend opens on its chart too, its table a click away
  const trend = doc(renderToStaticMarkup(<BlockView block={readBlock({ type: 'trend', title: 'By month', unit: 'count', periods: ['2026-01'], series: [{ key: 'n', label: 'N' }], values: { '2026-01': { n: 1 } } })} />))
  assert.deepEqual([...trend.querySelectorAll('[role=radio]')].map((r) => r.getAttribute('aria-checked')), ['false', 'true'])
})

test('a table is closed by default — one line, its title and how many rows — and open where someone opened it on purpose', () => {
  const table = readBlock({ type: 'table', title: 'Every SKU', columns: [{ key: 'sku', label: 'SKU' }], rows: [{ sku: 'A' }, { sku: 'B' }, { sku: 'C' }] })
  const closed = doc(renderToStaticMarkup(<BlockView block={table} />))
  assert.equal(closed.querySelector('table'), null)
  const line = closed.querySelector('button.sa-closed')!
  assert.equal(line.getAttribute('aria-expanded'), 'false')
  assert.equal(line.textContent, 'Every SKU· 3 rows')
  const opened = doc(renderToStaticMarkup(<TablesOpen.Provider value={true}><BlockView block={table} /></TablesOpen.Provider>))
  assert.equal(opened.querySelectorAll('tbody tr').length, 3)
  assert.ok(opened.querySelector('[aria-label="Close the table"]'), 'it folds again')
})

test("a program's answer shows every part at once; only an answer arriving in the chat unfolds", () => {
  const md = 'Words first.\n\n:::kpis k\n\nMore words.'
  const blocks = { k: { type: 'kpis', items: [{ label: 'Total', value: 1, unit: 'count' }] } }
  assert.doesNotMatch(renderToStaticMarkup(<Answer markdown={md} blocks={blocks} />), /sa-reveal/)
  assert.match(renderToStaticMarkup(<Answer markdown={md} blocks={blocks} arriving />), /sa-reveal/)
})

test('the stylesheets: no shadow and nothing raised — a box-shadow is none, an inset mark or a focus ring; no lift, no chart pair, no scroll-snapping', () => {
  const dir = fileURLToPath(new URL('../src/design/', import.meta.url))
  const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(dir + f, 'utf8')] as const)
  for (const [f, text] of css) {
    for (const m of text.matchAll(/box-shadow:\s*([^;}]+)/g)) {
      const v = m[1].trim()
      assert.ok(/^(none|var\(--shadow-[a-z]+\))$/.test(v) || /^inset\b/.test(v) || /^0 0 0 [\d.]+px\b/.test(v), `${f}: box-shadow: ${v} — a thing pointed at shows a border or an outline, never a shadow`)
    }
    assert.doesNotMatch(text, /sa-card--lift|sa-chart-pair|scroll-snap/, f)
    for (const m of text.matchAll(/--shadow-[a-z]+:\s*([^;]+);/g)) assert.equal(m[1].trim(), 'none', `${f}: ${m[0]}`)
  }
})
