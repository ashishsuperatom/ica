// The two-level sidebar, clicked as a person clicks it (jsdom, the real AppShell): a click on a rail place pins its
// panel and it stays pinned however often it is clicked; resting only shows it; the head's toggle unpins and pins.
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
]
const root = createRoot(document.getElementById('root')!)
await act(async () => root.render(
  <AppShell sidebar={(collapsed, toggle) => <RailSidebar name="P" places={places} current="home" pinned={!collapsed} onPin={(p) => toggle(!p)} onMark={() => {}} onHome={() => {}} />}>
    <main>page</main>
  </AppShell>))
const $ = (s: string) => document.querySelector(s) as HTMLElement | null
const panel = () => $('.sa-railbar__panel')
const state = () => (!panel() ? 'closed' : panel()!.dataset.floating === 'true' ? 'floating' : 'pinned')
const place = (label: string) => $(`.sa-railbar__place[aria-label="${label}"]`)!
const click = async (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const hover = async (el: HTMLElement) => act(async () => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })) })
const toggleBtn = () => $('.sa-railbar__panel .sa-sidebar__head button[aria-pressed]')!

test('starts pinned (nothing remembered)', () => assert.equal(state(), 'pinned'))

test('the head toggle unpins; resting on a place shows it floating; clicking the place pins it — every time', async () => {
  await click(toggleBtn())
  assert.equal(state(), 'closed')
  for (let i = 0; i < 5; i++) {
    await hover(place('Home'))
    assert.equal(state(), 'floating', `rest ${i}`)
    await click(place('Home'))
    assert.equal(state(), 'pinned', `click ${i}`)
    await click(place('Home'))
    assert.equal(state(), 'pinned', `second click ${i} keeps it`)
    await click(toggleBtn())
    assert.equal(state(), 'closed', `unpin ${i}`)
  }
})

test('the head toggle on a floating panel pins it — every time', async () => {
  for (let i = 0; i < 5; i++) {
    await hover(place('Agents'))
    assert.equal(state(), 'floating')
    await click(toggleBtn())
    assert.equal(state(), 'pinned', `pin ${i}`)
    assert.equal(toggleBtn().getAttribute('aria-pressed'), 'true')
    await click(toggleBtn())
    assert.equal(state(), 'closed', `unpin ${i}`)
  }
})

const leaveAll = async () => act(async () => { $('.sa-railbar')!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); await new Promise((r) => setTimeout(r, 300)) })
const at = async (current: string) => act(async () => root.render(
  <AppShell sidebar={(collapsed, toggle) => <RailSidebar name="P" places={[...places, { key: 'connections', label: 'Connections', icon: 'x:c' }]} current={current} pinned={!collapsed} onPin={(p) => toggle(!p)} onMark={() => {}} onHome={() => {}} />}>
    <main>page</main>
  </AppShell>))

test('pinned, the panel stays when the pointer leaves', async () => {
  await hover(place('Home')); await click(place('Home'))
  await leaveAll()
  assert.equal(state(), 'pinned')
})

test('pinned on a page whose place has no panel (about, connections), the panel stays — the last one shown', async () => {
  for (const current of ['about', 'connections', '']) {
    await at(current)
    await hover(place('Agents')); await leaveAll()
    assert.equal(state(), 'pinned', `on ${current || 'a page of no place'}`)
    assert.ok(panel()!.textContent?.trim(), 'the panel has something in it')
  }
})

test('every place shows a panel on rest and pins on a click — a place without pages shows itself', async () => {
  await at('home')
  await click(toggleBtn()); assert.equal(state(), 'closed')
  for (const label of ['Home', 'Agents', 'Connections']) {
    await hover(place(label)); assert.equal(state(), 'floating', `rest on ${label}`)
    await click(place(label)); assert.equal(state(), 'pinned', `click on ${label}`)
    await leaveAll(); assert.equal(state(), 'pinned', `${label} stays`)
    assert.ok(panel()!.textContent?.includes(label === 'Home' ? 'conversations' : label === 'Agents' ? 'agents' : 'Connections'))
    await click(toggleBtn()); assert.equal(state(), 'closed')
  }
  await act(async () => root.unmount())
})
