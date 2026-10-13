// sacli agent pull: an agent written back from the platform as the folder `agent push` reads. The test that matters: a
// program pulled from its stored build and built again is the SAME program (same hash) — the source kept with a build
// is exactly what was built. Libraries a program uses come with it; a build from before sources were kept is named,
// not written empty; a folder with something in it is never written over.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initAgent } from '../src/agent-template.ts'
import { pullAgent } from '../src/agent-pull.ts'
import { buildProgram, toBundle, sourceFiles, ProgramStore } from '../../vm/packages/programs/src/index.ts'

test('a pulled program, built again, is the same program; agent.json is the agent as the platform has it', async () => {
  const made = initAgent(join(mkdtempSync(join(tmpdir(), 'pull-')), 'spend-review'), 'spend-review')
  const store = new ProgramStore(mkdtempSync(join(tmpdir(), 'store-')))
  const built = buildProgram(join(made.dir, 'programs/spend-review'), store)
  const stored = toBundle(store, built.hash)
  const agent = JSON.parse(readFileSync(join(made.dir, 'agent.json'), 'utf8'))
  const { name, ...body } = agent
  const to = join(mkdtempSync(join(tmpdir(), 'pulled-')), 'spend-review')
  const pulled = await pullAgent(to, name, { id: 'agt_1', owner: 'x', ...body }, async (p) => ({ name: p, hash: stored.hash, version: 3, published: true, files: sourceFiles(stored) }))
  assert.deepEqual(pulled.programs.map((p) => [p.name, p.version, p.published]), [['spend-review', 3, true]])
  assert.deepEqual(JSON.parse(readFileSync(join(to, 'agent.json'), 'utf8')), agent)
  const again = buildProgram(join(to, 'programs/spend-review'), new ProgramStore(mkdtempSync(join(tmpdir(), 'store2-'))))
  assert.equal(again.hash, built.hash)
})

test('the libraries a program uses come with it; a build without its source is named, not written', async () => {
  const src = (uses: string[]) => ({ 'manifest.json': JSON.stringify({ name: 'x', uses }), 'doc.md': 'd', 'server/index.ts': '' })
  const asked: string[] = []
  const to = join(mkdtempSync(join(tmpdir(), 'pulled-')), 'a')
  const pulled = await pullAgent(to, 'a', { programs: ['main', 'old'] }, async (p) => {
    asked.push(p)
    return { name: p, hash: 'h'.repeat(64), version: 1, published: false, files: p === 'old' ? null : src(p === 'main' ? ['lib'] : []) }
  })
  assert.deepEqual(asked.sort(), ['lib', 'main', 'old'])
  assert.deepEqual(pulled.compiledOnly, ['old'])
  assert.ok(existsSync(join(to, 'programs/lib/manifest.json')))
  assert.ok(!existsSync(join(to, 'programs/old')))
})

test('a folder with something in it is never written over', async () => {
  const to = mkdtempSync(join(tmpdir(), 'busy-')); mkdirSync(to, { recursive: true }); writeFileSync(join(to, 'keep.txt'), 'mine')
  await assert.rejects(pullAgent(to, 'a', { programs: [] }, async () => { throw new Error('not asked') }), /not empty/)
})
