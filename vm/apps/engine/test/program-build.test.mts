// A program built on this engine (program-seam.ts), with the platform played by a fake: a build the platform does not
// take is not kept here either — so no later build can link a library no other engine could fetch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProgramSeam } from '../program-seam.ts'

const fixture = fileURLToPath(new URL('../../../packages/programs/test/fixtures/unsettled-trips', import.meta.url))
const filesOf = (dir: string): Record<string, string> => Object.fromEntries(readdirSync(dir, { recursive: true }).map(String)
  .filter((p) => statSync(join(dir, p)).isFile()).map((p) => [relative(dir, join(dir, p)).split('\\').join('/'), readFileSync(join(dir, p), 'utf8')]))

test('a build the platform refuses is not kept: the store holds nothing a later build could link', async () => {
  const out: any[] = []
  const seam = createProgramSeam({ projectDir: mkdtempSync(join(tmpdir(), 'pb-')), send: (_to, m) => out.push(m),
    platform: { uploadProgram: async () => { throw new Error('the platform refused the bundle') } } as any })
  await seam.handle({ t: 'program:build', files: filesOf(fixture), reqId: 'r1' }, { id: 'ws', type: 'runtime', userId: 'u1' })
  assert.equal(out.at(-1)?.t, 'program:refused')
  assert.match(String(out.at(-1)?.reason), /refused the bundle/)
  assert.deepEqual(seam.store.list(), [])
})

test('a build the platform takes is kept, by its hash', async () => {
  const out: any[] = []
  const seam = createProgramSeam({ projectDir: mkdtempSync(join(tmpdir(), 'pb-')), send: (_to, m) => out.push(m),
    platform: { uploadProgram: async () => ({ added: true }) } as any })
  await seam.handle({ t: 'program:build', files: filesOf(fixture), reqId: 'r2' }, { id: 'ws', type: 'runtime', userId: 'u1' })
  assert.equal(out.at(-1)?.t, 'program:built')
  assert.deepEqual(seam.store.list().map((m) => m.hash), [out.at(-1).hash])
})

test('an environment deleted (purge) loses its builds; one only ended keeps them for its owner to resume; a build the platform also holds stays', async () => {
  const out: any[] = []
  let held: string[] = []
  const seam = createProgramSeam({ projectDir: mkdtempSync(join(tmpdir(), 'pb-')), send: (_to, m) => out.push(m),
    platform: { uploadProgram: async () => ({ added: true }), listPrograms: async () => held.map((hash) => ({ hash, name: 'x', uploaded_at: '', published_at: null })) } as any })
  const ana = { id: 'ws', type: 'runtime', userId: 'u1', dev: { id: 'dv_try1', programs: {}, agents: {} } }
  await seam.handle({ t: 'program:build', env: 'dv_try1', files: filesOf(fixture), reqId: 'b1' }, ana)
  assert.equal(out.at(-1)?.t, 'program:built', JSON.stringify(out.at(-1)))
  const hash = out.at(-1).hash
  const hub = { id: 'hub', type: 'hub' }
  // the platform holds the same program: not the environment's to remove
  held = [hash]
  await seam.handle({ t: 'dev:clear', env: 'dv_try1', purge: true, reqId: 'c1' }, hub)
  assert.equal(out.at(-1)?.removed, 0)
  assert.deepEqual(seam.store.list().map((m) => m.hash), [hash])
  // built again into the environment, the platform holding nothing: deleted, it goes
  await seam.handle({ t: 'program:build', env: 'dv_try1', files: filesOf(fixture), reqId: 'b2' }, ana)
  held = []
  await seam.handle({ t: 'dev:clear', env: 'dv_try1', purge: true, reqId: 'c2' }, hub)
  assert.equal(out.at(-1)?.removed, 1)
  assert.deepEqual(seam.store.list(), [])
  // only the platform ends an environment
  await seam.handle({ t: 'dev:clear', env: 'dv_try1', purge: true, reqId: 'c3' }, ana)
  assert.notEqual(out.at(-1)?.reqId, 'c3')
})

test("a development environment held here is a workload (its builds), gone once the platform ends it", async () => {
  const seen: any[] = [], gone: string[] = []
  const workloads = { set: (w: any) => seen.push(w), gone: (_k: string, id: string) => gone.push(id) } as any
  const seam = createProgramSeam({ projectDir: mkdtempSync(join(tmpdir(), 'pb-')), send: () => {}, workloads: () => workloads,
    platform: { uploadProgram: async () => ({ added: true }), listPrograms: async () => [] } as any })
  const ana = { id: 'ws', type: 'runtime', userId: 'u1', dev: { id: 'dv_wl01', programs: {}, agents: {} } }
  await seam.handle({ t: 'program:build', env: 'dv_wl01', files: filesOf(fixture), reqId: 'b1' }, ana)
  assert.deepEqual(seen.at(-1), { kind: 'dev-env', id: 'dv_wl01', state: 'ready', health: { builds: 1 } })
  await seam.handle({ t: 'dev:clear', env: 'dv_wl01', reqId: 'c1' }, { id: 'hub', type: 'hub' })
  assert.deepEqual(gone, ['dv_wl01'])
})

