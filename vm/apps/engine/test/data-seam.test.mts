// The data seam agents' tools and scripts use: the asker's data access policies ride with every query; if they could
// not be checked nothing is read; the platform's own work (no reader file) carries none.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dataSeam } from '../ica/workspace.ts'

const home = mkdtempSync(join(tmpdir(), 'seam-'))
let server: Server, seen: any[] = [], query: (id: string, sql: string) => Promise<unknown[]>
before(async () => {
  server = createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)).on('end', () => { seen.push(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end('{"rows":[]}') }) })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  mkdirSync(join(home, 'data'))
  writeFileSync(join(home, 'data', 'query.mjs'), dataSeam(`http://127.0.0.1:${(server.address() as any).port}`))
  query = (await import(pathToFileURL(join(home, 'data', 'query.mjs')).href)).query
})
after(() => server.close())

test("an asker's policies ride with each query, for that source only", async () => {
  writeFileSync(join(home, '.reader.json'), JSON.stringify({ principal: 'user:ana', policies: { TRIPS: [{ table: 'trips', predicate: "{t}.branch = 'PUNE'" }] } }))
  await query('TRIPS', 'SELECT 1')
  assert.deepEqual(seen.at(-1).policies, [{ table: 'trips', predicate: "{t}.branch = 'PUNE'" }])
  await query('OTHER', 'SELECT 1')
  assert.equal(seen.at(-1).policies, undefined)
})

test('policies that could not be checked: nothing is read', async () => {
  const before = seen.length
  writeFileSync(join(home, '.reader.json'), JSON.stringify({ unchecked: true }))
  await assert.rejects(query('TRIPS', 'SELECT 1'), /your data access could not be checked — nothing was read/)
  assert.equal(seen.length, before)
})

test("the platform's own work (no reader file) carries none", async () => {
  rmSync(join(home, '.reader.json'))
  await query('TRIPS', 'SELECT 1')
  assert.equal(seen.at(-1).policies, undefined)
})
