// A Teams reply, as plain as possible: words alone are a text message; with tables, a card of its words and small tables
// in the order written (the answer in its one shape, clients/protocol.ts).
import { describe, expect, it } from 'vitest'
import { teamsAdapter } from '../../../../clients/messaging/channels/teams/adapter'
import type { Answer } from '../../../../clients/protocol'

describe('a Teams reply', () => {
  it('words alone go as a markdown text message, the period first', () => {
    const a: Answer = { status: 'answered', markdown: ':::period Oct 2026 · to date\nRevenue is **up 4%**.', cards: {}, periods: [{ label: 'Oct 2026', detail: 'to date' }] }
    expect(teamsAdapter.renderAnswer(a)).toEqual({ type: 'message', textFormat: 'markdown', text: '_Oct 2026 — to date_\n\nRevenue is **up 4%**.' })
  })
  it('with a table: a card — its words and the table in order, the first rows as the web words them, how many more', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ m: `M${i}`, v: i }))
    const a: Answer = { status: 'answered', markdown: 'By month.\n:::table t.json\nThat is all.', cards: { 't.json': { title: 'Months', columns: [{ key: 'm', label: 'Month' }, { key: 'v', label: 'Value' }], rows, text: rows.map((r) => [r.m, `${r.v} h`]) } } }
    const body = (teamsAdapter.renderAnswer(a) as any).attachments[0].content.body as any[]
    expect(body.map((b) => b.type === 'Table' ? `table ${b.rows.length - 1}` : b.text)).toEqual(['By month.', 'Months', 'table 10', 'Showing 10 of 14 rows', 'That is all.'])
    expect(body[2].rows[1].cells.map((c: any) => c.items[0].text)).toEqual(['M0', '0 h'])
  })
  it('a card that could not be shown says so, in place', () => {
    const body = (teamsAdapter.renderAnswer({ status: 'answered', markdown: 'X.\n:::table gone.json', cards: { 'gone.json': null } }) as any).attachments[0].content.body as any[]
    expect(body.map((b) => b.text)).toEqual(['X.', '_A table here could not be shown._'])
  })
})
