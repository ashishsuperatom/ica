// The development environment card, used as a person uses it (jsdom): opened, it stops or deletes the environment —
// delete asks once more first — and says plainly what went wrong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://x/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { default: ConnectionStatus } = await import('../src/components/layout/ConnectionStatus.tsx')

const root = createRoot(document.getElementById('root')!)
const dev = { id: 'dv_1', name: 'no-fixed-moves', names: ['program explore'] }
const buttons = () => [...document.querySelectorAll('.sa-devenv__actions button')].map((b) => b.textContent)
const press = async (label: string) => act(async () => { [...document.querySelectorAll('button')].find((b) => b.textContent === label)!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

test('opened, the card stops the environment or — asked once more — deletes it; a refusal is said in the card', async () => {
  const done: string[] = []
  let refuse = ''
  await act(async () => root.render(<ConnectionStatus status="open" dev={dev}
    onStop={async () => { done.push('stop'); return refuse || undefined }} onDelete={async () => { done.push('delete') }} />))
  assert.equal(buttons().length, 0)                                       // closed: only the line
  await act(async () => { document.querySelector('.sa-devenv__head')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(buttons(), ['Stop', 'Delete…'])
  await press('Stop')
  assert.deepEqual(done, ['stop'])
  await press('Delete…')
  assert.deepEqual(done, ['stop'])                                        // not yet: it asks first
  assert.deepEqual(buttons(), ['Stop', 'Delete no-fixed-moves and its builds', 'Keep it'])
  await press('Keep it')
  assert.deepEqual(buttons(), ['Stop', 'Delete…'])
  await press('Delete…'); await press('Delete no-fixed-moves and its builds')
  assert.deepEqual(done, ['stop', 'delete'])
  refuse = 'there is no environment dv_1'
  await press('Stop')
  assert.equal(document.querySelector('.sa-devenv [role=alert]')?.textContent, 'there is no environment dv_1')
  // without the handlers (an older page), the card only says how, from sacli
  await act(async () => root.render(<ConnectionStatus status="open" dev={dev} />))
  assert.equal(document.querySelectorAll('.sa-devenv__actions').length, 0)
  assert.match(document.querySelector('.sa-devenv__hint')!.textContent!, /sacli dev stop/)
})
