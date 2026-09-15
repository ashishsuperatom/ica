// The semantic-graph tool as a person or an agent runs it: commands build a model through checked operations, refusals
// exit 2 with the reason, reading commands draw the graph, and export and import move a model between stores.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prompt, run } from '../src/cli.js'

test('building, refusing, reading, exporting and importing a model with the tool', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-cli-'))
  const out: string[] = []
  const sg = (...args: string[]) => run([...args, '--db', join(dir, 'g.sqlite'), '--model', 'shop', '--by', 'tester'], (s) => out.push(s))
  assert.equal(await sg('create-model', 'shop'), 0)
  for (const cmd of [
    ['add-entity', 'Store', '--synonyms', 'shop, outlet'], ['add-entity', 'Region'], ['add-arrow', 'Store.region', 'Region'],
    ['add-calendar', 'Day', '--level', 'day'], ['add-fact', 'Sale', '--description', 'A product sold in a store on a day.'],
    ['add-arrow', 'Sale.store', 'Store'], ['add-arrow', 'Sale.day', 'Day'],
    ['add-measure', 'Sale.units', '--unit', 'units', '--kind', 'flow', '--aggregate', 'sum', '--reason', 'the count a till records'],
    ['add-attribute', 'Store.opened', '--type', 'date'],
    ['add-condition', 'new store', '--on', 'Store', '--where', '[{"attribute":"opened","range":{"from":"2026-01-01"}}]'],
  ]) assert.equal(await sg(...cmd), 0, `${cmd.join(' ')}: ${out.at(-1)}`)
  out.length = 0
  assert.equal(await sg('add-entity', 'Outlet'), 2)
  assert.match(out.at(-1)!, /refused: "Outlet" already means Store/)
  assert.equal(await sg('remove', 'Region'), 2)
  assert.match(out.at(-1)!, /still used: the arrow Store.region leads to it/)
  out.length = 0
  assert.equal(await sg('dimensions', 'Sale'), 0)
  assert.match(out.join('\n'), /Region\s+entity\s+via store.region/)
  out.length = 0
  assert.equal(await sg('history', 'Sale.units'), 0)
  assert.match(out.join('\n'), /add-measure Sale.units\s+by tester — the count a till records/)
  assert.equal(await sg('check'), 0)
  assert.equal(await sg('export', join(dir, 'out')), 0)
  const other = (...args: string[]) => run([...args, '--db', join(dir, 'other.sqlite'), '--model', 'shop', '--by', 'tester'], (s) => out.push(s))
  out.length = 0
  assert.equal(await other('import', join(dir, 'out')), 0, out.join('\n'))
  out.length = 0
  await other('show', 'Sale', '--json')
  assert.equal(JSON.parse(out.join('\n')).measures[0].name, 'units')
})

test('the prompt covers every command, and its version follows its content', async () => {
  const p = prompt()
  for (const cmd of ['add-entity', 'add-measure', 'promote-attribute', 'dimensions', 'history', 'export']) assert.match(p.text, new RegExp(`semantic-graph ${cmd}`))
  assert.match(p.version, /^[0-9a-f]{12}$/)
  const out: string[] = []
  assert.equal(await run(['prompt', '--json'], (s) => out.push(s)), 0)
  assert.deepEqual(JSON.parse(out.join('\n')), p)
})
