// Every recorded answer under public/mock renders through the block renderers without throwing, and every block
// type in the vocabulary is covered by at least one fixture. Also: the readers survive garbage.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Blocks } from '@/components/blocks'
import About from '@/components/block/About'
import { readAnswer, readBlock, readCatalog, readReply, type Block } from '@/lib/wire'
import { Draft, sameValue } from '@/lib/draft'
import { memberOptions, pushFor } from '@/components/block/FilterAdd'
import { readFilter, sameMember } from '@/lib/wire'
import { AnswerCache, LRU, reconcile } from '@/lib/cache'
import { Pending } from '@/lib/pending'
import { timeoutFor } from '@/lib/client'
import { isControlFrame } from '@/lib/wire'
import { vi } from 'vitest'
import SaidBlock from '@/components/blocks/SaidBlock'
import { readSaid } from '@/lib/wire'
import { isPart, receiver, sender } from '@superatom/transport'
import { ringAllowed } from '@/components/blocks/Bars'
import Donut from '@/components/ui/Donut'
import StackedBars from '@/components/ui/StackedBars'
import AboutBlock from '@/components/blocks/AboutBlock'
import { AppProvider } from '@/lib/catalog'
import { MockClient } from '@/lib/client'
import { readAbout } from '@/lib/wire'

const MOCK = join(__dirname, '../../public/mock')
const files = readdirSync(MOCK).filter((f) => f.endsWith('.json') && f !== 'catalog.json' && f !== 'about.json')
// The block types every dashboard draws; the others render wherever a recording has them, and in the malformed-input
// test below.
const ALL: Block['type'][] = ['kpis', 'bars', 'table']

describe('fixtures render', () => {
  const seen = new Set<string>()
  for (const f of files) {
    it(f, () => {
      const raw = JSON.parse(readFileSync(join(MOCK, f), 'utf8'))
      const reply = readReply(raw)
      expect(reply?.t).toBe('app:answer')
      if (reply?.t !== 'app:answer') return
      const a = reply.answer
      expect(a.blocks.length).toBeGreaterThan(0)
      for (const b of a.blocks) seen.add(b.type)
      const html = renderToString(<><Blocks blocks={a.blocks} /><About answer={a} /></>)
      expect(html.length).toBeGreaterThan(100)
      expect(html).not.toContain('[object Object]')
      expect(html).not.toContain('undefined')
      expect(html).not.toContain('NaN')
      // Every lens variant a block can be asked for draws too.
      const lensed = a.blocks.map((b) => (b.type === 'bars' || b.type === 'grid' ? { ...b, lens: 'table' } : b))
      expect(renderToString(<Blocks blocks={lensed} />).length).toBeGreaterThan(100)
    })
  }
  it('covers every block type', () => {
    for (const t of ALL) expect(seen.has(t), `no fixture has a "${t}" block`).toBe(true)
  })
})

/** The first bars block among the recorded answers that meets `test`. */
function firstBars(test: (b: Extract<Block, { type: 'bars' }>) => boolean) {
  for (const f of files) {
    const reply = readReply(JSON.parse(readFileSync(join(MOCK, f), 'utf8')))
    if (reply?.t !== 'app:answer') continue
    const b = reply.answer.blocks.find((x): x is Extract<Block, { type: 'bars' }> => x.type === 'bars' && test(x))
    if (b) return b
  }
}

