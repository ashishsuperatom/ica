import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store, importDomains, verifyGraph, verifyAgainst } from '../src/index.ts'

const by = { by: 'test' }
const part = (t: string) => ({ title: t, form: 'bullets' as const, items: [t] })
const settings = [{ name: 'reporting-currency-code', value: 'INR', description: 'the currency' }, { name: 'rate-ceiling-rupees', value: 5, description: 'a ceiling' }]
const texts: Record<string, string> = {
  'a/rule.mjs': "import { setting } from './helper.mjs'\nimport { query } from './data/query.mjs'\nconst c = setting('reporting-currency-code')",
  'shared/helper.mjs': "export const setting = (n) => n",
}
const read = (d: string, f: string) => texts[f.includes('/') ? f : `${d.replace(/\s+/g, '-')}/${f}`] ?? `// ${f}`
const good = [{ name: 'a', description: 'about a', intents: ['a'], capabilities: [], parts: [part('Definitions')], files: ['rule.mjs', 'shared/helper.mjs'], settings: ['reporting-currency-code'] }]
const fails = (fs: ReturnType<typeof verifyGraph>) => fs.filter((f) => f.level === 'fail').map((f) => `${f.check}: ${f.says}`)

test('a graph that holds together, and holds what was written, has no failures', () => {
  const s = new Store(':memory:')
  importDomains(s, good, read, by, settings)
  assert.deepEqual(fails(verifyGraph(s)), [])
  assert.deepEqual(fails(verifyAgainst(s, good, read, settings)), [])
  // the ceiling no domain uses is a warning, not a failure
  assert.ok(verifyGraph(s).some((f) => f.level === 'warn' && f.subject === 'rate-ceiling-rupees'))
})

test('a file importing one its domain does not place fails', () => {
  const s = new Store(':memory:')
  importDomains(s, [{ ...good[0], files: ['rule.mjs'] }], read, by, settings)
  assert.ok(fails(verifyGraph(s)).some((x) => /imports \.\/helper\.mjs/.test(x)))
})

test('a file reading a setting its domain does not give fails', () => {
  const s = new Store(':memory:')
  importDomains(s, [{ ...good[0], settings: [] }], read, by, settings)
  assert.ok(fails(verifyGraph(s)).some((x) => /reads the setting "reporting-currency-code"/.test(x)))
})

test('a domain naming a node that is gone, or of another kind, fails', () => {
  const s = new Store(':memory:')
  importDomains(s, good, read, by, settings)
  s.remove('a/definitions', by)
  assert.ok(fails(verifyGraph(s)).some((x) => /names part "a\/definitions", which the graph does not hold/.test(x)))
})

test('the graph and the written knowledge disagreeing fails, both ways', () => {
  const s = new Store(':memory:')
  importDomains(s, good, read, by, settings)
  const changed = [{ ...good[0], parts: [{ title: 'Definitions', form: 'bullets' as const, items: ['a means something else now'] }] }]
  assert.ok(fails(verifyAgainst(s, changed, read, settings)).some((x) => /a\/definitions|differs|import the knowledge/.test(x)))
  s.put('stray/part', 'part', part('Stray'), by)
  assert.ok(verifyAgainst(s, good, read, settings).some((f) => f.level === 'warn' && f.subject === 'stray/part'))
})

test('two files a domain places under one name fail', () => {
  const s = new Store(':memory:')
  importDomains(s, [{ ...good[0], files: ['rule.mjs', 'shared/helper.mjs', 'other/rule.mjs'] }], (d, f) => read(d, f), by, settings)
  assert.ok(fails(verifyGraph(s)).some((x) => /places two files named rule\.mjs/.test(x)))
})
