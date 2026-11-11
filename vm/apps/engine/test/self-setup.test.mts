// An engine started from its image with one setting, its key (self-setup.ts): the first start gets what it connects with
// from the platform and keeps it on the volume; a later start reads it back and asks nothing; every setting the engine
// reads is set from it — and anything given explicitly wins. A cell (a person's key) or the project's engine (a key
// holding project.manage).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const PID = '11111111-2222-3333-4444-5555555555e1', KEY = `sak_${PID}_${'a'.repeat(32)}_${'k'.repeat(43)}`

async function platform() {
  const asked: any[] = []
  const server = createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c }); req.on('end', () => {
      asked.push({ method: req.method, url: req.url, auth: req.headers.authorization, ...(body ? { body: JSON.parse(body) } : {}) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(req.url!.endsWith('/cell')
        ? { project: PID, name: 'Lab', person: 'ana@x.io', cellKey: 'sak_cell_key', keyId: 'k1', modelKey: 'sk-proj-m-x', hub: 'wss://hub.test', platform: 'hub.test' }
        : { project: PID, name: 'Lab', engineKey: 'engine-key-1', hub: 'wss://hub.test', platform: 'hub.test' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, r))
  return { asked, url: `http://127.0.0.1:${(server.address() as any).port}`, close: () => server.close() }
}
const start = (env: Record<string, string>) => promisify(execFile)(process.execPath, ['--import', 'tsx', '-e',
  "await import('./self-setup.ts'); const e = process.env; console.log(JSON.stringify({ m: e.SA_ENGINE_MODE || null, p: e.SA_CELL_PERSON || null, proj: e.ICA_PROJECT, key: e.ICA_KEY, hub: e.ICA_HUB, model: e.SA_MODEL_KEY || null, name: e.PROJECT_NAME }))"],
  { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, ICA_KEY: '', ICA_PROJECT: '', ICA_HUB: '', SA_ENGINE_MODE: '', SA_CELL_PERSON: '', SA_MODEL_KEY: '', PROJECT_NAME: '', SUPERATOM_CELL_KEY: '', ...env } })
  .then((r) => JSON.parse(r.stdout.trim().split('\n').at(-1)!))

test("a cell, from its person's key with SA_ENGINE_MODE=cell: its own credential got once and kept; every setting set from it", async () => {
  const p = await platform(), home = mkdtempSync(join(tmpdir(), 'cell-'))
  try {
    const env = { SUPERATOM_KEY: KEY, SA_ENGINE_MODE: 'cell', SUPERATOM_HOME: home, SUPERATOM_PLATFORM: p.url, SA_HOST_NAME: 'vm-1' }
    const first = await start(env)
    assert.deepEqual(first, { m: 'cell', p: 'ana@x.io', proj: PID, key: 'sak_cell_key', hub: 'wss://hub.test', model: 'sk-proj-m-x', name: 'lab-cell' })
    assert.deepEqual(p.asked, [{ method: 'POST', url: `/api/projects/${PID}/cell`, auth: `Bearer ${KEY}`, body: { host: 'vm-1' } }])
    assert.equal(JSON.parse(readFileSync(join(home, 'cell.json'), 'utf8')).cellKey, 'sak_cell_key')
    assert.deepEqual(await start(env), first)   // started again: read back from the volume
    assert.equal(p.asked.length, 1)             // nothing asked again
  } finally { p.close() }
})

test("the project's engine by default, from a key holding project.manage: what it connects with, got once and kept; given settings win", async () => {
  const p = await platform(), home = mkdtempSync(join(tmpdir(), 'eng-'))
  try {
    const first = await start({ SUPERATOM_KEY: KEY, SUPERATOM_HOME: home, SUPERATOM_PLATFORM: p.url })
    assert.deepEqual(first, { m: null, p: null, proj: PID, key: 'engine-key-1', hub: 'wss://hub.test', model: null, name: 'lab' })
    assert.deepEqual(p.asked, [{ method: 'GET', url: `/api/projects/${PID}/engine-credentials`, auth: `Bearer ${KEY}` }])
    assert.equal((await start({ SUPERATOM_KEY: KEY, SUPERATOM_HOME: home, SUPERATOM_PLATFORM: p.url, ICA_HUB: 'wss://elsewhere.test' })).hub, 'wss://elsewhere.test')   // given: it wins
    assert.equal(p.asked.length, 1)
  } finally { p.close() }
})

test("changing the mode and starting again: each mode its own credential on the volume, never mixed", async () => {
  const p = await platform(), home = mkdtempSync(join(tmpdir(), 'both-'))
  try {
    const base = { SUPERATOM_KEY: KEY, SUPERATOM_HOME: home, SUPERATOM_PLATFORM: p.url }
    assert.equal((await start(base)).key, 'engine-key-1')
    assert.equal((await start({ ...base, SA_ENGINE_MODE: 'cell' })).key, 'sak_cell_key')
    assert.equal((await start(base)).key, 'engine-key-1')   // back: the engine's, read back
    assert.equal(p.asked.length, 2)
  } finally { p.close() }
})
