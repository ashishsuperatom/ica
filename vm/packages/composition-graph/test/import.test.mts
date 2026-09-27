import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, compose, importDomains } from '../src/index.ts'

const by = { by: 'test' }
const shared = { name: 'shared/organisation', title: 'Organisation', form: 'bullets' as const, items: ['one source'] }
const written = [
  { name: 'a', capabilities: ['x'], parts: [shared, { title: 'Definitions', form: 'bullets' as const, items: ['a means a'] }], files: ['a.mjs'], tools: ['query'] },
  { name: 'b', capabilities: ['y'], parts: [shared, { title: 'Definitions', form: 'bullets' as const, items: ['b means b'] }] },
]
const read = (d: string, f: string) => `// ${d}/${f}`

test('a named part is one node both domains name; the rest are each domain\'s own', () => {
  const s = new Store(':memory:')
  importDomains(s, written, read, by)
  assert.deepEqual(s.names('part').map((n) => n.name), ['a/definitions', 'b/definitions', 'shared/organisation'])
  assert.deepEqual((s.get('a')!.body as any).parts, ['shared/organisation', 'a/definitions'])
  assert.deepEqual((s.get('b')!.body as any).parts, ['shared/organisation', 'b/definitions'])
  assert.equal((s.get('shared/organisation')!.body as any).name, undefined)   // the name is the pointer, not the content
  assert.match(compose(s, 'b').text, /# Organisation\n- one source\n\n# Definitions\n- b means b$/)
})

test('an edit to the shared part reaches every domain that names it, as one change', () => {
  const s = new Store(':memory:')
  importDomains(s, written, read, by)
  s.put('shared/organisation', 'part', { title: 'Organisation', form: 'bullets', items: ['one source, now two'] }, { by: 'ana', reason: 'a second source' })
  assert.match(compose(s, 'a').text, /one source, now two/)
  assert.match(compose(s, 'b').text, /one source, now two/)
  assert.equal(s.history('shared/organisation').length, 2)
})

test('importing again changes nothing; a shared part written two ways is refused', () => {
  const s = new Store(':memory:')
  importDomains(s, written, read, by)
  assert.ok(importDomains(s, written, read, by).every((r) => !r.changed))
  const twoWays = [written[0], { ...written[1], parts: [{ ...shared, items: ['another text'] }] }]
  assert.throws(() => importDomains(new Store(':memory:'), twoWays, read, by), /written two ways/)
})

test('a file listed by its path is one node every domain that lists it shares, placed under its file name', () => {
  const s = new Store(':memory:')
  const withShared = [{ ...written[0], files: ['a.mjs', 'shared/rates.mjs'] }, { ...written[1], files: ['shared/rates.mjs'] }]
  importDomains(s, withShared, (d, f) => (f.includes('/') ? `// ${f}` : `// ${d}/${f}`), by)
  assert.deepEqual(s.names('file').map((n) => n.name), ['a/a.mjs', 'shared/rates.mjs'])
  assert.deepEqual(compose(s, 'b').files.map((f) => f.name), ['rates.mjs'])
  assert.match(compose(s, 'a').text, /In your folder, from this domain: a\.mjs, rates\.mjs\.$/)
})
