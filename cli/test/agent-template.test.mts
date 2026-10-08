// The agent template as sacli carries it: the same as its folder, and a new agent made from it named for itself through
// and through — its program building as it stands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collect, render } from '../scripts/embed-agent-template.mjs'
import { initAgent } from '../src/agent-template.ts'
import { buildProgram, ProgramStore } from '../../vm/packages/programs/src/index.ts'

test('the embedded template is the folder as it is now (pnpm build writes it)', () => {
  assert.equal(readFileSync(new URL('../src/agent-template.gen.ts', import.meta.url), 'utf8'), render(collect()), 'stale: run `pnpm -C cli build` (or node cli/scripts/embed-agent-template.mjs)')
})

test('a new agent is named for itself: agent, domain, program and block by its name, its slice by the name as an identifier', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'agent-')), 'spend-review')
  const made = initAgent(dir, 'spend-review')
  assert.ok(made.files.includes('programs/spend-review/manifest.json'))
  const agent = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8'))
  assert.deepEqual([agent.name, agent.domain, agent.programs, Object.keys(agent.start)], ['spend-review', 'spend-review', ['spend-review'], ['spend_review']])
  const m = JSON.parse(readFileSync(join(dir, 'programs/spend-review/manifest.json'), 'utf8'))
  assert.deepEqual([m.id, m.name, m.ui.blocks, m.package.owns], ['prg_spend_review', 'spend-review', ['spend-review'], 'spend_review'])
  assert.match(readFileSync(join(dir, 'programs/spend-review/web/index.tsx'), 'utf8'), /export function SpendReview\(/)
  assert.match(readFileSync(join(dir, 'knowledge/index.mts'), 'utf8'), /name: 'spend-review',/)
  assert.ok(!/\bexample\b/i.test(readFileSync(join(dir, 'programs/spend-review/server/index.ts'), 'utf8')))
  const built = buildProgram(join(dir, 'programs/spend-review'), new ProgramStore(mkdtempSync(join(tmpdir(), 'store-'))))
  assert.equal(built.manifest.name, 'spend-review')
  assert.throws(() => initAgent(dir, 'spend-review'), /there already/)
  assert.throws(() => initAgent(join(dir, '..', 'Bad Name'), 'Bad Name'), /not an agent name/)
  assert.ok(existsSync(join(dir, 'README.md')))
})
