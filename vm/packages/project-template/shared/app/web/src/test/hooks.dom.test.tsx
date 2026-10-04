// @vitest-environment jsdom
// A block position that changes type between two answers must not change a component's hook count (React #311).
// A real root, two renders in sequence: a table (3 hooks) then bars (4) at the same position, then a cached answer
// replaced by a fresh one with different blocks. renderToString cannot catch this; only a live root re-render can.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Blocks } from '@superatom/ui'
import { readAnswer, readBlock } from '@/lib/wire'

const MOCK = join(__dirname, '../../public/mock')
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
const errors: unknown[] = []
beforeAll(() => {
  // ECharts needs a canvas; jsdom has none — a chart host with zero size is enough for hooks to run.
  HTMLCanvasElement.prototype.getContext = (() => null) as never
})
afterEach(() => { act(() => root?.unmount()); host?.remove() })
const mount = (el: React.ReactElement) => {
  host = document.createElement('div'); document.body.appendChild(host)
  root = createRoot(host, { onUncaughtError: (e) => errors.push(e), onRecoverableError: () => {} })
  act(() => root.render(el))
}

describe('hook counts across changing blocks (real root)', () => {
  it('a table then bars at the same position renders without throwing', () => {
    const table = readBlock({ type: 'table', title: 't', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] })
    const bars = readBlock({ type: 'bars', title: 'b', axis: 'x', unit: 'h', series: [{ key: 'v', label: 'V' }], rows: [{ label: 'r', values: { v: 1 } }] })
    const text = readBlock({ type: 'text', title: 'x', text: 'y' })
    mount(<Blocks blocks={[table, text]} />)
    act(() => root.render(<Blocks blocks={[bars, text]} />))
    act(() => root.render(<Blocks blocks={[text]} />))
    act(() => root.render(<Blocks blocks={[bars, table, text]} />))
    expect(errors).toEqual([])
    expect(host.querySelectorAll('section.sa-card').length).toBe(3)
  })
  it('a cached answer replaced by a fresh one with a different block list renders without throwing', () => {
    // The recorded answers with the most and the fewest blocks: two different block lists.
    const recorded = readdirSync(MOCK).filter((f) => f.endsWith('.json') && f !== 'catalog.json' && f !== 'about.json')
      .map((f) => readAnswer(JSON.parse(readFileSync(join(MOCK, f), 'utf8')))).sort((a, b) => b.blocks.length - a.blocks.length)
    const cached = recorded[0], fresh = recorded[recorded.length - 1]
    expect(cached.blocks.length).toBeGreaterThan(fresh.blocks.length)
    mount(<Blocks blocks={cached.blocks} />)
    act(() => root.render(<Blocks blocks={fresh.blocks} />))
    act(() => root.render(<Blocks blocks={cached.blocks} />))
    expect(errors).toEqual([])
  })
})
