import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgram, ProgramStore, toBundle, fromBundle, bundleHash, checkBundle, verifyBundle } from '../src/index.ts'

const fixture = fileURLToPath(new URL('./fixtures/unsettled-trips', import.meta.url))
const built = () => { const d = mkdtempSync(join(tmpdir(), 'bun-')); const src = join(d, 'src'); cpSync(fixture, src, { recursive: true }); const store = new ProgramStore(join(d, 'store')); return { ...buildProgram(src, store), store, src } }

test('a built program travels as one bundle and arrives as the same program, in another store', async () => {
  const a = built()
  const b = toBundle(a.store, a.hash)
  assert.equal(await bundleHash(b.files), a.hash)                 // Web Crypto agrees with the store's hash
  assert.deepEqual(Object.keys(b.files).sort(), ['doc.md', 'manifest.json', 'node/index.js', 'node/sql.js', 'web/index.js'])
  const other = new ProgramStore(mkdtempSync(join(tmpdir(), 'bun2-')))
  assert.equal(await fromBundle(other, b), a.hash)
  assert.equal(other.verify(a.hash), true)
  assert.equal(other.manifest(a.hash).name, 'unsettled-trips')
  assert.equal(await fromBundle(other, b), a.hash)                // again: nothing to do
})

test('a changed or malformed bundle is refused with what is wrong', async () => {
  const a = built()
  const b = toBundle(a.store, a.hash)
  const changed = { ...b, files: { ...b.files, 'node/index.js': b.files['node/index.js'] + '\n// sneaky' } }
  assert.match((await verifyBundle(changed))[0], /the bundle was changed or damaged/)
  await assert.rejects(fromBundle(new ProgramStore(mkdtempSync(join(tmpdir(), 'bun3-'))), changed), /changed or damaged/)
  assert.deepEqual(checkBundle({ format: 1, hash: 'x', files: { '../etc/passwd': 'x', 'built.json': '{}' } }), [
    'a bundle names its hash (64 hex characters)', '"../etc/passwd" is not a path in a program', "built.json is the store's own record, not part of a program",
    'a built program has manifest.json', 'a built program has doc.md', 'a built program has node/index.js', 'a built program has web/index.js'])
})

test('a program file that is not text is refused at the store, so a bundle always carries exactly what was hashed', () => {
  const a = built()
  writeFileSync(join(a.store.dirOf(a.hash), 'web', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]))
  assert.throws(() => toBundle(a.store, a.hash), /web\/logo.png is not text/)
})
