// A flow of blocks drawn in one place (components/frame/LocalThread.tsx · InlineThread), used as a person uses it (jsdom):
// each block opened takes the place of the one before; Back returns, never past where it may; the page's address and
// history are not touched.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://x/page' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MouseEvent: dom.window.MouseEvent })

const React = await import('react')
const { act, useEffect } = React
const { createRoot } = await import('react-dom/client')
const { InlineThread, useThread } = await import('../src/components/frame/LocalThread.tsx')

// a first block that moves on by itself (as Connect does, opened on one connector), then two steps
function Start() { const { open } = useThread(); useEffect(() => { open('one', { n: 1 }) }, []); return <p>picking</p> }   // eslint-disable-line react-hooks/exhaustive-deps
function Step() { const { open, props, update } = useThread(); return <div><p>step {String(props.n)}{props.seen ? ' seen' : ''}</p>
  <button id="next" onClick={() => open('two', { n: Number(props.n) + 1 })}>next</button><button id="look" onClick={() => update({ seen: true })}>look</button></div> }
const blocks = { start: { label: 'Start', render: () => <Start /> }, one: { label: 'One', title: (p: any) => `Step ${p.n}`, render: () => <Step /> }, two: { label: 'Two', render: () => <Step /> } }

test('each block takes the place of the one before; Back returns, never to a first block that moves on by itself; the page\'s history untouched', async () => {
  const root = createRoot(document.getElementById('root')!)
  const historyWas = window.history.length
  await act(async () => root.render(<InlineThread blocks={blocks} start={{ type: 'start' }} back={2} />))
  const text = () => document.getElementById('root')!.textContent ?? ''
  const back = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Back')
  const click = async (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.match(text(), /Step 1/); assert.match(text(), /step 1/); assert.doesNotMatch(text(), /picking/)
  assert.equal(back(), undefined)                                   // the first block moved on by itself: not returned to
  await click(document.getElementById('look')!); assert.match(text(), /step 1 seen/)   // changed in place
  await click(document.getElementById('next')!); assert.match(text(), /step 2/); assert.doesNotMatch(text(), /step 1/)
  await click(back()!); assert.match(text(), /step 1 seen/)        // back where it was, as it was
  assert.equal(window.history.length, historyWas); assert.equal(window.location.pathname, '/page')
  await act(async () => root.unmount())
})
