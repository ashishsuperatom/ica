// THE STEP STANDARD (design/DESIGN-SYSTEM.md "A step — the standard"): a program step reads like an Ask answer — checked
// on the markup the framework draws and on its stylesheets, no browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { BlockView, TablesFull, PlainParts, Section, Accordion, PLAIN_ROWS, readBlock, choiceNote, choiceCells, shownFilters, clearOps, FILTERS_SHOWN, Kpi, type FilterRow } from '../src/index.ts'
import Answer from '../src/components/answer/Answer.tsx'

const doc = (html: string) => new JSDOM(`<main>${html}</main>`).window.document
const filter = (over: Partial<FilterRow> = {}): FilterRow => ({ path: 'stock.plant', label: 'Plant', size: 'medium', many: false, value: [], noun: ['SKU', 'SKUs'], unit: 'count', choices: [{ value: 'P1', label: 'Pune', count: 776, amount: 1478 }], ...over })

/** No card, no bordered strip, no shadow box around anything on a step but a KPI card. */
const noCards = (d: Document, what: string) => {
  assert.deepEqual([...d.querySelectorAll('.sa-card')].filter((c) => !c.classList.contains('sa-kpi')).map((c) => c.className), [], `${what}: no card`)
  assert.equal(d.querySelector('.sa-section, .sa-section__head, .sa-section__foot'), null, `${what}: no header strip`)
}

