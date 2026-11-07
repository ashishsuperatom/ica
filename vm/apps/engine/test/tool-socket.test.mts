import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { serveTools, askSocket, toolSocketOf } from '../tool-socket.ts'

// Run on Linux, macOS and Windows (.github/workflows/tool-server.yml): a socket file, or a named pipe on Windows.
test('a turn\'s own tool is answered only while the engine runs that turn; a ticketed one only for a ticket the engine accepts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ts-'))   // short: a socket's path is at most ~100 characters
  const t = serveTools(toolSocketOf(dir), { verify: (raw: string) => { if (raw !== 'good') throw new Error('your data access ticket is not valid'); return raw } })
  t.serve<string>('find-schema', async (args, ticket) => `${ticket}:${JSON.stringify(args)}`)
  after(() => t.close())   // the server never keeps the test running, whatever fails
  await new Promise((r) => setTimeout(r, 100))
  const script = join(dir, 'tool.mjs')
  writeFileSync(script, `${askSocket(t.path, dir)}\nask('find-intent', { question: process.argv[2] }).then((r) => console.log(JSON.stringify(r)))`)
  writeFileSync(join(dir, '.turn'), 'q1')
  // a child of its own (the server answers in this process, so the test never blocks waiting on it)
  const run = async () => JSON.parse((await promisify(execFile)(process.execPath, [script, 'hello'], { cwd: dir, timeout: 10_000 })).stdout)
  assert.match((await run()).error, /only during your turn/)
  const off = t.on('q1', 'find-intent', async (a) => `got ${a.question}`)
  assert.equal((await run()).text, 'got hello')
  off(); assert.match((await run()).error, /only during your turn/)
  // a ticketed tool: answered for the ticket the engine accepts, refused for any other
  const ticketed = join(dir, 'ticketed.mjs')
  writeFileSync(ticketed, `${askSocket(t.path, dir)}\nask('find-schema', process.argv.slice(2)).then((r) => console.log(JSON.stringify(r)))`)
  const runT = async () => JSON.parse((await promisify(execFile)(process.execPath, [ticketed, 'vendor'], { cwd: dir, timeout: 10_000 })).stdout)
  writeFileSync(join(dir, '.ticket'), 'good'); assert.equal((await runT()).text, 'good:["vendor"]')
  writeFileSync(join(dir, '.ticket'), 'forged'); assert.match((await runT()).error, /not valid/)
})
