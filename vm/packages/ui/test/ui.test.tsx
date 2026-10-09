import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { buildProgram, ProgramStore } from '@superatom/programs'
import { Intent, listIntents, listenIntents, loadProgramUI, Thread, pathOf, latestUnder, type ScreenIntent } from '../src/index.ts'

const dom = (html: string) => { const d = new JSDOM(`<main>${html}</main>`); return { doc: d.window.document, win: d.window } }

test('<Intent> writes its intent into the markup; every intent on screen can be listed', () => {
  const html = renderToStaticMarkup(<div>
    <Intent ops={[{ op: 'set', path: 'scope.branch', value: 'PUNE' }]}>Pune</Intent>
    <Intent as="li" action={{ package: 'trips', id: 'next' }} to="new" label="Next page" />
    <Intent call={{ package: 'trips', fn: 'run' }} disabled>Run</Intent>
  </div>)
  assert.match(html, /<button data-sa-intent="[^"]+" type="button">Pune<\/button>/)
  assert.match(html, /<li data-sa-intent="[^"]+" aria-label="Next page" role="button" tabindex="0">Next page<\/li>/)
  const { doc } = dom(html)
  assert.deepEqual(listIntents(doc).map((x) => [x.text, x.intent.to, x.disabled]), [['Pune', 'current', false], ['Next page', 'new', false], ['Run', 'current', true]])
  assert.deepEqual(listIntents(doc)[0].intent.ops, [{ op: 'set', path: 'scope.branch', value: 'PUNE' }])
})

test('a broken intent is shown as broken, never sent', () => {
  const html = renderToStaticMarkup(<Intent ops={[{ op: 'set', path: 'branch', value: 1 }]}>X</Intent>)
  assert.match(html, /role="alert">This control is broken: ops\[0\]\.path must be &lt;slice&gt;\.&lt;field&gt;/)
  assert.equal(listIntents(dom(html).doc).length, 0)
  assert.match(renderToStaticMarkup(<Intent>Y</Intent>), /an intent carries ops, an action or a call/)
})

