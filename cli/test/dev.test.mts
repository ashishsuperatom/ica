// sacli dev decides what an environment overrides: every program, agent and the map a clone has changed since it was
// cloned — a changed library brings the programs using it — and nothing else (the rest stays what is published).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeClone, type ProjectSnapshot } from '../src/clone.ts'
import { devPlan, envNameOf } from '../src/dev.ts'

const prog = (name: string, extra: Record<string, unknown> = {}) => ({ 'manifest.json': JSON.stringify({ name, ...extra }), 'doc.md': name, 'server/index.ts': '' })
const snap: ProjectSnapshot = {
  project: 'p', graph: 'v1', knowledge: { source: '', files: {} },
  agents: [{ name: 'today', scope: 'global', body: { title: 'Today', programs: ['home'] } }], map: { sections: [], home: 'today' },
  programs: [
    { name: 'fmt', hash: '1'.repeat(64), version: 1, kind: 'library', files: prog('fmt', { kind: 'library' }) },
    { name: 'home', hash: '2'.repeat(64), version: 1, kind: 'program', files: prog('home', { uses: ['fmt'] }) },
    { name: 'other', hash: '3'.repeat(64), version: 1, kind: 'program', files: prog('other') },
  ], sdk: null,
}

test('nothing changed: nothing overridden', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'dev-')), 'My Clone')
  const r = writeClone(dir, snap, 'h')
  assert.deepEqual(devPlan(dir, r), { programs: [], agents: {} })
  assert.equal(envNameOf(dir), 'my-clone')
})

test('a changed library brings the programs using it, libraries first; changed agents and the map come as bodies', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'dev-')), 'c')
  const r = writeClone(dir, snap, 'h')
  writeFileSync(join(dir, 'programs/fmt/server/index.ts'), 'export const x = 1')
  writeFileSync(join(dir, 'agents/today.json'), JSON.stringify({ name: 'today', title: 'Today, new' }))
  writeFileSync(join(dir, 'map.json'), JSON.stringify({ sections: [], home: 'other' }))
  mkdirSync(join(dir, 'programs/fresh/server'), { recursive: true })
  writeFileSync(join(dir, 'programs/fresh/manifest.json'), JSON.stringify({ name: 'fresh' })); writeFileSync(join(dir, 'programs/fresh/server/index.ts'), '')
  const plan = devPlan(dir, r)
  assert.deepEqual(plan.programs, ['fmt', 'fresh', 'home'])
  assert.deepEqual(plan.agents, { today: { title: 'Today, new' } })
  assert.deepEqual(plan.map, { sections: [], home: 'other' })
})
