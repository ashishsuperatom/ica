import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { serveTools, askSocket } from '../tool-socket.ts'

test('a turn\'s own tool is answered only while the engine runs that turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-'))   // short: a socket's path is at most ~100 characters
  const t = serveTools(join(dir, 'run', 'tools.sock'), { verify: () => { throw new Error('no ticket here') } })
  after(() => t.close())   // the server never keeps the test running, whatever fails
  await new Promise((r) => setTimeout(r, 100))
  const script = join(dir, 'tool.mjs')
  writeFileSync(script, `${askSocket(t.path, dir)}\nask('find-intent', { question: process.argv[2] }).then((r) => console.log(JSON.stringify(r)))`)
  writeFileSync(join(dir, '.turn'), 'q1')
  // a child of its own (the server answers in this process, so the test never blocks waiting on it)
  const run = async () => JSON.parse((await promisify(execFile)(process.execPath, [script, 'hello'], { cwd: dir, env: { PATH: process.env.PATH ?? '' }, timeout: 10_000 })).stdout)
  assert.match((await run()).error, /only during your turn/)
  const off = t.on('q1', 'find-intent', async (a) => `got ${a.question}`)
  assert.equal((await run()).text, 'got hello')
  off(); assert.match((await run()).error, /only during your turn/)
})
