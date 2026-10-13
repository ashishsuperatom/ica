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
