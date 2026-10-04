import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, rmSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProgram, ProgramStore, loadPackage, loadNode, inspect, ProgramError } from '../src/index.ts'
import { createStateEngine } from '@superatom/state'

const fixture = fileURLToPath(new URL('./fixtures/unsettled-trips', import.meta.url))
const fresh = () => { const d = mkdtempSync(join(tmpdir(), 'prg-')); const src = join(d, 'src'); cpSync(fixture, src, { recursive: true }); return { src, store: new ProgramStore(join(d, 'store')) } }

test('a build is compiled, checked and hashed; the same source builds to the same hash and adds nothing', () => {
  const { src, store } = fresh()
  const a = buildProgram(src, store)
  assert.match(a.hash, /^[0-9a-f]{64}$/)
  assert.deepEqual(readdirSync(a.dir).sort(), ['built.json', 'doc.md', 'manifest.json', 'node', 'web'])
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
