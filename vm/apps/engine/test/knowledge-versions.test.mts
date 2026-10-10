// A session reads the knowledge at one version: the published one, or — pinned — the draft or an earlier version, so a
// change is tried before it is published and a question asked of v1 and of v5 can be compared.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, governance as g, publishDraft } from '@superatom/composition-graph/node'
import { compose, pick, domainsOf } from '../knowledge.ts'

const admin = { id: 'user:root', admin: true }
const concept = (t: string) => ({ title: 'Stock', form: 'text', text: t })

test('compose and route read the published version; pinned, the draft or a named one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-')); mkdirSync(join(dir, 'db'))
  const s = openStore(join(dir, 'db', 'composition.sqlite'))
  g.write(s, admin, 'stock-meaning', 'concept', concept('free stock is stock not reserved'))
  g.write(s, admin, 'inventory', 'domain', { capabilities: [], concepts: ['stock-meaning'], files: [], intents: ['stock'] })
  publishDraft(s, admin, 'first')
  g.write(s, admin, 'stock-meaning', 'concept', concept('free stock is current minus reserved, per plant'))
  g.write(s, admin, 'suppliers', 'domain', { capabilities: [], concepts: ['stock-meaning'], files: [], intents: ['supplier'] })
  s.close()

  const inv = (await domainsOf(dir)).find((d) => d.name === 'inventory')!
  const v1 = await compose(dir, inv)
  assert.equal(v1.graph, 'v1'); assert.match(v1.text, /stock not reserved/)
  const draft = await compose(dir, inv, 'draft')
  assert.equal(draft.graph, 'draft'); assert.match(draft.text, /per plant/)
  assert.equal((await compose(dir, inv, 'v1')).graph, 'v1')
  // A domain added since v1 exists only in the draft: routing at v1 cannot reach it.
  assert.deepEqual((await domainsOf(dir)).map((d) => d.name), ['inventory'])
  assert.equal((await pick(dir, 'which supplier', 'draft')).domain?.name, 'suppliers')
  assert.notEqual((await pick(dir, 'which supplier')).domain?.name, 'suppliers')
  await assert.rejects(() => compose(dir, inv, 'v7'), /there is no version "v7"/)
})