describe('charts (ECharts ports)', () => {
  it('bars the server marks whole render donut + bars side by side', () => {
    const rag = firstBars((b) => !!b.whole)
    expect(rag, 'some recorded answer has bars that are a whole').toBeDefined()
    if (!rag) return
    expect(ringAllowed(rag)).toBe(true)
    const html = renderToString(<Blocks blocks={[rag]} />)
    expect(html).toContain('sa-chart-pair')
    expect((html.match(/echarts-for-react/g) ?? []).length).toBe(2)
  })
  it('Donut says so when there is nothing to divide', () => {
    expect(renderToString(<Donut slices={[{ name: 'a', value: 0 }]} format={String} />)).toContain('Nothing to divide')
  })
  it('StackedBars draws a chart host for rows with values', () => {
    expect(renderToString(<StackedBars rows={[{ label: 'x', v: 3 }]} labelKey="label" series={[{ key: 'v', label: 'V', color: 'var(--stock)' }]} format={String} />)).toContain('echarts-for-react')
  })
  it('stays bars-only when the rows are not a whole or the flag is missing', () => {
    const b = firstBars((x) => !x.whole)
    expect(b, 'some recorded answer has bars that are not a whole').toBeDefined()
    expect(b && ringAllowed(b)).toBe(false)
    const bare = readBlock({ type: 'bars', title: 't', axis: 'rag', series: [{ key: 'v', label: 'V' }], rows: [{ label: 'Red', values: { v: 1 } }], unit: 'projects' })
    expect(bare.type === 'bars' && ringAllowed(bare)).toBe(false)
    const flagged = readBlock({ type: 'bars', title: 't', axis: 'rag', whole: 'yes', series: [{ key: 'v', label: 'V' }], rows: [], unit: 'projects' })
    expect(flagged.type === 'bars' && flagged.whole).toBeUndefined()
  })
  it('Donut lays its legend out by the size of the set', () => {
    const slices = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Item ${i + 1}`, value: n - i }))
    const small = renderToString(<Donut slices={slices(3)} format={String} />)
    const medium = renderToString(<Donut slices={slices(11)} format={String} />)
    const large = renderToString(<Donut slices={slices(20)} format={String} />)
    expect(small).toContain('data-legend="row"')
    expect(medium).toContain('data-legend="column"')
    // a legend item names first, values second (full and short forms, the whole in title)
    expect(medium).toContain('sa-ring__value--full')
    expect(medium).toContain('sa-ring__value--short')
    expect(medium).toMatch(/title="Item 1 · 11 · 17%/)
    expect(large).toContain('data-legend="scroll"')
    // the medium and large layouts grow the chart host with the rows
    const h = (html: string) => Number(/height:\s*(\d+)px/.exec(html)?.[1] ?? 0)
    expect(h(medium)).toBeGreaterThan(h(small))
    expect(h(large)).toBeGreaterThanOrEqual(h(medium))
  })
  it('StackedBars with many series wraps its legend', () => {
    const series = Array.from({ length: 9 }, (_, i) => ({ key: `s${i}`, label: `Series ${i}`, color: 'var(--series-1)' }))
    const html = renderToString(<StackedBars rows={[{ label: 'x', s0: 1 }]} labelKey="label" series={series} format={String} />)
    expect(html).toContain('sa-chart-legend--wrap')
  })
})

describe('about', () => {
  it('renders the sources block from the fixture', () => {
    const raw = JSON.parse(readFileSync(join(MOCK, 'about.json'), 'utf8'))
    const reply = readReply(raw)
    expect(reply?.t).toBe('app:about')
    const about = readAbout(raw)
    expect(about.programs.length).toBeGreaterThan(0)
    expect(about.settings.length).toBeGreaterThan(0)
    const catalog = readCatalog(JSON.parse(readFileSync(join(MOCK, 'catalog.json'), 'utf8')))
    const html = renderToString(<AppProvider value={{ catalog, client: new MockClient() }}><AboutBlock about={about} /></AppProvider>)
    expect(html).toContain(about.sources[0].id)
    expect(html).toContain(about.programs[0].program)
    expect(html).toContain(about.settings[0].name)
  })
  it('survives garbage', () => {
    const a = readAbout({ sources: 'x', programs: [{}, 5], settings: 'y' })
    expect(a.sources).toEqual([])
    expect(a.programs).toEqual([])
    expect(a.settings).toEqual([])
  })
})

describe('readers survive garbage', () => {
  it('catalog', () => {
    const c = readCatalog({ capabilities: [{ focus: 'x' }, {}, 5], dimensions: 'no', windows: null })
    expect(c.capabilities).toHaveLength(1)
    expect(c.capabilities[0].lenses).toEqual(['table'])
    expect(c.dimensions).toEqual([])
  })
  it('answer with broken blocks', () => {
    const a = readAnswer({ blocks: [{ type: 'kpis' }, { type: 'bars', rows: [{}, null, { values: 'x' }] }, { type: 'grid', rows: [{ cells: [{}] }] }, { type: 'table', columns: [{}], rows: [1, {}] }, { type: 'facts' }, { type: 'text' }, { type: 'figure' }, { type: 'mystery' }, 'junk'], next: [{ ops: [{ op: 'nope' }] }] })
    expect(a.blocks).toHaveLength(9)
    expect(a.next).toEqual([])
    const html = renderToString(<><Blocks blocks={a.blocks} /><About answer={a} /></>)
    expect(html).toContain('cannot draw')
  })
  it('real catalog fixture', () => {
    const c = readCatalog(JSON.parse(readFileSync(join(MOCK, 'catalog.json'), 'utf8')))
    expect(c.capabilities.filter((x) => x.root).length).toBeGreaterThanOrEqual(3)
    expect(c.dimensions.length).toBeGreaterThan(5)
  })
})

describe('commit on close (lib/draft)', () => {
  it('toggling a value and toggling it back sends nothing', () => {
    const sent: string[][] = []
    const d = new Draft<string[]>(['2026-09', '2026-10'], (v) => sent.push(v))
    d.start()
    d.set(['2026-09'])
    expect(d.dirty).toBe(true)
    expect(d.value).toEqual(['2026-09']) // the draft is shown honestly while open
    d.set(['2026-10', '2026-09']) // back, in another order
    expect(d.dirty).toBe(false)
    d.close()
    expect(sent).toEqual([])
  })
  it('changing and closing sends exactly one move with the whole change', () => {
    const sent: string[][] = []
    const d = new Draft<string[]>(['2026-09', '2026-10'], (v) => sent.push(v))
    d.start()
    d.set(['2026-09'])
    d.set([])
    d.set(['2026-11'])
    d.set(['2026-11', '2026-12'])
    expect(sent).toEqual([]) // nothing while open
    d.close()
    expect(sent).toEqual([['2026-11', '2026-12']])
    d.close() // closing again does nothing
    expect(sent).toHaveLength(1)
  })
  it('a closed control follows the question; cancel drops the draft', () => {
    const sent: string[][] = []
    const d = new Draft<string[]>(['a'], (v) => sent.push(v))
    d.follow(['b'])
    expect(d.value).toEqual(['b'])
    d.start(); d.set(['c']); d.cancel()
    expect(d.value).toEqual(['b'])
    expect(sent).toEqual([])
    expect(sameValue({ x: [2, 1] }, { x: [1, 2] })).toBe(true)
  })
})

describe('a filter option is a label', () => {
  it('one label under three keys is ONE option, and pushing it sends the three keys', () => {
    const reply = readReply({ t: 'app:members', dim: 'project-status', matches: [
      { key: ['s3', 's1', 's2'], keys: ['s3', 's1', 's2'], label: 'Closed', recorded: 3 },
      { key: 's9', keys: ['s9'], label: 'In Progress' },
      { key: 'junk' }, 7,
    ] })
    expect(reply?.t).toBe('app:members')
    if (reply?.t !== 'app:members') return
    expect(reply.matches).toHaveLength(3)
    const options = memberOptions(reply.matches)
    expect(options.filter((o) => o.label === 'Closed')).toHaveLength(1)
    const closed = options.find((o) => o.label === 'Closed')!
    expect(closed.note).toBe('recorded 3 times')
    expect(pushFor('project-status', closed.member, false)).toEqual({ op: 'push', dim: 'project-status', value: ['s1', 's2', 's3'], label: 'Closed' })
    expect(pushFor('project-status', options.find((o) => o.label === 'In Progress')!.member, true)).toEqual({ op: 'push', dim: 'project-status', value: 's9', label: 'In Progress', not: true })
  })
  it('filters normalise their value and compare by keys, and a chip reads the label', () => {
    expect(readFilter({ dim: 'x', value: ['b', 'a', 'b'] })?.value).toEqual(['a', 'b'])
    expect(readFilter({ dim: 'x', value: ['a'] })?.value).toBe('a')
    expect(readFilter({ dim: 'x', value: [] })).toBeNull()
    expect(sameMember(['b', 'a'], ['a', 'b'])).toBe(true)
    expect(sameMember('a', ['a'])).toBe(true)
  })
})

describe('transport (@superatom/transport, shared with the engine): the client only sees whole messages', () => {
  const big = { t: 'app:answer', reqId: 'r1', focus: 'x', blocks: [{ type: 'text', title: 't', text: 'hello '.repeat(200) }] }
  it('a big request goes out as parts and a reply in parts arrives whole, in any order', async () => {
    const wire: unknown[] = []
    const out = sender({ send: (f) => wire.push(f), limit: 400, partBytes: 300 })
    expect(await out.send({ t: 'app:catalog', reqId: 'r0' })).toBe('whole')
    expect(await out.send(big)).toBe('parts')
    const parts = wire.filter(isPart)
    expect(parts.length).toBeGreaterThan(3)
    expect(parts.every((p) => p.id === 'r1' && p.of === parts.length)).toBe(true)
    const got: unknown[] = []
    const inn = receiver({ deliver: (m) => got.push(m) })
    for (const f of [...wire].reverse()) await inn.receive(f)
    expect(got).toEqual([big, { t: 'app:catalog', reqId: 'r0' }])
    expect(inn.pending()).toBe(0)
  })
  it('a missing part keeps the reply pending; reset forgets it', async () => {
    const wire: unknown[] = []
    await sender({ send: (f) => wire.push(f), limit: 400, partBytes: 300 }).send(big)
    const got: unknown[] = []
    const inn = receiver({ deliver: (m) => got.push(m) })
    for (const f of wire.slice(1)) await inn.receive(f)
    expect(got).toEqual([]); expect(inn.pending()).toBe(1)
    inn.reset(); expect(inn.pending()).toBe(0)
  })
  it('a parcel pointer that cannot be fetched is delivered marked with parcelError', async () => {
    const got: { parcelError?: unknown }[] = []
    const inn = receiver({ deliver: (m) => got.push(m), parcels: { get: async () => { throw new Error('no route') } } })
    await inn.receive({ t: 'app:answer', reqId: 'r9', id: 'r9', parcel: { hash: 'h', bytes: 1, ticket: 'tk' } })
    expect(got[0]?.parcelError).toBe('no route')
  })
})

describe('show what you have, ask anyway (lib/cache)', () => {
  const answerFor = (n: number) => readAnswer({ question: { focus: `f${n}`, where: [] }, focus: `f${n}`, label: `L${n}`, title: `T${n}`, blocks: [], ms: n })
  it('evicts the least recently used at 40', () => {
    const c = new AnswerCache(40)
    for (let i = 0; i < 40; i++) c.remember({ t: 'app:ask', question: { focus: `f${i}`, where: [] } }, answerFor(i))
    expect(c.size).toBe(40)
    c.lookup({ t: 'app:ask', question: { focus: 'f0', where: [] } }) // touch the oldest: it is now the most recent
    c.remember({ t: 'app:ask', question: { focus: 'f40', where: [] } }, answerFor(40))
    expect(c.size).toBe(40)
    expect(c.lookup({ t: 'app:ask', question: { focus: 'f0', where: [] } })).toBeDefined()
    expect(c.lookup({ t: 'app:ask', question: { focus: 'f1', where: [] } })).toBeUndefined() // f1 was the least recent
    // reachable by the normalised question too
    expect(c.lookup({ t: 'app:move', question: { focus: 'zzz', where: [] }, ops: [] }, { focus: 'f40', where: [] })?.answer.title).toBe('T40')
  })
  it('serves then replaces; an identical fresh answer keeps the shown object', () => {
    const c = new AnswerCache(40)
    const req = { t: 'app:start' as const, focus: 'f1' }
    expect(c.lookup(req)).toBeUndefined() // nothing seen: nothing served, the request goes out
    const first = answerFor(1)
    c.remember(req, first, '2026-09-24T10:00:00Z')
    const seen = c.lookup(req)!
    expect(seen.at).toBe('2026-09-24T10:00:00Z')
    const same = readAnswer(JSON.parse(JSON.stringify(first)))
    expect(reconcile(seen.answer, same)).toBe(seen.answer) // identity kept: no re-render
    const changed = { ...same, title: 'T1 changed' }
    expect(reconcile(seen.answer, changed)).toBe(changed) // replaced in place
    const lru = new LRU<number>(2)
    lru.set(['a', 'a2'], 1); lru.set(['b'], 2); lru.get('a'); lru.set(['c'], 3)
    expect(lru.has('b')).toBe(false); expect(lru.get('a2')).toBe(1)
  })
})

describe('a reading (app:said)', () => {
  it('the reader guards the reply', () => {
    const r = readReply({ t: 'app:said', text: 'why?', qid: 'q', markdown: '# hi', ms: 1200, question: { focus: 'summary' }, calls: [{ id: 'c1', canonical: 'x', ms: 10, at: 't' }, { canonical: 'y', refused: 'no' }, 5, {}] })
    expect(r?.t).toBe('app:said')
    if (r?.t !== 'app:said') return
    expect(r.said.calls).toHaveLength(2)
    expect(r.said.calls[1]).toEqual({ id: '', canonical: 'y', ms: 0, at: '', refused: 'no' })
    expect(readSaid(null).markdown).toBe('')
    expect(readSaid({ markdown: 7 }).calls).toEqual([])
  })
  it('renders markdown with a table and a list, and never a script', () => {
    const said = readSaid({ text: 'q', qid: 'q', ms: 900, question: { focus: 'summary' }, calls: [{ id: 'a', canonical: 'projects by rag', ms: 12, at: 't' }, { id: 'b', canonical: 'budget', ms: 9, at: 't', error: 'boom' }],
      markdown: 'Some **prose** <script>alert(1)</script> and <img src=x onerror=alert(1)>\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[ok](https://example.com) [bad](javascript:alert(1))' })
    const html = renderToString(<SaidBlock said={said} beats={[]} />)
    expect(html).toContain('<table')
    expect(html).toContain('<li>')
    expect(html).toContain('<strong>prose</strong>')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    const marked = readSaid({ text: 'q', qid: 'q', ms: 1, question: { focus: 'summary' }, calls: [],
      markdown: '49 people.\nweeks of 7 Sep and 14 Sep\n:::table red-weeks.json\n:::bar gone.json',
      blocks: [{ marker: ':::table red-weeks.json', block: { type: 'table', title: 'Under both weeks', columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'A' }, { name: 'B' }] } }, { marker: ':::bar gone.json', block: null, error: 'gone.json: ENOENT' }] })
    const h2 = renderToString(<SaidBlock said={marked} beats={[{ text: 'Pulling the rows', at: 1 }, { text: 'Counting', at: 3000 }]} />)
    expect(h2).toContain('Under both weeks')
    expect(h2).toContain('<table')
    expect(h2).not.toContain(':::table')
    expect(h2).toContain('could not be read')
    expect(h2).toContain('How it was worked out')
    expect(html).not.toContain('javascript:')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('What this stands on')
    expect(html).toContain('projects by rag')
    expect(html).toContain('data-state="critical"')
    expect(html).not.toContain('sa-question')
  })
})

describe('signs of life (lib/pending): narration about a pending app:say', () => {
  it('a narrated line by reqId or by qid resets the clock, is shown once, never resolves; silence rejects', () => {
    vi.useFakeTimers()
    try {
      const p = new Pending()
      const events: string[] = []
      p.add('r1', { resolve: () => events.push('resolved'), reject: (e) => events.push(`rejected:${e.message}`), timeoutMs: 1000, onBeat: (t) => events.push(`line:${t}`) })
      vi.advanceTimersByTime(800)
      expect(p.beat('r1', 'Looking into your question…', 'q9')).toBe(true) // by reqId; the request is now known as q9
      expect(p.beat('r1', 'Looking into your question…', 'q9')).toBe(true) // the channel's copy: same qid+text, not shown again
      vi.advanceTimersByTime(800)
      expect(p.beat(undefined, 'Asking the graph.', 'q9')).toBe(true) // by qid alone (after a reconnect)
      expect(p.touch(undefined, 'q9')).toBe(true) // the agent's own frame: clock only
      vi.advanceTimersByTime(800)
      expect(events).toEqual(['line:Looking into your question…', 'line:Asking the graph.'])
      expect(p.has('r1')).toBe(true)
      vi.advanceTimersByTime(300) // 1100 ms of silence: gone
      expect(events.at(-1)).toBe('rejected:No reply from the engine in time.')
      expect(p.beat(undefined, 'late', 'q9')).toBe(false) // nothing pending: ignored
      expect(p.beat('zz', 'x', 'q1')).toBe(false)
    } finally { vi.useRealTimers() }
  })
  it('a reply takes the request off the table with its clock; a typed question waits ten minutes', () => {
    vi.useFakeTimers()
    try {
      const p = new Pending()
      const events: string[] = []
      p.add('r2', { resolve: () => events.push('resolved'), reject: () => events.push('rejected'), timeoutMs: 1000 })
      p.take('r2')!.resolve({ t: 'app:refused', reason: 'x' })
      vi.advanceTimersByTime(5000)
      expect(events).toEqual(['resolved'])
      expect(timeoutFor('app:say')).toBe(600_000)
      expect(timeoutFor('app:ask')).toBe(90_000)
      expect(isControlFrame('narration')).toBe(true)
      expect(isControlFrame('agent:hello')).toBe(true)
      expect(readReply({ t: 'narration', text: 'x', qid: 'q', reqId: 'r' })).toBeNull()
    } finally { vi.useRealTimers() }
  })
})
