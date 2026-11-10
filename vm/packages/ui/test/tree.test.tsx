// A plain tree (components/semantic/Tree.tsx), used as a person uses it (jsdom): a row clicked is chosen and opens or
// closes; what is under a row is asked for only when it is opened; a graph that loops never unfolds by itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://x/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MouseEvent: dom.window.MouseEvent })

const React = await import('react')
const { act, useState } = React
const { createRoot } = await import('react-dom/client')
const { Tree } = await import('../src/components/semantic/Tree.tsx')

// a loop: a → b → a
const next: Record<string, string[]> = { a: ['b'], b: ['a'], c: [] }
const asked: string[] = []
const row = (k: string, path: string[] = []) => ({ key: k, title: `intent ${k}`, end: '1 answer', open: next[k].length > 0, again: path.includes(k) })
function Host() {
  const [sel, setSel] = useState<string | null>(null)
  return <Tree rows={['a', 'c'].map((k) => row(k))} under={(k, path) => { asked.push(k); return next[k].map((x) => row(x, path)) }} selected={sel} onSelect={(k) => setSel(k)} />
}

test('a row clicked is chosen and opens; again, it closes; numbered by place; a loop shown once, never opened again', async () => {
  const root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<Host />))
  const rows = () => [...document.querySelectorAll('.sa-tree__row')].map((b) => [...b.children].map((x) => x.textContent).filter(Boolean).join(' '))
  const click = async (i: number) => act(async () => { document.querySelectorAll('.sa-tree__row')[i].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(rows(), ['[+] 01. intent a 1 answer', '[ ] 02. intent c 1 answer'])
  assert.deepEqual(asked, [])                                                   // nothing under a row asked for until it opens
  await click(0)
  assert.deepEqual(rows(), ['[-] 01. intent a 1 answer', '[+] 01.1. intent b 1 answer', '[ ] 02. intent c 1 answer'])
  assert.equal(document.querySelector('[data-selected]')!.textContent!.includes('intent a'), true)
  await click(1)
  assert.deepEqual(rows()[2], '[ ] 01.1.1. intent a (above) 1 answer')         // the loop: shown, not opened again
  await click(0)
  assert.deepEqual(rows(), ['[+] 01. intent a 1 answer', '[ ] 02. intent c 1 answer'])   // closed
  await act(async () => root.unmount())
})

test('as deep as it goes: only the last levels are drawn; the parents above fold into one line, each a way back up', async () => {
  const chain: Record<string, string[]> = { r: ['s'], s: ['t'], t: ['u'], u: ['v'], v: [] }
  const row2 = (k: string) => ({ key: k, title: k, open: chain[k].length > 0 })
  const root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<Tree rows={[row2('r'), { key: 'z', title: 'z' }]} under={(k) => chain[k].map(row2)} depth={2} />))
  const rows = () => [...document.querySelectorAll('.sa-tree__row .sa-tree__title')].map((x) => x.textContent)
  const above = () => document.querySelector('.sa-tree__above')?.textContent?.replace(/\s+/g, '') ?? ''
  const click = async (sel: string, text: string) => act(async () => { [...document.querySelectorAll(sel)].find((b) => b.textContent!.includes(text))!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await click('.sa-tree__row', 'r'); await click('.sa-tree__row', 's')
  assert.deepEqual(rows(), ['01. r', '01.1. s', '01.1.1. t', '02. z'])          // two levels down: nothing folded yet
  await click('.sa-tree__row', 't')
  assert.equal(above(), '[^]01.r')                                            // three down: r folds away
  assert.deepEqual(rows(), ['01.1. s', '01.1.1. t', '01.1.1.1. u'])             // its siblings with it; numbers kept
  await click('.sa-tree__row', 'u')
  assert.equal(above(), '[^]01.r›01.1.s')
  await click('.sa-tree__up', '01. r')                                          // back up to r
  assert.equal(above(), ''); assert.deepEqual(rows().slice(0, 2), ['01. r', '01.1. s'])
  await act(async () => root.unmount())
})
