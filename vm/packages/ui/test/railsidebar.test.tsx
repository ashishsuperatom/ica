// The two-level sidebar, used as a person uses it (jsdom, the real AppShell).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true, url: 'http://x/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, MouseEvent: dom.window.MouseEvent, localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true })
Object.defineProperty(dom.window, 'innerWidth', { value: 1440, configurable: true })

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { default: AppShell } = await import('../src/components/layout/AppShell.tsx')
const { default: RailSidebar } = await import('../src/components/layout/RailSidebar.tsx')

const places = [
  { key: 'home', label: 'Home', icon: 'x:home', panel: <p>conversations</p> },
  { key: 'agents', label: 'Agents', icon: 'x:agents', panel: <p>agents</p> },
  { key: 'connections', label: 'Connections', icon: 'x:c' },
]
const root = createRoot(document.getElementById('root')!)
const at = async (current: string) => act(async () => root.render(
  <AppShell sidebar={(collapsed, toggle) => <RailSidebar name="P" places={places} current={current} pinned={!collapsed} onPin={(p) => toggle(!p)} onMark={() => {}} onHome={() => {}} />}>
    <main>page</main>
  </AppShell>))
const $ = (s: string) => document.querySelector(s) as HTMLElement | null
const panel = () => $('.sa-railbar__panel')
const state = () => (!panel() ? 'closed' : panel()!.dataset.floating === 'true' ? 'floating' : 'pinned')
const shows = () => panel()?.textContent ?? ''
const place = (label: string) => $(`.sa-railbar__place[aria-label="${label}"]`)!
const click = async (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const point = async (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })) })
const leave = async () => act(async () => { $('.sa-railbar')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
const toggle = () => $('.sa-railbar__panel .sa-sidebar__head button[aria-pressed]')!

test('pinned: pointing at any place shows its panel (empty when it has nothing); leaving returns to the chosen one', async () => {
  await at('home')
  assert.equal(state(), 'pinned'); assert.match(shows(), /conversations/)
  await point(place('Agents')); assert.match(shows(), /agents/)
  await point(place('Connections')); assert.equal(state(), 'pinned'); assert.equal(panel()!.querySelectorAll('.sa-nav-item').length, 0)
  await leave(); assert.match(shows(), /conversations/)
})

test('unpinned: pointing shows it floating, leaving hides it; a click on any place pins it there — every time', async () => {
  await click(toggle()); await leave(); assert.equal(state(), 'closed')
  for (let i = 0; i < 3; i++) for (const label of ['Home', 'Agents', 'Connections']) {
    await point(place(label)); assert.equal(state(), 'floating', `point ${label}`)
    await leave(); assert.equal(state(), 'closed', `leave ${label}`)
    await point(place(label)); await click(place(label)); assert.equal(state(), 'pinned', `click ${label}`)
    await click(place(label)); assert.equal(state(), 'pinned', `second click ${label}`)
    await leave(); assert.equal(state(), 'pinned', `${label} stays`); assert.match(shows(), label === 'Home' ? /conversations/ : label === 'Agents' ? /agents/ : /Connections/)
    await point(place(label)); await click(toggle()); await leave(); assert.equal(state(), 'closed', `unpin ${label}`)
  }
})

test('a rail click made on one visit never comes back: on Agents, click Home (and go there), later come back to Agents — the panel shows Agents', async () => {
  await at('agents'); await point(place('Agents')); await click(place('Agents')); await leave()
  assert.equal(state(), 'pinned'); assert.match(shows(), /agents/)
  await click(place('Home')); await at('home'); await leave()       // the Home place is a page: the click goes there
  assert.match(shows(), /conversations/)
  await at('agents'); await leave()                                  // back on Agents, from a link in the panel
  assert.match(shows(), /agents/, 'the panel is where the person is, not where an old click was')
  await click(toggle()); await leave(); assert.equal(state(), 'closed')   // as the next test expects it
})

test('the toggle on a floating panel pins it', async () => {
  await point(place('Agents')); await click(toggle()); await leave()
  assert.equal(state(), 'pinned'); assert.match(shows(), /agents/, 'pinned on the place it showed')
  await act(async () => root.unmount())
})
