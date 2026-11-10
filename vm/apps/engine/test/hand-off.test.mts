import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { handOffIn, sendTool, HANDS_TO, decisionIn } from '../agents/composer/index.ts'

test('a hand-off goes only down the hierarchy: the composer to the analyst or the connector, they to no one', () => {
  assert.deepEqual(HANDS_TO, { composer: ['analyst', 'connector'], analyst: [], workbench: [], connector: [] })   // the workbench takes its own messages: it hands to no one
  const line = 'Sent current-question to the analyst: it answers the person. Your turn is over.'
  assert.deepEqual(handOffIn(`some output\n${line}\n`, 'composer'), { agent: 'analyst', message: 'current-question' })
  assert.equal(handOffIn(line, 'analyst'), null)   // the analyst never hands off
  assert.equal(handOffIn(line.replace('analyst', 'composer'), 'composer'), null)   // never up the hierarchy, nor to itself
  assert.equal(handOffIn(line.replace('current-question', 'anything'), 'composer'), null)   // only known terms
  assert.equal(handOffIn('Sent to the analyst', 'composer'), null)
})

test('the tool itself says the hand-off the engine takes — and refuses anyone it may not hand to', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ho-')), tool = join(dir, 'send-to-agent')
  writeFileSync(tool, sendTool(process.execPath, HANDS_TO.composer)); chmodSync(tool, 0o755)
  const run = (...a: string[]) => promisify(execFile)(tool, a, { cwd: dir, env: { PATH: process.env.PATH ?? '' } }).then((r) => r.stdout, (e) => `refused: ${e.stdout}`)
  assert.deepEqual(handOffIn(await run('analyst', 'current-question'), 'composer'), { agent: 'analyst', message: 'current-question' })
  assert.match(await run('composer', 'current-question'), /^refused: you may send to: analyst, connector/)
  assert.match(await run('analyst', 'the whole question'), /^refused: send one of: current-question/)
})

test("the composer's decision line is read with whatever it says after it on the line; the last one counts", () => {
  assert.deepEqual(decisionIn(':::node in-mwarpqtrfh1k0x'), { node: 'in-mwarpqtrfh1k0x' })
  assert.deepEqual(decisionIn(':::node in-mwarpqtrfh1k0x — it is exactly this intent, read for this year'), { node: 'in-mwarpqtrfh1k0x' })
  assert.deepEqual(decisionIn('text\n:::node same: it continues it\nmore'), { node: 'same' })
  assert.deepEqual(decisionIn(':::node NEW.'), { node: 'new' })
  assert.deepEqual(decisionIn(':::node new\n:::node in-abc'), { node: 'in-abc' })
  assert.deepEqual(decisionIn('we decided :::node in-abc in passing'), { node: null })   // only a line of its own
})
