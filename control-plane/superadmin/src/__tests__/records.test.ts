import { describe, expect, it } from 'vitest'
import { createRecorder } from '../records'

describe('the platform recorder', () => {
  it('sends each record once, flat, with its kind, project and key; a failed send does not throw', async () => {
    const sent: any[] = []
    const record = createRecorder({ send: async (r) => { sent.push(...r) } }, () => 'p1')
    record('usage', '42', { tokens_in: 10 }, '2026-10-05T00:00:00Z')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ kind: 'usage', project: 'p1', key: '42', at: '2026-10-05T00:00:00Z', data: '{"tokens_in":10}' })
    const failing = createRecorder({ send: async () => { throw new Error('down') } }, () => 'p1')
    expect(() => failing('audit', 'a', {})).not.toThrow()
    expect(() => createRecorder(undefined, () => 'p1')('audit', 'a', {})).not.toThrow()   // unbound: nothing to do
  })
})
