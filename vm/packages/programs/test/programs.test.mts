import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildProgram, ProgramStore, loadPackage, loadNode, inspect, ProgramError } from '../src/index.ts'
import { createStateEngine } from '@superatom/state'

const fixture = fileURLToPath(new URL('./fixtures/unsettled-trips', import.meta.url))
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'prg-')); const src = join(d, 'src'); cpSync(fixture, src, { recursive: true }); return { src, store: new ProgramStore(join(d, 'store')) } }

test('a build is compiled, checked and hashed; the same source builds to the same hash and adds nothing', () => {
  const { src, store } = fresh()
  const a = buildProgram(src, store)
  assert.match(a.hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(readdirSync(a.dir).sort(), ['built.json', 'doc.md', 'manifest.json', 'node', 'source', 'web'])
  assert.equal(a.manifest.node.bundle, 'node/index.js')
  assert.equal(a.manifest.hash, a.hash)
  const b = buildProgram(src, store)
  assert.equal(b.hash, a.hash)
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].hash, a.hash)
  // the React side keeps the platform's libraries as imports — supplied at load, never bundled
  const web = readFileSync(join(a.dir, 'web', 'index.js'), 'utf8')
  assert.match(web, /from "react\/jsx-runtime"/)
  assert.match(web, /from 'react'|from "react"/)
})

test('any change is a new program; a stored program changed after its build is refused', async () => {
  const { src, store } = fresh()
  const a = buildProgram(src, store)
  writeFileSync(join(src, 'doc.md'), '# unsettled-trips\nSaid differently.\n')
  const b = buildProgram(src, store)
  assert.notEqual(b.hash, a.hash)
  assert.equal(store.list().length, 2)
  assert.equal(store.verify(a.hash), true)
  writeFileSync(join(a.dir, 'node', 'index.js'), 'export function run() {}')
  assert.equal(store.verify(a.hash), false)
  await assert.rejects(loadNode(store, a.hash), /does not match its hash/)
})