test("the filter row is SLOB's pills: the name inside each pill, no label above a box, no full-width box; a few side by side, more in grid slots; Fewer/More, Break down by and Clear all in the same row", () => {
  // as the platform sends it: a choice that holds nothing is never offered, a size it does not know is small (1×)
  const read = readBlock({ type: 'filters', filters: [{ path: 'stock.plant', label: 'Plant', size: 'huge', value: ['P1'], choices: [{ value: 'P1', label: 'Pune', count: 776 }, { value: 'P2', label: 'Goa', count: 0 }] }],
    breakdown: { path: 'stock.by', label: 'Break down by', value: null, choices: [{ value: 'plant', label: 'Plant' }] } })
  assert.equal(read.type, 'filters')
  if (read.type !== 'filters') return
  assert.deepEqual(read.filters[0].choices.map((c) => c.value), ['P1'])
  assert.equal(read.filters[0].size, 'small', 'a size it does not know is 1×')

  // a few: side by side at their own width, each a pill — "Plant Pune ⌄", the chosen one tinted
  const few = [filter({ size: 'small', value: ['P1'] }), filter({ path: 'stock.kind', label: 'Kind', size: 'large', many: true }), filter({ path: 'stock.a', label: 'Category' })]
  const d = doc(renderToStaticMarkup(<BlockView block={{ type: 'filters', filters: few, breakdown: read.breakdown }} />))
  const row = d.querySelector('.sa-filters')!
  assert.ok(row.parentElement?.classList.contains('sa-filters-box'), 'the grid sits in its container (its unit count by width)')
  const pills = [...row.querySelectorAll('.sa-filter > .sa-select > button[role=combobox]')]
  assert.deepEqual(pills.map((p) => [p.querySelector('.sa-combobox__label')?.textContent, p.querySelector('.sa-combobox__value')?.textContent]),
    [['Plant', 'Pune'], ['Kind', 'All'], ['Category', 'All'], ['Break down by', '—']], 'the name inside the pill, then the choice — "All" when none')
  for (const p of pills) {
    assert.match(p.className, /sa-combobox--pill/)
    assert.doesNotMatch(p.className, /sa-input/, 'never a full-width input box')
  }
  assert.equal(pills[0].getAttribute('data-set'), 'true', 'a chosen filter is tinted')
  assert.equal(pills[1].getAttribute('data-set'), 'false')
  assert.equal(d.querySelector('.sa-filter__label, .sa-field__label, label'), null, 'no label above a box')
  assert.equal(d.querySelectorAll('.sa-filter > :not(.sa-select, .sa-btn--link)').length, 0, 'a slot holds its pill (or one of the row\'s own controls) only')
  assert.equal(pills[2].getAttribute('title'), 'Category  All', 'its whole text in its title, when it truncates')
  assert.match(row.textContent ?? '', /Clear all/)
  // nothing in force: no Clear all
  assert.doesNotMatch(renderToStaticMarkup(<BlockView block={{ type: 'filters', filters: [filter()] }} />), /Clear all/)

  // more than fit: "+ More (n)" in the same row; shown, they take their slots on the grid
  const many = Array.from({ length: FILTERS_SHOWN + 2 }, (_, i) => filter({ path: `s.f${i}`, label: `F${i}`, size: i === 0 ? 'large' : 'medium', value: i === FILTERS_SHOWN + 1 ? ['P1'] : [] }))
  const m = doc(renderToStaticMarkup(<BlockView block={{ type: 'filters', filters: many }} />))
  assert.match(m.querySelector('.sa-filters')!.textContent ?? '', /\+ More \(1\)/)
  assert.deepEqual([...m.querySelectorAll('.sa-filter')].slice(0, 2).map((s) => s.getAttribute('data-size')), ['large', 'medium'])
  // Fewer/More, Break down by and Clear all: one unit each, in the same grid
  assert.ok([...m.querySelectorAll('.sa-filters > .sa-filter')].every((s) => ['small', 'medium', 'large'].includes(s.getAttribute('data-size') ?? '')), 'every slot a size: 1×, 2× or 4×')
  assert.equal(m.querySelector('.sa-filters__more')?.parentElement?.getAttribute('data-size'), 'small')

  // each choice: its count and amount, right-aligned columns in the dropdown
  assert.deepEqual(choiceCells({ value: 'P1', label: 'Pune', count: 776, amount: 1478 }, { noun: ['SKU', 'SKUs'], unit: 'count' }, (v) => String(v)), ['776 SKUs', '1478'])
  assert.deepEqual(choiceCells({ value: 'P1', label: 'Pune', count: 1 }, {}, (v) => String(v)), ['1 item'])
  assert.equal(choiceNote({ value: 'P1', label: 'Pune', count: 776, amount: 1478 }, { noun: ['SKU', 'SKUs'], unit: 'count' }, (v) => String(v)), '776 SKUs · 1478')
  // the first few show, and any with a choice in force; More shows them all
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

test('a chart is drawn plainly — its heading, its line, the chart; its other views behind one quiet button, not shown until asked', () => {
  const bars = { type: 'bars', title: 'Stock by plant', says: 'What each plant holds', axis: 'plant', unit: 'count', whole: true, series: [{ key: 'n', label: 'SKUs' }],
    rows: [{ label: 'Pune', values: { n: 3 } }, { label: 'Goa', values: { n: 1 } }] }
  const d = doc(renderToStaticMarkup(<BlockView block={readBlock(bars)} />))
  noCards(d, 'bars')
  assert.equal(d.querySelector('.sa-part__title')?.textContent, 'Stock by plant')
  assert.equal(d.querySelector('.sa-part__note')?.textContent, 'What each plant holds', 'the one line under its heading')
  assert.equal(d.querySelectorAll('.sa-part__chart').length, 1, 'one picture')
  assert.equal(d.querySelector('table'), null, 'the table waits behind the button')
  assert.equal(d.querySelector('[role=radio], [role=radiogroup], .sa-toggle'), null, 'no table/chart pair shown')
  assert.equal(d.querySelector('[role=menu]'), null, 'the options are not shown by default')
  const button = d.querySelector('.sa-part__tools button[aria-haspopup=menu]')!
  assert.ok(button, 'one quiet button opens them')
  assert.equal(button.getAttribute('aria-expanded'), 'false')
  assert.match(button.getAttribute('aria-label') ?? '', /Show as/)
  // a trend too
  const trend = doc(renderToStaticMarkup(<BlockView block={readBlock({ type: 'trend', title: 'By month', unit: 'count', periods: ['2026-01'], series: [{ key: 'n', label: 'N' }], values: { '2026-01': { n: 1 } } })} />))
  noCards(trend, 'trend')
  assert.ok(trend.querySelector('.sa-part__tools button[aria-haspopup=menu]'))
  assert.equal(trend.querySelector('[role=radio]'), null)
})

test('a table is shown open and plain: the first 10 rows, then "Show more"; no accordion; full screen behind the expand button', () => {
  const rows = Array.from({ length: 27 }, (_, i) => ({ sku: `S${i}`, n: i }))
  const table = readBlock({ type: 'table', title: 'Every SKU', says: 'Largest first', columns: [{ key: 'sku', label: 'SKU' }, { key: 'n', label: 'Cases', unit: 'count' }], rows, rowMove: { dim: 'sku', key: 'sku', label: 'sku' } })
  const d = doc(renderToStaticMarkup(<BlockView block={table} onRow={() => {}} />))
  noCards(d, 'table')
  assert.equal(PLAIN_ROWS, 10)
  assert.equal(d.querySelectorAll('tbody tr').length, 10, 'the first ten rows, shown')
  assert.equal(d.querySelectorAll('tbody tr[data-open]').length, 10, 'a row that drills still opens from the plain table')
  assert.match(d.querySelector('.sa-part__more')?.textContent ?? '', /Show more.*10 of 27 rows/)
  assert.equal(d.querySelector('.sa-closed, details, [aria-expanded="false"]:not([aria-haspopup])'), null, 'nothing folded')
  assert.equal(d.querySelector('input[type=search]'), null, 'no search box on the plain table')
  assert.ok(d.querySelector('.sa-part__tools button[aria-label="Open full screen"]'), 'full screen a click away')
  assert.equal(d.querySelector('[role=dialog]'), null, 'not open until asked')
  assert.equal(d.querySelector('.sa-part__title')?.textContent, 'Every SKU')
  // a short table: every row, no Show more
  const short = doc(renderToStaticMarkup(<BlockView block={readBlock({ type: 'table', title: 'Three', columns: [{ key: 'sku', label: 'SKU' }], rows: rows.slice(0, 3) })} />))
  assert.equal(short.querySelectorAll('tbody tr').length, 3)
  assert.equal(short.querySelector('.sa-part__more'), null)
  // opened on purpose (a card opened from an answer): the analysis in place — search, sortable heads, every row
  const full = doc(renderToStaticMarkup(<TablesFull.Provider value={true}><BlockView block={table} /></TablesFull.Provider>))
  noCards(full, 'the full table')
  assert.equal(full.querySelectorAll('tbody tr').length, 27)
  assert.ok(full.querySelector('input[type=search]'))
  assert.ok(full.querySelector('.sa-analysis__filters'), 'a filter under every head')
})

test("a table the source pages: plain, its page's first rows; full, it pages and searches every row through the program's own STATE", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ pr: `PR-${i}` }))
  const block = readBlock({ type: 'table', title: 'Purchase requests', columns: [{ key: 'pr', label: 'Request' }], rows, page: { id: 'requisition', page: 2, size: 100, total: 4321, set: { page: 'requisition.page', search: 'requisition.q' }, search: 'coal' } })
  assert.equal(block.type, 'table')
  if (block.type !== 'table') return
  assert.deepEqual(block.page?.set, { page: 'requisition.page', search: 'requisition.q' })
  const plain = doc(renderToStaticMarkup(<BlockView block={block} />))
  assert.equal(plain.querySelectorAll('tbody tr').length, 10)
  assert.match(plain.querySelector('.sa-part__more')?.textContent ?? '', /10 of 4,321 rows/)
  const full = doc(renderToStaticMarkup(<TablesFull.Provider value={true}><BlockView block={block} /></TablesFull.Provider>))
  assert.equal(full.querySelector('input[type=search]')?.getAttribute('value'), 'coal', 'its search, over every row')
  assert.match(full.querySelector('.sa-pager')?.textContent ?? '', /101–200 of 4321/)
})

