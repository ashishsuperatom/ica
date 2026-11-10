// What a person's cell may ask of the project (cell-door.ts), rule by rule: the replicas, and of what is per person only its
// own person's; anything else refused with the reply its asker waits for; the person always the link's, never the message's.
import { describe, expect, it } from 'vitest'
import { cellAsks, CELL_ASKS, type CellDoor } from '../cell-door'

const door = (out: any[], over: Partial<CellDoor> = {}): CellDoor => ({
  person: { email: 'ana@x.io', id: 'a'.repeat(32) },
  reply: (p) => out.push(p),
  graphPull: (cursor) => ({ batch: [{ cursor }], cursor: 9 }),
  graphFingerprint: async () => ({ hash: 'g' }),
  dsiPull: (cursor, source) => ({ rows: [], cursor, source }),
  dsiFingerprints: async () => ({ sources: { S: 'f' }, latest: 3 }),
  connections: async (email) => [{ name: 'MINE', for: email }],
  personKey: async (name, email) => ({ key: { secrets: { token: `${name}:${email}` } } }),
  policies: () => ({ policies: [], version: 4 }),
  ...over,
})

describe('a cell asks the project', () => {
  it('the replicas, answered as an engine is', async () => {
    const out: any[] = []
    await cellAsks({ type: 'graph:pull', cursor: { a: 1 } }, door(out))
    await cellAsks({ type: 'dsi:fingerprints', reqId: 'r1' }, door(out))
    expect(out).toEqual([{ t: 'graph:batch', batch: [{ cursor: { a: 1 } }], cursor: 9 }, { t: 'dsi:fingerprints', reqId: 'r1', sources: { S: 'f' }, latest: 3 }])
  })
  it('its connections and its key: its own person\'s, whoever the message names', async () => {
    const out: any[] = []
    await cellAsks({ type: 'connections:pull', reqId: 'c', email: 'bo@x.io' }, door(out))
    expect(out[0]).toEqual({ t: 'connections:list', reqId: 'c', connections: [{ name: 'MINE', for: 'ana@x.io' }] })
    await cellAsks({ type: 'connection:person-key', reqId: 'k1', name: 'M365', email: 'ANA@x.io' }, door(out))
    expect(out[1]).toMatchObject({ t: 'connection:person-key', reqId: 'k1', key: { secrets: { token: 'M365:ana@x.io' } } })
    await cellAsks({ type: 'connection:person-key', reqId: 'k2', name: 'M365', email: 'bo@x.io' }, door(out))
    expect(out[2]).toEqual({ t: 'connection:person-key', reqId: 'k2', error: "a cell asks only for its own person's key" })
  })
  it("access: only its own person's", async () => {
    const out: any[] = []
    await cellAsks({ type: 'access:resolve', reqId: 'a1', principal: `user:${'a'.repeat(32)}`, email: 'ana@x.io', source: 'S' }, door(out))
    expect(out[0]).toMatchObject({ t: 'access:resolved', reqId: 'a1', policies: [], version: 4 })
    await cellAsks({ type: 'access:resolve', reqId: 'a2', principal: `user:${'b'.repeat(32)}`, email: 'ana@x.io', source: 'S' }, door(out))
    expect(out[1]).toMatchObject({ t: 'access:resolved', reqId: 'a2', error: "a cell reads only its own person's access" })
  })
  it('anything else is refused, saying so; a failure answers with the reply its asker waits for', async () => {
    const out: any[] = []
    for (const type of ['session:sync', 'dsi:put', 'graph:write', 'intent:pass', 'workload:status', '']) await cellAsks({ type, reqId: type }, door(out))
    expect(out.every((p) => p.t === 'cell:refused' && /is not a cell's to ask/.test(p.reason))).toBe(true)
    expect(CELL_ASKS.has('dsi:put')).toBe(false)   // a cell does not write the project's index
    const before = out.length; await cellAsks({ type: 'ready' }, door(out)); expect(out.length).toBe(before)   // its self-check: nothing to answer
    await cellAsks({ type: 'dsi:fingerprints', reqId: 'f' }, door(out, { dsiFingerprints: async () => { throw new Error('down') } }))
    expect(out.at(-1)).toEqual({ t: 'dsi:fingerprints', reqId: 'f', error: 'down' })
  })
})

describe("a cell reads its connections' code", () => {
  it("a bridge: the project's engine or a member (a person's cell on their key); anything else the engine's alone", async () => {
    const { handleObjectRoute } = await import('../parcels')
    const pid = '11111111-2222-3333-4444-5555555555c1', hash = 'a'.repeat(64)
    const bucket: any = { get: async (k: string) => (k === `bridge/${pid}/${hash}` || k.startsWith('program') ? { body: 'export function createBridge() {}', size: 32, httpMetadata: {} } : null) }
    const read = (kind: string, id: string, who: { engine?: boolean; member?: string | null }) => handleObjectRoute({ request: new Request(`http://x/api/projects/${pid}/objects/${kind}/${id}`), bucket, secret: 's', projectId: pid, kind, id,
      isEngine: async () => !!who.engine, isMember: async () => who.member ?? null, ledger: {} as any })
    expect((await read('bridge', hash, { member: 'ana@x.io' })).status).toBe(200)
    expect((await read('bridge', hash, { engine: true })).status).toBe(200)
    expect((await read('bridge', hash, {})).status).toBe(401)
    expect((await read('program', hash, { member: 'ana@x.io' })).status).toBe(401)   // a build is the engine's to read
  })
})
