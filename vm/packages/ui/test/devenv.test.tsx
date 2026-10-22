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

test('opened, the card stops or deletes the environment — each asked once more first, so a stray click does nothing; a refusal is said in the card', async () => {
  const done: string[] = []
  let refuse = ''
  await act(async () => root.render(<ConnectionStatus status="open" dev={dev}
    onStop={async () => { done.push('stop'); return refuse || undefined }} onDelete={async () => { done.push('delete') }} />))
  assert.equal(buttons().length, 0)                                       // closed: only the line
  // the connection is still said: its dot stands beside the environment's, never replaced by it
  assert.ok(document.querySelector('.sa-statusbar > .sa-status[aria-label="Connected"]'))
  assert.ok(document.querySelector('.sa-statusbar > .sa-devenv > .sa-devenv__dot'))
  assert.equal(document.querySelector('.sa-devenv__line')!.textContent, 'Differs from what everyone sees: explore')
  await act(async () => { document.querySelector('.sa-devenv__dot')!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  assert.deepEqual(buttons(), ['Stop…', 'Delete…'])
  await press('Stop…')
  assert.deepEqual(done, [])                                              // not yet: it asks first
  assert.deepEqual(buttons(), ['Stop no-fixed-moves — kept to resume', 'Keep working in it'])
  await press('Keep working in it')
  assert.deepEqual(buttons(), ['Stop…', 'Delete…'])
  await press('Stop…'); await press('Stop no-fixed-moves — kept to resume')
  assert.deepEqual(done, ['stop'])
  await press('Delete…')
  assert.deepEqual(done, ['stop'])                                        // asks first too
  assert.deepEqual(buttons(), ['Delete no-fixed-moves and its builds', 'Keep it'])
  await press('Keep it')
  await press('Delete…'); await press('Delete no-fixed-moves and its builds')
  assert.deepEqual(done, ['stop', 'delete'])
  refuse = 'there is no environment dv_1'
  await press('Stop…'); await press('Stop no-fixed-moves — kept to resume')
  assert.equal(document.querySelector('.sa-devenv [role=alert]')?.textContent, 'there is no environment dv_1')
  // nothing of theirs differs from what is published: said so — never a list of what was merely rebuilt
  await act(async () => root.render(<ConnectionStatus status="open" dev={{ ...dev, names: [], via: 'sacli on forge', attachedAt: '2026-10-23T04:17:00Z', lastUsed: '2026-10-23T04:21:00Z' }} />))
  const lines = [...document.querySelectorAll('.sa-devenv__line')].map((l) => l.textContent)
  assert.equal(lines[0], 'Nothing differs from what everyone sees yet')
  assert.match(lines[1]!, /^Since .+ · from sacli on forge · rebuilt .+$/)        // never blank: its story
  await act(async () => root.render(<ConnectionStatus status="open" dev={{ ...dev, names: ['program explore', 'agent buyer', 'map'] }} />))
  assert.equal(document.querySelector('.sa-devenv__line')!.textContent, 'Differs from what everyone sees: explore, agent buyer, the map')
  // without the handlers (an older page), the card only says how, from sacli
  await act(async () => root.render(<ConnectionStatus status="open" dev={dev} />))
  assert.equal(document.querySelectorAll('.sa-devenv__actions').length, 0)
  assert.match(document.querySelector('.sa-devenv__hint')!.textContent!, /sacli dev stop/)
})
