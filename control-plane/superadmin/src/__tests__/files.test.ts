// The platform's files (files.ts): every key made in one place, every kind within its limit, a content-addressed file
// checked against its name, and a session's files removed with the session — nobody else's.
import { describe, expect, it } from 'vitest'
import { keyOf, prefixOf, checkSize, putByHash, removeUnder, sha256Hex, LIMITS, FileRefusal } from '../files'

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
    expect(prefixOf.project(P)).toEqual([`parcel/${P}/`, `programs/${P}/`, `dashboard/${P}/`, `attachments/${P}/`])
  })
  it('keeps every kind within its limit', () => {
    expect(() => checkSize('attachment', LIMITS.attachment + 1)).toThrow(/at most 20 MB/)
    expect(() => checkSize('attachment', 0)).toThrow(/empty/)
    expect(() => checkSize('parcel', LIMITS.parcel)).not.toThrow()
  })
  it('puts a content-addressed file only if it hashes to its name; removes a session\'s files and nobody else\'s', async () => {
    const b = bucket()
    const one = new TextEncoder().encode('one'), two = new TextEncoder().encode('two')
    const h1 = await sha256Hex(one), h2 = await sha256Hex(two)
    await expect(putByHash(b, 'attachment', keyOf.attachment(P, 's1', h1), h2, one, 'text/plain')).rejects.toThrow(/do not hash/)
    await putByHash(b, 'attachment', keyOf.attachment(P, 's1', h1), h1, one, 'text/plain')
    await putByHash(b, 'attachment', keyOf.attachment(P, 's2', h2), h2, two, 'text/plain')
    expect(await removeUnder(b, prefixOf.session(P, 's1'))).toBe(1)
    expect([...b.m.keys()]).toEqual([keyOf.attachment(P, 's2', h2)])
  })
})