test('one delegated listener sends a click or Enter on any control inside it; a disabled one is traced, not sent', () => {
  const html = renderToStaticMarkup(<div>
    <Intent ops={[{ op: 'set', path: 'trips.page', value: 2 }]}><span className="inner">two</span></Intent>
    <Intent as="div" action={{ package: 'trips', id: 'next' }} to="new">next</Intent>
    <Intent call={{ package: 'trips', fn: 'run' }} as="div" disabled>run</Intent>
  </div>)
  const { doc, win } = dom(html)
  const sent: ScreenIntent[] = [], traced: boolean[] = []
  const off = listenIntents(doc, (i) => sent.push(i), (t) => traced.push(t.sent))
  doc.querySelector('.inner')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  doc.querySelectorAll('[role=button]')[0].dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  doc.querySelectorAll('[role=button]')[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.deepEqual(sent.map((i) => i.ops?.[0]?.value ?? i.action?.id), [2, 'next'])
  assert.deepEqual(traced, [true, true, false])
  off()
  doc.querySelector('.inner')!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.equal(sent.length, 2)
})

test('a built program\'s React side loads with the platform\'s own React — its hooks work — and nothing else is let in', async () => {
  const fixture = fileURLToPath(new URL('../../programs/test/fixtures/unsettled-trips', import.meta.url))
  const d = mkdtempSync(join(tmpdir(), 'ui-')), src = join(d, 'src'); cpSync(fixture, src, { recursive: true })
  // an own file imported by the entry, to show relative imports load too
  writeFileSync(join(src, 'web', 'label.ts'), "export const label = (n: number) => `${n} unsettled trips`\n")
  writeFileSync(join(src, 'web', 'index.tsx'), "import { useState } from 'react'\nimport { label } from './label.js'\nexport function UnsettledTrips(props: { count: number }) { const [n] = useState(props.count); return <section>{label(n)}</section> }\n")
  const store = new ProgramStore(join(d, 'store'))
  const { dir } = buildProgram(src, store)
  const fetchText = async (url: string) => readFileSync(fileURLToPath(url), 'utf8')
  const entry = pathToFileURL(join(dir, 'web', 'index.js')).href
  const mod: any = await loadProgramUI(entry, { fetchText, platform: { react: React, 'react/jsx-runtime': jsxRuntime } })
  assert.equal(renderToStaticMarkup(React.createElement(mod.UnsettledTrips, { count: 365 })), '<section>365 unsettled trips</section>')
  await assert.rejects(loadProgramUI(entry, { fetchText, platform: { react: React } }), /imports "react\/jsx-runtime", which this screen does not supply/)
  writeFileSync(join(dir, 'web', 'index.js'), "import x from 'left-pad'\nexport const X = x\n")
  await assert.rejects(loadProgramUI(entry, { fetchText, platform: { react: React } }), /imports "left-pad": a program's React side may import only the platform's libraries/)
})

test('the thread shows the path to the current block, and where it branched lets a person move between branches', () => {
  const blocks = [{ id: 'b1', parent: null }, { id: 'b2', parent: 'b1' }, { id: 'b3', parent: 'b1' }, { id: 'b4', parent: 'b3' }].map((b) => ({ ...b, answer: null, stateHash: 'h' }))
  assert.deepEqual(pathOf(blocks, 'b4'), ['b1', 'b3', 'b4'])
  assert.equal(latestUnder(blocks, 'b1'), 'b4')
  const html = renderToStaticMarkup(<Thread session={{ blocks, leaf: 'b4' }} renderBlock={(id) => <p>{id}</p>} onGoTo={() => {}} />)
  const { doc } = dom(html)
  assert.deepEqual([...doc.querySelectorAll('li')].map((li) => li.getAttribute('data-block')), ['b1', 'b3', 'b4'])
  assert.equal(doc.querySelector('[data-block=b3] .sa-branches span')!.textContent, '2 of 2')
  assert.equal(doc.querySelector('[aria-current=true]')!.getAttribute('data-block'), 'b4')
})

test('where a move lands: looking at another view opens a new block; filtering, re-breaking or a window stays in place', async () => {
  const { destinationOf } = await import('../src/index.ts')
  assert.equal(destinationOf([{ op: 'push', dim: 'category', value: 'Raw Materials' }]), 'new')
  assert.equal(destinationOf([{ op: 'pop', dim: 'category' }, { op: 'by', dim: 'supplier' }]), 'new')
  assert.equal(destinationOf([{ op: 'window', window: { kind: 'fiscal', year: 'FY2025-26' } }]), 'new')
  assert.equal(destinationOf([{ op: 'focus', on: 'supplier' }, { op: 'push', dim: 'supplier', value: 'VEN-0090' }]), 'new')
  assert.equal(destinationOf([]), 'current')
})

test('a library several programs link is fetched once and is one module; an import of a library not linked is refused', async () => {
  const d = mkdtempSync(join(tmpdir(), 'ui-lib-'))
  const files: Record<string, string> = {
    'sa-program://lib/web/index.js': "export const shared = { n: 0 }\nexport const money = (v) => `Rs ${v}`\n",
    'sa-program://a/web/index.js': "import { shared, money } from '@lib/fmt'\nexport const A = shared\nexport const am = money(1)\n",
    'sa-program://b/web/index.js': "import { shared } from '@lib/fmt'\nexport const B = shared\n",
    'sa-program://c/web/index.js': "import { x } from '@lib/other'\nexport const C = x\n",
  }
  const fetched: string[] = []
  const fetchText = async (url: string) => { fetched.push(url); if (!(url in files)) throw new Error(`no ${url}`); return files[url] }
  const platform = { react: React }
  const lib = (name: string, file: string) => (name === 'fmt' ? `sa-program://lib/web/${file}` : null)
  const a: any = await loadProgramUI('sa-program://a/web/index.js', { fetchText, platform, lib })
  const b: any = await loadProgramUI('sa-program://b/web/index.js', { fetchText, platform, lib })
  assert.equal(a.am, 'Rs 1')
  assert.equal(a.A, b.B)                                                        // one module: the same object in both
  assert.equal(fetched.filter((u) => u === 'sa-program://lib/web/index.js').length, 1)
  await assert.rejects(loadProgramUI('sa-program://c/web/index.js', { fetchText, platform, lib }), /imports "@lib\/other", a library this program does not link/)
  void d
})

test('how a value is written: the platform\'s way, unless a library writes it its way, unless the program does', async () => {
  const { FormatsProvider, BlockView, formatsOf } = await import('../src/index.ts')
  const kpis = { type: 'kpis', items: [{ label: 'Spend', value: 25000000, unit: 'INR' }, { label: 'Coal', value: 16605, unit: 'MT' }] } as any
  const draw = (formats?: any, inner?: any) => renderToStaticMarkup(React.createElement(FormatsProvider, { formats }, inner ? React.createElement(FormatsProvider, { formats: inner }, React.createElement(BlockView, { block: kpis })) : React.createElement(BlockView, { block: kpis })))
  assert.match(draw(), /₹2\.5 Cr/)                                                   // the platform's
  const library = formatsOf({ formats: { INR: (v: unknown) => `Rs ${Number(v) / 1e7} crore`, MT: { full: (v: unknown) => `${v} tonnes` }, bad: 3 } })!
  assert.deepEqual(Object.keys(library), ['INR', 'MT'])                               // only writers are taken
  assert.match(draw(library), /Rs 2\.5 crore/); assert.match(draw(library), /16605 tonnes/)
  assert.match(draw(library, { INR: (v: unknown) => `INR ${v}` }), /INR 25000000/)    // the program's over the library's
  assert.match(draw(library, { INR: (v: unknown) => `INR ${v}` }), /16605 tonnes/)     // …only for what it writes itself
  assert.equal(formatsOf({}), null)
})
