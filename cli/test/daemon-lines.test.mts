// The background connection's local socket carries one JSON line each way. A long line arrives in many reads; a
// character of several bytes can be split between two of them. Decoding each read alone turned such a character into
// replacement characters — it damaged one copy of a concept in a large knowledge import, which the platform then
// refused as "written two ways". Every line must arrive exactly as written.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, createConnection } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onLines } from '../src/daemon.ts'

test('a long line of many-byte characters crosses the local socket whole, however it is split into reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lines-'))
  const path = join(dir, 's.sock')
  // characters of 2, 3 and 4 bytes at every offset, far past one read (several hundred KB)
  const unit = 'a→₹—é😀'
  const lines = [unit.repeat(40_000), 'x' + unit.repeat(30_001), JSON.stringify({ text: 'Revenue → ₹54.35 lakh — 😀'.repeat(9_000) })]
  const got: string[] = []
  const server = createServer((s) => onLines(s, (l) => { got.push(l); if (got.length === lines.length) s.end() }))
  await new Promise<void>((r) => server.listen(path, r))
  try {
    await new Promise<void>((resolve, reject) => {
      const c = createConnection(path, () => { for (const l of lines) c.write(l + '\n') })
      c.on('close', () => resolve()); c.on('error', reject)
    })
    assert.equal(got.length, lines.length)
    got.forEach((l, i) => { assert.ok(!l.includes('�'), `line ${i} has a replacement character`); assert.equal(l, lines[i]) })
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }) }
})
