// A cell started from its image with only its person's key (cell-setup.ts): the first start gets its own credential from
// the platform and keeps it on the volume; a later start reads it back and asks nothing; every setting the engine reads
// is set — the person's key never becomes the engine's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const PID = '11111111-2222-3333-4444-5555555555e1', KEY = `sak_${PID}_${'a'.repeat(32)}_${'k'.repeat(43)}`
test("one setting: its own credential got once and kept; every setting the engine reads set from it", async () => {
  const asked: any[] = []
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      asked.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') })
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ project: PID, name: 'Lab', person: 'ana@x.io', cellKey: 'sak_cell_key', keyId: 'k1', modelKey: 'sk-proj-m-x', hub: 'wss://hub.test', platform: 'hub.test' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  const home = mkdtempSync(join(tmpdir(), 'cell-'))
  const run = () => promisify(execFile)(process.execPath, ['--import', 'tsx', '-e', "await import('./cell-setup.ts'); const e = process.env; console.log(JSON.stringify({ m: e.SA_ENGINE_MODE, p: e.SA_CELL_PERSON, proj: e.ICA_PROJECT, key: e.ICA_KEY, hub: e.ICA_HUB, model: e.SA_MODEL_KEY }))"],
    { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, SUPERATOM_CELL_KEY: KEY, SUPERATOM_HOME: home, SUPERATOM_PLATFORM: `http://127.0.0.1:${(server.address() as any).port}`, SA_HOST_NAME: 'vm-1' } }).then((r) => JSON.parse(r.stdout.trim().split('\n').at(-1)!))
  try {
    const first = await run()
    assert.deepEqual(first, { m: 'cell', p: 'ana@x.io', proj: PID, key: 'sak_cell_key', hub: 'wss://hub.test', model: 'sk-proj-m-x' })
    assert.deepEqual(asked, [{ url: `/api/projects/${PID}/cell`, auth: `Bearer ${KEY}`, body: { host: 'vm-1' } }])
    assert.equal(JSON.parse(readFileSync(join(home, 'cell.json'), 'utf8')).cellKey, 'sak_cell_key')
    assert.deepEqual(await run(), first)        // started again: read back from the volume
    assert.equal(asked.length, 1)               // nothing asked again
  } finally { server.close() }
})
