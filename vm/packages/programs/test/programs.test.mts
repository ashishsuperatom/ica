import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, rmSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
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
  assert.deepEqual(readdirSync(a.dir).sort(), ['built.json', 'doc.md', 'manifest.json', 'node', 'server.json', 'source', 'web', 'web.json'])
  // what each side says it is, run once and kept beside it
  assert.deepEqual(store.server(a.hash)!.functions.map((f) => [f.name, f.export, f.produces]), [['run', 'run', 'view'], ['nextPage', 'nextPage', 'data']])
  assert.deepEqual(store.server(a.hash)!.state.initial, { branch: null, completed: true, settled: null, page: 1, count: 0 })
  assert.deepEqual(store.views(a.hash), { as: 'block', views: [{ name: 'UnsettledTrips', export: 'UnsettledTrips', doc: 'How many trips are left to settle', place: 'body', reads: ['count'], sends: [] }] })
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
  writeFileSync(join(src, 'web', 'index.tsx'), "import _ from 'lodash'\nimport { defineViews, view } from '@superatom/ui'\nexport const X = () => <div>{_.x}</div>\nexport const views = defineViews({ X: view(X) })\n")
  assert.throws(() => buildProgram(src, store), /imports "lodash": the React side imports the platform's libraries .* npm packages its package\.json lists/)
  // an npm package bundled into web/deps/ (sacli does it from the program's package.json): allowed, the import pointed there
  mkdirSync(join(src, 'web', 'deps'), { recursive: true })
  writeFileSync(join(src, 'web', 'deps', 'lodash.js'), 'export default { x: 1 }\n')
  writeFileSync(join(src, 'package.json'), '{ "dependencies": { "lodash": "4.17.21" } }')
  const built = buildProgram(src, store)
  assert.match(readFileSync(join(built.dir, 'web', 'index.js'), 'utf8'), /from '\.\/deps\/lodash\.js'/)
  assert.ok(existsSync(join(built.dir, 'source', 'package.json')))            // its package list travels with its source
  assert.ok(!existsSync(join(built.dir, 'source', 'web', 'deps')))            // what was bundled is made again, not kept twice
  const two = fresh()
  writeFileSync(join(two.src, 'server', 'index.ts'), readFileSync(join(two.src, 'server', 'index.ts'), 'utf8').replace("from './sql.js'", "from './sql'"))
  assert.throws(() => buildProgram(two.src, two.store), /imports "\.\/sql" without its extension/)
  const three = fresh()
  rmSync(join(three.src, 'doc.md'))
  assert.throws(() => buildProgram(three.src, three.store), /doc.md is required/)
  const four = fresh()
  const m = JSON.parse(readFileSync(join(four.src, 'manifest.json'), 'utf8')); m.scope = 'global'; m.package = {}
  writeFileSync(join(four.src, 'manifest.json'), JSON.stringify(m))
  assert.throws(() => buildProgram(four.src, four.store), (e: any) => e instanceof ProgramError && /manifest\.json "package" is gone — its STATE and functions: server\/index\.ts export const program = defineProgram/.test(e.message) && /"scope" is gone/.test(e.message))
  // a side that does not say what it offers, or names what it does not export
  const five = fresh()
  writeFileSync(join(five.src, 'server', 'index.ts'), readFileSync(join(five.src, 'server', 'index.ts'), 'utf8').replace('export const program', 'const program'))
  assert.throws(() => buildProgram(five.src, five.store), /server\/index\.ts says what it offers: export const program = defineProgram/)
  const six = fresh()
  writeFileSync(join(six.src, 'server', 'index.ts'), readFileSync(join(six.src, 'server', 'index.ts'), 'utf8').replace('export function nextPage', 'function nextPage'))
  assert.throws(() => buildProgram(six.src, six.store), /the function nextPage is not exported from server\/index\.ts/)
  const seven = fresh()
  writeFileSync(join(seven.src, 'web', 'index.tsx'), readFileSync(join(seven.src, 'web', 'index.tsx'), 'utf8').replace("reads: ['count']", "reads: ['cost'], sends: [{ set: 'colour' }, { call: 'trips.settleAll' }]"))
  assert.throws(() => buildProgram(seven.src, seven.store), (e: any) => /the view UnsettledTrips reads cost, which is not a field of its STATE/.test(e.message) && /changes colour, which is not a field/.test(e.message) && /calls trips\.settleAll, which trips does not offer/.test(e.message))
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
  // its option functions are loaded with it, and compute what holds at the step
  const { offered } = await engine.options(out.state, { context: '', history: [] }, { timeoutMs: 1000 })
  assert.deepEqual(offered.map((o) => o.option.label), ['Every branch, not only HYDERABAD'])
  const all = await engine.dispatch(out.state, offered[0].option.ops!)
  assert.equal((all.state.trips as any).branch, null)
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
  'manifest.json': JSON.stringify({ name: 'fmt', reads: [], kind: 'library' }),
  'doc.md': '# fmt\nmoney(v): an amount in words.',
  'server/index.ts': `import { unit } from './unit.js'\nexport const money = (v: number) => \`${'${unit}'} \${v}\`\n`,
  'server/unit.ts': `export const unit = '${word}'\n`,
  'web/index.tsx': `export const Money = ({ v }: { v: number }) => <b>{v}</b>\n`,
})
const userSource = (dir: string, uses: string[], serverImport = "import { money } from '@lib/fmt'") => write(dir, {
  'manifest.json': JSON.stringify({ name: 'spend', reads: [], uses }),
  'doc.md': '# spend',
  'server/index.ts': `${serverImport}\nimport { defineProgram, fn, field } from '@superatom/program'\nexport async function run(_s: any, ctx: any) { ctx.set({ said: money(5) }); return {} }\nexport const program = defineProgram({ state: { said: field.string() }, functions: { run: fn(run, { produces: 'view' }) } })\n`,
  'web/index.tsx': `import { Money } from '@lib/fmt'\nimport { defineViews, view } from '@superatom/ui'\nexport function Spend() { return <Money v={5} /> }\nexport const views = defineViews({ Spend: view(Spend) })\n`,
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

test('refused with a sentence: an import of a library not used, a library not built, a program used as a library', () => {
  const root = mkdtempSync(join(tmpdir(), 'lib-'))
  const store = new ProgramStore(join(root, 'store'))
  const refused = (dir: string, why: RegExp) => assert.throws(() => buildProgram(dir, store), (e: any) => e instanceof ProgramError && why.test(e.message))
  userSource(join(root, 'a'), ['fmt'])
  refused(join(root, 'a'), /uses "fmt", which is not built here/)
  libSource(join(root, 'fmt')); buildProgram(join(root, 'fmt'), store)
  userSource(join(root, 'b'), [])
  refused(join(root, 'b'), /does not use "fmt" — add it to "uses"/)
  cpSync(fixture, join(root, 'trips'), { recursive: true }); buildProgram(join(root, 'trips'), store)
  userSource(join(root, 'c'), ['trips'])
  refused(join(root, 'c'), /is a program, not a library/)

})

test('a library with functions only builds with an empty React side, so it bundles like any program', () => {
  const d = mkdtempSync(join(tmpdir(), 'lib-')), src = join(d, 'src')
  mkdirSync(join(src, 'server'), { recursive: true })
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ name: 'helpers', kind: 'library', reads: [] }))
  writeFileSync(join(src, 'doc.md'), '# helpers')
  writeFileSync(join(src, 'server', 'index.ts'), 'export const twice = (n: number) => n * 2\n')
  const store = new ProgramStore(join(d, 'store'))
  const b = buildProgram(src, store)
  assert.equal(readFileSync(join(b.dir, 'web', 'index.js'), 'utf8'), 'export {}\n')
  assert.match(readFileSync(join(b.dir, 'node', 'index.js'), 'utf8'), /twice/)
})