test('what would not load is refused at build: a library the platform does not supply, an import without its extension, a missing side', () => {
  const { src, store } = fresh()
  writeFileSync(join(src, 'web', 'index.tsx'), "import _ from 'lodash'\nexport const X = () => <div>{_.x}</div>\n")
  assert.throws(() => buildProgram(src, store), /may import only the platform's libraries/)
  const two = fresh()
  writeFileSync(join(two.src, 'server', 'index.ts'), "import { unsettledSql } from './sql'\nexport function run() { return unsettledSql(null) }\nexport function nextPage() {}\n")
  assert.throws(() => buildProgram(two.src, two.store), /imports "\.\/sql" without its extension/)
  const three = fresh()
  rmSync(join(three.src, 'doc.md'))
  assert.throws(() => buildProgram(three.src, three.store), /doc.md is required/)
  const four = fresh()
  const m = JSON.parse(readFileSync(join(four.src, 'manifest.json'), 'utf8')); m.scope = 'team:x'
  writeFileSync(join(four.src, 'manifest.json'), JSON.stringify(m))
  assert.throws(() => buildProgram(four.src, four.store), (e: any) => e instanceof ProgramError && /program.scope must be/.test(e.message))
})

test('its Node side runs in the STATE engine, with data through the platform\'s query service', async () => {
  const { src, store } = fresh()
  const { hash } = buildProgram(src, store)
  const pkg = await loadPackage(store, hash)
  const asked: string[] = []
  const query = async (source: string, sql: string, params?: Record<string, unknown>) => { asked.push(`${source}: ${sql} ${JSON.stringify(params)}`); return params?.branch === 'HYDERABAD' ? [{ trip_no: 'T1', balance: 2160 }, { trip_no: 'T2', balance: 1 }] : [{ trip_no: 'T9', balance: 5 }] }
  const engine = createStateEngine([pkg as any], { services: { query } })
  const out = await engine.dispatch(engine.start(), [{ op: 'set', path: 'trips.branch', value: 'HYDERABAD' }])
  assert.equal((out.state.trips as any).count, 2)
  assert.equal(out.ran[0].answer?.markdown.split('\n')[0], '2 trips at HYDERABAD are completed but not settled; 2161 to settle.')
  assert.match(asked[0], /^TRIPS: SELECT .* AND branch = @branch \{"branch":"HYDERABAD"\}$/)
  const next = await engine.act(out.state, 'trips', 'next')
  assert.equal((next.state.trips as any).page, 2)
  assert.equal(out.state.packages.trips, hash)
})

test('inspect says where a function lives, and the doc is the program\'s', () => {
  const { src, store } = fresh()
  const { hash, dir } = buildProgram(src, store)
  const where = inspect(store, hash, 'nextPage')
  assert.equal(where.file, join(dir, 'node', 'index.js'))
  assert.equal(where.export, 'nextPage')
  assert.throws(() => inspect(store, hash, 'nope'), /has no function nope\(\)/)
  assert.match(store.doc(hash), /Completed trips not yet settled/)
})

// ── Libraries: common code once, built into the programs that use it ─────────────────────────────────────────────
const write = (dir: string, files: Record<string, string>) => { for (const [p, t] of Object.entries(files)) { const f = join(dir, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, t) } }
const libSource = (dir: string, word = 'Rs') => write(dir, {
  'manifest.json': JSON.stringify({ id: 'prg_fmt', name: 'fmt', version: 1, scope: 'global', owner: 'user:you', attachesTo: 'shared.fmt', reads: [], published: false, kind: 'library', ui: { blocks: [] } }),
  'doc.md': '# fmt\nmoney(v): an amount in words.',
  'server/index.ts': `import { unit } from './unit.js'\nexport const money = (v: number) => \`${'${unit}'} \${v}\`\n`,
  'server/unit.ts': `export const unit = '${word}'\n`,
  'web/index.tsx': `export const Money = ({ v }: { v: number }) => <b>{v}</b>\n`,
})
const userSource = (dir: string, uses: string[], serverImport = "import { money } from '@lib/fmt'") => write(dir, {
  'manifest.json': JSON.stringify({ id: 'prg_spend', name: 'spend', version: 1, scope: 'global', owner: 'user:you', attachesTo: 'area.spend', reads: [], published: false, uses, ui: { blocks: ['spend'] },
    package: { owns: 'spend', schema: { said: 'string' }, initial: { said: '' }, reads: [], functions: [{ name: 'run', produces: 'view' }], actions: [], commands: [], doc: 'doc.md' } }),
  'doc.md': '# spend',
  'server/index.ts': `${serverImport}\nexport async function run(_s: any, ctx: any) { ctx.set({ said: money(5) }); return {} }\n`,
  'web/index.tsx': `import { Money } from '@lib/fmt'\nexport function Spend() { return <Money v={5} /> }\n`,
})

test('a program links the library build it uses (recorded in its hash, not copied in) and runs it from the one kept build', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lib-'))
  const store = new ProgramStore(join(root, 'store'))
  libSource(join(root, 'fmt'))
  const lib = buildProgram(join(root, 'fmt'), store)
  assert.equal(lib.manifest.kind, 'library')
  userSource(join(root, 'spend'), ['fmt'])
  const app = buildProgram(join(root, 'spend'), store)
  assert.deepEqual(app.manifest.uses, [{ name: 'fmt', hash: lib.hash }])
  // linked, not copied: the import stays @lib/fmt, the library is kept once as its own build
  assert.match(readFileSync(join(app.dir, 'node/index.js'), 'utf8'), /from '@lib\/fmt'/)
  assert.match(readFileSync(join(app.dir, 'web/index.js'), 'utf8'), /from '@lib\/fmt'/)
  assert.ok(!readdirSync(app.dir).includes('lib') && !readdirSync(join(app.dir, 'node')).includes('lib'))
  // it runs: the library's function, through the program's own copy
  const pkg = await loadPackage(store, app.hash)
  let set: any = null
  await pkg.functions.run({}, { set: (p: any) => { set = p } })
  assert.deepEqual(set, { said: 'Rs 5' })
  // a second program using the same build gets the same module: one load, shared
  const other = join(root, 'other'); userSource(other, ['fmt']); writeFileSync(join(other, 'manifest.json'), readFileSync(join(other, 'manifest.json'), 'utf8').replace(/spend/g, 'other'))
  const app3 = buildProgram(other, store)
  const m1 = await import(pathToFileURL(join(store.dirOf(lib.hash), 'node/index.js')).href)
  const p3 = await loadPackage(store, app3.hash)
  assert.ok(p3.functions.run)
  assert.equal(m1.money, (await import(pathToFileURL(join(store.dirOf(lib.hash), 'node/index.js')).href)).money)
  // a new library build is a new program build when the program is built again; a pin keeps the old one
  rmSync(join(root, 'fmt', 'server', 'unit.ts')); libSource(join(root, 'fmt'), 'INR')
  const lib2 = buildProgram(join(root, 'fmt'), store)
  assert.notEqual(lib2.hash, lib.hash)
  const app2 = buildProgram(join(root, 'spend'), store)
  assert.notEqual(app2.hash, app.hash)
  assert.deepEqual(app2.manifest.uses, [{ name: 'fmt', hash: lib2.hash }])
  writeFileSync(join(root, 'spend', 'manifest.json'), readFileSync(join(root, 'spend', 'manifest.json'), 'utf8').replace('"uses":["fmt"]', `"uses":["fmt@${lib.hash.slice(0, 12)}"]`))
  // (the source travels inside the hash, so the pinned build is its own build — of the library build it pins)
  assert.deepEqual(buildProgram(join(root, 'spend'), store).manifest.uses, [{ name: 'fmt', hash: lib.hash }])
})

test('refused with a sentence: an import of a library not used, a library not built, a program used as a library, a library with blocks or STATE', () => {
  const root = mkdtempSync(join(tmpdir(), 'lib-'))
  const store = new ProgramStore(join(root, 'store'))
  const refused = (dir: string, why: RegExp) => assert.throws(() => buildProgram(dir, store), (e: any) => e instanceof ProgramError && why.test(e.message))
  userSource(join(root, 'a'), ['fmt'])
  refused(join(root, 'a'), /uses "fmt", which is not built here/)
  libSource(join(root, 'fmt')); buildProgram(join(root, 'fmt'), store)
  userSource(join(root, 'b'), [])
  refused(join(root, 'b'), /does not use "fmt" — add it to "uses"/)
  cpSync(fixture, join(root, 'trips'), { recursive: true }); buildProgram(join(root, 'trips'), store)
  userSource(join(root, 'c'), ['unsettled-trips'])
  refused(join(root, 'c'), /is a program, not a library/)
  libSource(join(root, 'd'))
  writeFileSync(join(root, 'd', 'manifest.json'), JSON.stringify({ id: 'prg_d', name: 'd', version: 1, scope: 'global', owner: 'user:you', attachesTo: 'shared.d', reads: [], published: false, kind: 'library', ui: { blocks: ['d'] } }))
  refused(join(root, 'd'), /gives no blocks of its own/)
})
