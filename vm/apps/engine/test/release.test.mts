// The engine's side of a release switch (release.ts): the platform's choice kept for the updater, the proof it came up,
// and what it reports.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelease } from '../release.ts'

test('the chosen release is written once for the updater; the engine notes it is up and reports the last switch', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'rel-')), 'engine-release')
  const build = join(dir, '..', 'BUILD_ID'); writeFileSync(build, 'abc123\n')
  process.env.SA_ENGINE_IMAGE = 'registry.superatom.ai/superatom-engine@sha256:' + 'a'.repeat(64)
  const r = createRelease(dir, build)
  const chosen = { digest: 'sha256:' + 'b'.repeat(64), tag: 'dev-2', image: 'registry.superatom.ai/superatom-engine@sha256:' + 'b'.repeat(64) }
  assert.equal(r.desire(chosen), true)
  assert.equal(r.desire(chosen), false)   // the same choice again writes nothing
  assert.equal(r.desire(null), false)
  assert.equal(JSON.parse(readFileSync(join(dir, 'desired.json'), 'utf8')).digest, chosen.digest)
  r.connected()
  assert.equal(JSON.parse(readFileSync(join(dir, 'running.json'), 'utf8')).build, 'abc123')
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ state: 'rolled-back', reason: 'x' }))
  const rep = r.report()
  assert.equal(rep.digest, 'sha256:' + 'a'.repeat(64)); assert.equal(rep.build, 'abc123'); assert.equal(rep.last.state, 'rolled-back')
  delete process.env.SA_ENGINE_IMAGE
})