test('a step reads like an Ask answer: words, KPI cards (the only cards), plain parts; a Section a program draws on a step is a plain part', () => {
  const md = ':::filters f\n\n:::kpis k\n\n## What to do\n\nTwo sentences. Plain.\n\n:::bars b\n\n:::table t'
  const blocks = {
    f: { type: 'filters', filters: [{ path: 's.c', label: 'Category', value: [], choices: [{ value: 'a', label: 'A', count: 2 }] }] },
    k: { type: 'kpis', items: [{ label: 'Total', value: 1, unit: 'count' }, { label: 'Late', value: 2, unit: 'count', state: 'warning' }] },
    b: { type: 'bars', title: 'By plant', axis: 'plant', unit: 'count', series: [{ key: 'n', label: 'N' }], rows: [{ label: 'Pune', values: { n: 3 } }] },
    t: { type: 'table', title: 'Rows', columns: [{ key: 'x', label: 'X' }], rows: [{ x: 'a' }] },
  }
  const d = doc(renderToStaticMarkup(<PlainParts.Provider value={true}><div className="sa-step"><Answer markdown={md} blocks={blocks} /></div></PlainParts.Provider>))
  noCards(d, 'the step')
  assert.equal(d.querySelectorAll('.sa-kpi').length, 2, 'KPI cards still drawn')
  assert.ok([...d.querySelectorAll('.sa-kpi')].every((k) => k.classList.contains('sa-card')), 'as cards')
  assert.equal(d.querySelectorAll('.sa-part').length, 2, 'the chart and the table, each a plain part')
  assert.equal(d.querySelectorAll('.sa-combobox--pill').length, 1)
  assert.equal(d.querySelector('h1'), null, "no page title of its own: the frame's title is the heading")
  // a program's own Section, drawn on a step: a plain part, never a card
  const own = doc(renderToStaticMarkup(<PlainParts.Provider value={true}><Section icon="lucide:list" title="Levers" subtitle="What each can use" note="13" actions={<button>x</button>}><p>body</p></Section></PlainParts.Provider>))
  noCards(own, "a program's Section")
  assert.equal(own.querySelector('.sa-part__title')?.textContent, 'Levers')
  assert.equal(own.querySelector('.sa-part__note')?.textContent, 'What each can use · 13')
  // an accordion a program draws on a step folds nothing: every item shown, each a plain part
  const acc = doc(renderToStaticMarkup(<PlainParts.Provider value={true}><Accordion items={[{ key: 'a', title: 'One', body: () => <p>first</p> }, { key: 'b', title: 'Two', body: () => <p>second</p> }]} /></PlainParts.Provider>))
  assert.deepEqual([...acc.querySelectorAll('.sa-part__body')].map((b) => b.textContent), ['first', 'second'])
  assert.equal(acc.querySelector('[aria-expanded]'), null)
  // off a step (a control-plane page) it is still the card
  assert.ok(doc(renderToStaticMarkup(<Section icon="lucide:list" title="Levers"><p>body</p></Section>)).querySelector('.sa-card.sa-section'))
})

