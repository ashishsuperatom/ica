// What a connector says about its source (src/contract.ts "WHAT A CONNECTOR SAYS"): its keys and how its tables join, in
// its description; and a signature per table that changes exactly when its columns do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apiConnector, signatureOf } from '../src/api.ts'
import type { Field } from '../src/contract.ts'

test('a signature: the same columns in any order, the same; a column added, renamed or retyped, another', () => {
  const s = signatureOf(['id:integer', 'name:string'])
  assert.equal(signatureOf(['name:string', 'id:integer']), s)
  assert.notEqual(signatureOf(['id:integer', 'name:string', 'email:string']), s)
  assert.notEqual(signatureOf(['id:integer', 'full_name:string']), s)
  assert.notEqual(signatureOf(['id:string', 'name:string']), s)
})

test("an API connector's description carries its keys, its links and what may be empty; its signatures follow its fields", async () => {
  let fields: Field[] = [{ name: 'id', type: 'string', key: true }, { name: 'account_id', type: 'string', references: 'accounts.id', nullable: true }]
  const make = apiConnector('t', { description: 'a test', test: async () => 'ok', entities: async () => [{ name: 'contacts', fields }], read: { '*': async () => ({ rows: [] }) } })
  const c = make({}) as any
  const d = await c.introspect()
  assert.deepEqual(d.tables[0].columns, [{ name: 'id', type: 'string', key: true }, { name: 'account_id', type: 'string', references: 'accounts.id', nullable: true }])
  const before = (await c.signatures()).contacts
  fields = [...fields, { name: 'email', type: 'string' }]
  assert.notEqual((await c.signatures()).contacts, before)
})
