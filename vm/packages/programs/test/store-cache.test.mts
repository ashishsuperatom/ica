// The program store as a cache over the platform: a build is marked used as it runs (outside its hash), and a sweep
// removes what is neither kept nor used lately — the hash of what remains unchanged.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgram, ProgramStore } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/unsettled-trips', import.meta.url))

test('a sweep removes builds neither kept nor used since; marking a build used keeps it, and never changes its hash', () => {
  const d = mkdtempSync(join(tmpdir(), 'cache-')), store = new ProgramStore(join(d, 'store'))
  const build = (word: string) => {
    const src = join(d, word); cpSync(fixture, src, { recursive: true })
    const f = join(src, 'server/index.ts'); writeFileSync(f, readFileSync(f, 'utf8').replace('are completed', `are ${word}`))
    return buildProgram(src, store).hash
  }
  const [old, kept, recent, touched] = ['old', 'kept', 'recent', 'touched'].map(build)
  const long = new Date(Date.now() - 30 * 86_400_000)
  for (const h of [old, kept, touched]) utimesSync(join(store.dirOf(h), 'built.json'), long, long)
  store.touch(touched)
  assert.ok(store.verify(touched))
  const gone = store.sweep([kept], Date.now() - 14 * 86_400_000)
  assert.deepEqual(gone, [old])
  assert.ok(!store.has(old))
  for (const h of [kept, recent, touched]) { assert.ok(store.has(h)); assert.ok(store.verify(h)) }
})