test("a program's answer shows every part at once; only an answer arriving in the chat unfolds", () => {
  const md = 'Words first.\n\n:::kpis k\n\nMore words.'
  const blocks = { k: { type: 'kpis', items: [{ label: 'Total', value: 1, unit: 'count' }] } }
  assert.doesNotMatch(renderToStaticMarkup(<Answer markdown={md} blocks={blocks} />), /sa-reveal/)
  assert.match(renderToStaticMarkup(<Answer markdown={md} blocks={blocks} arriving />), /sa-reveal/)
})

test('the stylesheets: no shadow and nothing raised — a box-shadow is none, an inset mark or a focus ring; no lift, no chart pair, no scroll-snapping, no closed table, no label above a filter', () => {
  const dir = fileURLToPath(new URL('../src/design/', import.meta.url))
  const css = readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(dir + f, 'utf8')] as const)
  for (const [f, text] of css) {
    for (const m of text.matchAll(/box-shadow:\s*([^;}]+)/g)) {
      const v = m[1].trim()
      assert.ok(/^(none|var\(--shadow-[a-z]+\))$/.test(v) || /^inset\b/.test(v) || /^0 0 0 [\d.]+px\b/.test(v), `${f}: box-shadow: ${v} — a thing pointed at shows a border or an outline, never a shadow`)
    }
    assert.doesNotMatch(text, /sa-card--lift|sa-chart-pair|scroll-snap|sa-closed|sa-filter__label/, f)
    for (const m of text.matchAll(/--shadow-[a-z]+:\s*([^;]+);/g)) assert.equal(m[1].trim(), 'none', `${f}: ${m[0]}`)
  }
  // the filter row: equal unit columns, packed densely; a filter spans 1, 2 or 4 units — never another width
  const prim0 = css.find(([f]) => f === 'primitives.css')![1]
  assert.match(prim0, /\.sa-filters \{[^}]*grid-template-columns: repeat\(var\(--filter-cols\), minmax\(0, 1fr\)\)[^}]*grid-auto-flow: row dense/)
  const spans = [...prim0.matchAll(/\.sa-filter\b[^{]*\{[^}]*grid-column: span (\d+)/g)].map((m) => Number(m[1]))
  assert.deepEqual([...new Set(spans)].sort(), [1, 2, 4])
  assert.ok(spans.every((n) => [1, 2, 4].includes(n)), `spans ${spans}`)
  const cols = [...prim0.matchAll(/--filter-cols: (\d+)/g)].map((m) => Number(m[1]))
  assert.deepEqual(cols, [1, 2, 4, 8], 'as many units as fit: 8 or 4 wide, fewer narrow')
  // a pill has a fill of its own, never the page's
  const tokens = css.find(([f]) => f === 'tokens.css')![1]
  const bg = /--pill-bg:\s*([^;]+);/.exec(tokens)?.[1].trim()
  assert.ok(bg && bg !== 'var(--page)' && bg !== 'var(--surface)', `--pill-bg is ${bg}`)
  assert.match(prim0, /\.sa-combobox--pill \{[^}]*background: var\(--pill-bg\)/)
  // a part of a step carries no border, background or shadow of its own
  const prim = css.find(([f]) => f === 'primitives.css')![1]
  for (const m of prim.matchAll(/^\.sa-part(__head|__body)?\s*\{([^}]*)\}/gm)) assert.doesNotMatch(m[2], /border|background|box-shadow/, `.sa-part${m[1] ?? ''}`)
})

test("every table's cells take their room from one pair of tokens, so a row's colour never meets its text", async () => {
  const { readFileSync } = await import('node:fs')
  const css = ['primitives.css', 'semantic.css'].map((f) => readFileSync(new URL(`../src/design/${f}`, import.meta.url), 'utf8')).join('\n')
  for (const sel of ['.sa-table td', '.sa-readtable td', '.sa-records__table td']) {
    const rule = new RegExp(`${sel.replace(/\./g, '\\.')} \\{[^}]*padding: var\\(--cell-py\\) var\\(--cell-px\\)`)
    assert.match(css, rule, `${sel} pads with the cell tokens`)
  }
})
