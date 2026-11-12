// A TABLE OPENED FULL SCREEN, FOR ANALYSIS (components/blocks/Analysis.tsx), used as a person uses it (jsdom, no browser):
// the expand button opens a modal over the whole window; search, column filters, sort and group-by work on the rows;
// Escape and the close button return to the step, focus going back; a row that opens something closes it first.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true, url: 'http://x/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, localStorage: dom.window.localStorage, getComputedStyle: dom.window.getComputedStyle })
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { BlockView, readBlock, analyse, columnValues, NO_ASK } = await import('../src/index.ts')
const { useChartTable } = await import('../src/components/blocks/ChartTable.tsx')

const cols = [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }, { key: 'value', label: 'Value', unit: 'money' }, { key: 'n', label: 'Count', unit: 'count' }]
const rows = [
  { name: 'Met coke', kind: 'Energy', value: 640, n: 3 },
  { name: 'Thermal coal', kind: 'Energy', value: 579, n: 2 },
  { name: 'Steel', kind: 'Metal', value: 391, n: 5 },
  { name: 'Copper', kind: 'Metal', value: 45, n: 1 },
  { name: 'Rubber', kind: 'Agri', value: 163, n: 4 },
]

test('the analysis, on the rows: search, a value list per text column with counts, a range per figure, sort both ways, groups with count and totals', () => {
  const names = (a: Partial<typeof NO_ASK>) => analyse(rows, cols, { ...NO_ASK, ...a }).rows.map((r) => r.name)
  assert.deepEqual(names({ q: 'co' }), ['Met coke', 'Thermal coal', 'Copper'], 'search: any column')
  assert.deepEqual(names({ values: { kind: ['Metal', 'Agri'] } }), ['Steel', 'Copper', 'Rubber'])
  assert.deepEqual(names({ ranges: { value: { min: 100, max: 600 } } }), ['Thermal coal', 'Steel', 'Rubber'])
  assert.deepEqual(names({ ranges: { value: { min: 400 } } }), ['Met coke', 'Thermal coal'], 'either end open')
  assert.deepEqual(names({ sort: { key: 'value', dir: 'asc' } }), ['Copper', 'Rubber', 'Steel', 'Thermal coal', 'Met coke'])
  assert.deepEqual(names({ sort: { key: 'name', dir: 'desc' } }), ['Thermal coal', 'Steel', 'Rubber', 'Met coke', 'Copper'])
  const g = analyse(rows, cols, { ...NO_ASK, groupBy: 'kind', sort: { key: 'value', dir: 'desc' } }).groups!
  assert.deepEqual(g.map((x) => [x.key, x.rows.length, x.totals.value, x.totals.n]), [['Energy', 2, 1219, 5], ['Metal', 2, 436, 6], ['Agri', 1, 163, 4]])
  assert.deepEqual(columnValues(rows, 'kind'), [{ value: 'Energy', count: 2 }, { value: 'Metal', count: 2 }, { value: 'Agri', count: 1 }])
})

test('expand opens the table full screen — a modal dialog over the whole window, focus in, the page held — and Escape returns to the step', async () => {
  const opened: unknown[] = []
  const root = createRoot(document.getElementById('root')!)
  const block = readBlock({ type: 'table', title: 'Commodities', says: 'Prices and our exposure', columns: cols, rows, rowMove: { dim: 'name', key: 'name', label: 'name' } })
  await act(async () => root.render(<div data-block="b1"><BlockView block={block} onRow={(_m, r) => opened.push(r.name)} /></div>))
  const expand = document.querySelector<HTMLButtonElement>('[aria-label="Open full screen"]')!
  expand.focus()
  await act(async () => { expand.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const dialog = document.querySelector('[role=dialog]')!
  assert.ok(dialog, 'open')
  assert.equal(dialog.getAttribute('aria-modal'), 'true')
  assert.ok(dialog.classList.contains('sa-fullscreen'), 'the full-viewport overlay')
  assert.equal(dialog.parentElement, document.body, 'drawn in the body, above the app')
  assert.equal(document.querySelector('.sa-fullscreen__title')?.textContent, 'Commodities')
  assert.equal(document.querySelector('.sa-fullscreen__note')?.textContent, 'Prices and our exposure')
  assert.equal(document.activeElement?.getAttribute('aria-label'), 'Close full screen', 'focus moves in')
  assert.equal(document.body.style.overflow, 'hidden', 'the page behind does not scroll')
  assert.ok(document.querySelector('#root .sa-part'), 'the step stays where it was')
  // its tools: search, group-by, columns, the count; a sort mark and a filter under every head
  assert.ok(dialog.querySelector('input[type=search]'))
  assert.match(dialog.querySelector('.sa-analysis__tools')!.textContent ?? '', /Group by.*Columns.*5 of 5 rows/)
  assert.equal(dialog.querySelectorAll('th.is-sortable').length, 4)
  assert.equal(dialog.querySelectorAll('.sa-analysis__range').length, 2, 'a range for each figure')
  assert.equal(dialog.querySelectorAll('.sa-analysis__filters [role=combobox]').length, 2, 'a value list for each text column')
  // sort by a head: the rows reorder
  await act(async () => { dialog.querySelectorAll('th.is-sortable')[2].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(dialog.querySelector('tbody tr td')?.textContent, 'Copper', 'ascending by value')
  // Escape: closed, the page back as it was, focus back on the expand button
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(document.querySelector('[role=dialog]'), null, 'Escape closes it')
  assert.equal(document.body.style.overflow, '')
  assert.equal(document.activeElement, expand, 'focus goes back')
  // a row that opens something: the overlay closes first, then it opens
  await act(async () => { expand.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { document.querySelector('[role=dialog] tbody tr')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(document.querySelector('[role=dialog]'), null)
  assert.deepEqual(opened, ['Met coke'])
  // the close button too
  await act(async () => { expand.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await act(async () => { document.querySelector('[aria-label="Close full screen"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.equal(document.querySelector('[role=dialog]'), null)
  await act(async () => root.unmount())
})

test("a chart's table view opens full screen the same way", async () => {
  const root = createRoot(document.getElementById('root')!)
  function Host() {
    const t = useChartTable('By plant', { axis: 'Plant', empty: 'none', columns: [{ key: 'n', label: 'SKUs', unit: 'count' }], rows: [{ label: 'Pune', values: { n: 3 } }, { label: 'Goa', values: { n: 1 } }] })
    return <>{t.tool}{t.body}</>
  }
  await act(async () => root.render(<Host />))
  await act(async () => { document.querySelector('[aria-label="Open full screen"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const dialog = document.querySelector('[role=dialog][aria-modal=true].sa-fullscreen')!
  assert.ok(dialog)
  assert.deepEqual([...dialog.querySelectorAll('tbody tr')].map((r) => r.textContent), ['Pune3', 'Goa1'])
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(document.querySelector('[role=dialog]'), null)
  await act(async () => root.unmount())
})