test("a filter's choices come from a function the program exports: one not exported, or a filter on no field of its STATE, is refused at build", async () => {
  const { src, store } = fresh()
  const server = readFileSync(join(src, 'server', 'index.ts'), 'utf8')
  const withFilter = (filter: string, extra = '') => writeFileSync(join(src, 'server', 'index.ts'), server.replace('  options: [everyBranch, morePages],', `  options: [everyBranch, morePages],\n  filters: [${filter}],`) + extra)
  withFilter("{ field: 'branch', label: 'Branch', options: branchOptions }", "\nasync function branchOptions() { return [] }\n")
  assert.throws(() => buildProgram(src, store), /the filter branch's choices is not exported from server\/index\.ts/)
  withFilter("{ field: 'plant', label: 'Plant', options: branchOptions }", "\nexport async function branchOptions() { return [] }\n")
  assert.throws(() => buildProgram(src, store), /the filter plant is not a field of its STATE/)
  withFilter("{ field: 'branch', label: 'Branch', options: branchOptions, size: 'medium' }", "\nexport async function branchOptions() { return [{ value: 'PUNE', label: 'Pune', count: 3 }] }\n")
  const built = buildProgram(src, store)
  const p = await loadPackage(store, built.hash)
  assert.equal(typeof p.functions.branchOptions, 'function')
  assert.deepEqual(p.spec.filters?.map((f) => [f.field, f.options, f.size]), [['branch', 'branchOptions', 'medium']])
})

test('a program does only what its manifest says it may: a source not in its reads, a table not in its writes, is refused before it reaches the data', async () => {
  const { src, store } = fresh()
  const m = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'))
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ ...m, reads: ['SALES'] }))
  writeFileSync(join(src, 'server', 'index.ts'), readFileSync(join(src, 'server', 'index.ts'), 'utf8').replace('export function nextPage(state: any, ctx: Ctx) {', "export async function nextPage(state: any, ctx: Ctx) {\n  await (ctx.services as any).append('TRIPS', 'settlements', [])"))
  const { hash } = buildProgram(src, store)
  const pkg = await loadPackage(store, hash)
  assert.deepEqual(pkg.may, { reads: ['SALES'], writes: [] })
  const asked: string[] = []
  const engine = createStateEngine([pkg as any], { services: { query: async (s: string) => { asked.push(s); return [] }, append: async () => ({ rows: 0 }) } })
  await assert.rejects(engine.call(engine.start(), 'trips', 'run'), /trips may not read TRIPS: its manifest's reads are SALES — add "TRIPS" there/)
  await assert.rejects(engine.call(engine.start(), 'trips', 'nextPage'), /trips may not write to TRIPS\/settlements: its manifest's writes are none — add "TRIPS\/settlements" there/)
  assert.deepEqual(asked, [])   // nothing reached the data
})

test('an action names the capability it needs in the manifest, or the build refuses it', () => {
  const { src, store } = fresh()
  writeFileSync(join(src, 'server', 'index.ts'), readFileSync(join(src, 'server', 'index.ts'), 'utf8').replace("nextPage: fn(nextPage, { produces: 'data', doc: 'The next page of them' })", "nextPage: fn(nextPage, { produces: 'action', doc: 'Settle the page' })"))
  assert.throws(() => buildProgram(src, store), /nextPage produces an action: manifest\.json names the capability it needs — "permissions": \{ "nextPage": "<capability>" \}/)
  const m = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'))
  writeFileSync(join(src, 'manifest.json'), JSON.stringify({ ...m, permissions: { nextPage: 'trips.settle' } }))
  assert.equal(buildProgram(src, store).manifest.permissions?.nextPage, 'trips.settle')
})
