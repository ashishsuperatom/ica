// The platform's files (files.ts): every key made in one place, every kind within its limit, a content-addressed file
// checked against its name, and a session's files removed with the session — nobody else's.
import { putObject, removeUnder, prefixesOf } from '../storage'
import { describe, expect, it } from 'vitest'
import { keyOf, prefixOf, checkSize, sha256Hex, LIMITS, FileRefusal } from '../files'

function bucket() {
  const m = new Map<string, Uint8Array>()
  return {
    m,
    head: async (k: string) => (m.has(k) ? {} : null),
    put: async (k: string, v: Uint8Array) => { m.set(k, new Uint8Array(v)) },
    list: async ({ prefix }: { prefix: string }) => ({ objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
    delete: async (keys: string[]) => { for (const k of keys) m.delete(k) },
  } as any
}
const P = '11111111-2222-3333-4444-555555555555'

describe('the platform\'s files', () => {
  it('makes every key, refusing names that could reach elsewhere', () => {
    expect(keyOf.attachment(P, 's1', 'a'.repeat(64))).toBe(`attachments/${P}/s1/${'a'.repeat(64)}`)
    expect(keyOf.parcel(P, 'b'.repeat(64))).toBe(`parcel/${P}/${'b'.repeat(64)}`)
    expect(() => keyOf.attachment(P, '../other', 'a'.repeat(64))).toThrow(FileRefusal)
    expect(() => keyOf.program(P, 'not-a-hash')).toThrow(FileRefusal)
    expect(prefixesOf(P)).toEqual([`parcel/${P}/`, `programs/${P}/`, `bridge/${P}/`, `app/${P}/`, `attachments/${P}/`, `dashboard/${P}/`])   // every kind a project keeps
  })
  it('keeps every kind within its limit', () => {
    expect(() => checkSize('attachment', LIMITS.attachment + 1)).toThrow(/at most 20 MB/)
    expect(() => checkSize('attachment', 0)).toThrow(/empty/)
    expect(() => checkSize('parcel', LIMITS.parcel)).not.toThrow()
  })
  it('every object goes through the one storage door and is recorded; removing a session\'s files forgets them, nobody else\'s', async () => {
    const b = bucket()
    const rows = new Map<string, any>()
    const ledger = { add: async (r: any[]) => { for (const x of r) if (!rows.has(x.key)) rows.set(x.key, x) }, forget: async (k: string[]) => { for (const x of k) rows.delete(x) } }
    const one = new TextEncoder().encode('one'), two = new TextEncoder().encode('two')
    const h1 = await sha256Hex(one), h2 = await sha256Hex(two)
    await expect(putObject(b, ledger, { key: keyOf.attachment(P, 's1', h1), kind: 'parcel', bytes: 3, by: 'ana', body: one })).rejects.toThrow(/not where a parcel lives/)
    await putObject(b, ledger, { key: keyOf.attachment(P, 's1', h1), kind: 'attachment', bytes: 3, by: 'ana', body: one, once: true })
    await putObject(b, ledger, { key: keyOf.attachment(P, 's1', h1), kind: 'attachment', bytes: 3, by: 'bo', body: one, once: true })   // the same content: one object, one row (the first writer's)
    await putObject(b, ledger, { key: keyOf.attachment(P, 's2', h2), kind: 'attachment', bytes: 3, by: 'bo', body: two, once: true })
    expect([...rows.values()].map((r) => [r.by, r.bytes])).toEqual([['ana', 3], ['bo', 3]])
    expect(await removeUnder(b, ledger, prefixOf.session(P, 's1'))).toBe(1)
    expect([...b.m.keys()]).toEqual([keyOf.attachment(P, 's2', h2)])
    expect([...rows.keys()]).toEqual([keyOf.attachment(P, 's2', h2)])
  })
})
