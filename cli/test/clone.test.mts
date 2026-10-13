// sacli clone / pull, without the network: a project snapshot written as one folder; that folder type-checks against
// the platform SDK (platform/) — every import a program makes resolves, server and web, the template's included — and
// pull brings it up to the published version, refusing to lose local changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeClone, localChanges, pullInto, type ProjectSnapshot } from '../src/clone.ts'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const sdkFile = join(mkdtempSync(join(tmpdir(), 'sdk-')), 'sdk.json')
execFileSync('node', [join(repo, 'scripts/build-sdk.mjs'), sdkFile, 'test'], { stdio: 'ignore' })
const sdk = JSON.parse(readFileSync(sdkFile, 'utf8'))
const filesUnder = (dir: string) => { const out: Record<string, string> = {}; const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else out[relative(dir, p)] = readFileSync(p, 'utf8') } }; walk(dir); return out }
const example = filesUnder(join(repo, 'vm/packages/project-template/start/agent-template/programs/example'))

const snapshot = (over: Partial<ProjectSnapshot> = {}): ProjectSnapshot => ({
  project: '11111111-2222-3333-4444-555555555555', graph: 'v3',
  knowledge: { source: '// knowledge\n', files: {} },
  agents: [{ name: 'today', scope: 'global', body: { title: 'Today', says: 'What needs you today', programs: ['example'] } }],
  map: { sections: [], home: 'today' },
  programs: [{ name: 'example', hash: 'a'.repeat(64), version: 2, kind: 'program', files: example }, { name: 'old', hash: 'b'.repeat(64), version: 1, kind: 'program', files: null }],
  sdk, ...over,
})

test('a clone is the whole project as one folder, and every program type-checks against platform/', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'clone-')), 'proj')
  const r = writeClone(dir, snapshot(), 'wss://x')
  for (const f of ['superatom.json', 'AGENTS.md', 'map.json', 'knowledge/index.mts', 'agents/today.json', 'programs/example/server/index.ts', 'programs/example/web/index.tsx', 'platform/README.md', 'platform/ui/src/index.d.ts', 'platform/program/index.d.ts', 'tsconfig.json', 'tsconfig.server.json'])
    assert.ok(existsSync(join(dir, f)), f)
  assert.ok(!existsSync(join(dir, 'programs/old')))
  const md = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  assert.match(md, /\*\*today\*\* — Today: What needs you today/)
  assert.match(md, /front page is the agent \*\*today\*\*/)
  assert.match(md, /\*\*old\*\* v1 \(built before sources were kept/)
  assert.equal(r.programs.example.hash, 'a'.repeat(64))
  // What `pnpm install` gives a clone (package.json's devDependencies), taken from the repository's own installs.
  const nm = join(dir, 'node_modules'); mkdirSync(join(nm, '@types'), { recursive: true })
  const ui = join(repo, 'vm/packages/ui/node_modules')
  for (const [to, from] of [['@types/react', join(ui, '@types/react')], ['@types/react-dom', join(ui, '@types/react-dom')], ['@types/node', join(repo, 'vm/node_modules/@types/node')], ['echarts', join(ui, 'echarts')]]) symlinkSync(from, join(nm, to))
  const tsc = join(repo, 'vm/node_modules/.bin/tsc')
  for (const cfg of ['tsconfig.json', 'tsconfig.server.json']) {
    try { execFileSync(tsc, ['-p', cfg], { cwd: dir, encoding: 'utf8' }) }
    catch (e: any) { assert.fail(`${cfg}:\n${e.stdout}`) }
  }
  assert.throws(() => writeClone(dir, snapshot(), 'wss://x'), /not empty/)
})

test('pull brings a clone up to what is published, and never loses a local change unless forced', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'clone-')), 'proj')
  const r = writeClone(dir, snapshot({ sdk: null }), 'wss://x')
  assert.deepEqual(localChanges(dir, r), { edited: [], added: [], removed: [] })
  const next = snapshot({ sdk: null, graph: 'v4', agents: [{ name: 'today', scope: 'global', body: { title: 'Today, renamed', programs: ['example'] } }] })
  writeFileSync(join(dir, 'programs/example/doc.md'), 'mine')
  assert.throws(() => pullInto(dir, r, next), /1 local change would be lost: programs\/example\/doc\.md/)
  const { record, changed } = pullInto(dir, r, next, true)
  assert.equal(record.graph, 'v4')
  assert.ok(changed.includes('agents/today.json'))
  assert.match(readFileSync(join(dir, 'agents/today.json'), 'utf8'), /Today, renamed/)
  assert.equal(readFileSync(join(dir, 'programs/example/doc.md'), 'utf8'), example['doc.md'])
  assert.deepEqual(localChanges(dir, record), { edited: [], added: [], removed: [] })
})
