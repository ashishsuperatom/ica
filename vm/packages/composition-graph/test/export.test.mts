// The graph is the only source: exported as a knowledge file, it imports back to the same graph — every node, same hash.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openStore, governance as g, publishDraft, exportKnowledge, knowledgeSource, importDomains, graphAt } from '../src/node.ts'

const admin = { id: 'user:root', admin: true }

function sample() {
  const s = openStore(':memory:')
  importDomains(s, [
    { name: 'stock', title: 'Stock', description: 'what is on hand', intents: ['stock'], capabilities: [], tools: ['query'], settings: ['excess-multiple'], files: ['rule.mjs'],
      concepts: [
        { name: 'free-stock-is-stock-not-reserved', title: 'Free stock', form: 'sections', sections: [{ name: 'definitions', items: ['free = current − reserved'] }] },
        { name: 'shortage-and-excess', title: 'Shortage', form: 'sections', uses: ['free-stock-is-stock-not-reserved'], sections: [{ name: 'calculation', text: 'inventory\nshort where free < reorder' }] },
      ] },
    { name: 'buying', description: 'what to buy', capabilities: [], files: [], concepts: [{ name: 'free-stock-is-stock-not-reserved', title: 'Free stock', form: 'sections', sections: [{ name: 'definitions', items: ['free = current − reserved'] }] }] },
  ], (_d, f) => `// ${f}\nexport const x = 1\n`, { by: 'test' }, [{ name: 'excess-multiple', value: 3, description: 'excess above this × reorder point' }])
  // An intermediate concept, composed of atomic ones, named by a domain.
  g.write(s, admin, 'stock-basics', 'concept', { title: 'Stock basics', form: 'composed', concepts: ['free-stock-is-stock-not-reserved', 'shortage-and-excess'] })
  g.write(s, admin, 'stock', 'domain', { ...s.get<any>('stock')!.body, concepts: ['stock-basics'] })
  return s
}

test('an export imports back to the same graph: every node, the same hash; importing it again changes nothing', async () => {
  const s = sample()
  const x = exportKnowledge(s, undefined, 'draft')
  const dir = mkdtempSync(join(tmpdir(), 'export-'))
  writeFileSync(join(dir, 'index.mts'), knowledgeSource(x, 'now'))
  for (const [name, text] of Object.entries(x.files)) { mkdirSync(dirname(join(dir, name)), { recursive: true }); writeFileSync(join(dir, name), text) }
  const mod = await import(pathToFileURL(join(dir, 'index.mts')).href)
  const read = (d: string, f: string) => readFileSync(f.includes('/') ? join(dir, f) : join(dir, d.replace(/\s+/g, '-').toLowerCase(), f), 'utf8')
  const t = openStore(':memory:')
  importDomains(t, mod.domains, read, { by: 'test' }, mod.settings, Object.values(mod.concepts))
  const nodes = (st: typeof s) => st.names().filter((n) => n.kind !== 'agent' && n.kind !== 'map').map((n) => `${n.kind} ${n.name} ${n.hash}`).sort()
  assert.deepEqual(nodes(t), nodes(s))
  assert.ok(importDomains(s, mod.domains, read, { by: 'test' }, mod.settings, Object.values(mod.concepts)).every((r) => !r.changed))
})

test('an export at a version holds that version', () => {
  const s = sample()
  publishDraft(s, admin, 'first')
  g.write(s, admin, 'free-stock-is-stock-not-reserved', 'concept', { title: 'Free stock', form: 'sections', sections: [{ name: 'definitions', items: ['free = current − reserved, per plant'] }] })
  const v1 = exportKnowledge(s, graphAt(s, 'v1').upto, 'v1'), draft = exportKnowledge(s, undefined, 'draft')
  const text = (x: typeof v1) => JSON.stringify(x.concepts.find((c) => c.name === 'free-stock-is-stock-not-reserved'))
  assert.doesNotMatch(text(v1), /per plant/)
  assert.match(text(draft), /per plant/)
  assert.deepEqual(v1.concepts.map((c) => c.name), ['free-stock-is-stock-not-reserved', 'shortage-and-excess', 'stock-basics'])
})
