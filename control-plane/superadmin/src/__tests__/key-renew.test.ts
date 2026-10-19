// ONE RELEASE ONLY (docs/one-door-plan.md, step 4): a key of the old shape (sak_<project>_<secret>, checked by its hash in
// the project) renews itself into the new one (sak_<project>_<person>_<secret>, its hash kept by its person's UserDO) —
// the same key: id, name, capabilities, maker, the key that made it. The old secret stops working at once.
// Removed with the old shape.

import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { AgentKeys, sha256 } from '../agent-keys'

const PID = '0d000d00-0000-4000-8000-000000000002'
const PERSON = 'a'.repeat(32)

function store() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE agent_keys (id TEXT PRIMARY KEY, name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, capabilities TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT, revoked_by TEXT, last_used_at TEXT, made_by_key TEXT, acts_as TEXT)`)
  const sql = { exec: (q: string, ...p: unknown[]) => (/^\s*select/i.test(q) ? db.prepare(q).all(...(p as any[])) : (db.prepare(q).run(...(p as any[])), [])) as Iterable<Record<string, unknown>> }
  return { db, keys: new AgentKeys(sql, () => PID) }
}

describe('renewing a key of the old shape', () => {
  it('the same key, a new secret that names its person; the old one stops working', async () => {
    const { db, keys } = store()
    const old = `sak_${PID}_${'x'.repeat(43)}`
    db.prepare("INSERT INTO agent_keys (id, name, prefix, hash, capabilities, created_by, created_at, made_by_key) VALUES ('key_parent1', 'parent', 'p', 'h0', '[]', 'ana@x.io', 't', NULL)").run()
    db.prepare('INSERT INTO agent_keys (id, name, prefix, hash, capabilities, created_by, created_at, made_by_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('key_old0001', 'loader', old.slice(0, 47), await sha256(old), '["project.view"]', 'ana@x.io', '2026-10-01T00:00:00Z', 'key_parent1')
    expect(await keys.verify(old)).toMatchObject({ ok: true })

    const r = await keys.renew('key_old0001', PERSON)
    expect(r.key).toMatch(new RegExp(`^sak_${PID}_${PERSON}_[A-Za-z0-9_-]{43}$`))
    expect(r.hash).toBe(await sha256(r.key))
    expect(r.record).toMatchObject({ id: 'key_old0001', name: 'loader', capabilities: ['project.view'], created_by: 'ana@x.io', made_by_key: 'key_parent1' })
    expect(await keys.verify(old)).toMatchObject({ ok: false, reason: 'unknown key' })     // the old secret: gone
    expect(await keys.verify(r.key)).toMatchObject({ ok: false, reason: 'unknown key' })   // the new one is checked by its person's UserDO, never here
  })

  it('a revoked key is not renewed', async () => {
    const { db, keys } = store()
    db.prepare("INSERT INTO agent_keys (id, name, prefix, hash, capabilities, created_by, created_at, revoked_at) VALUES ('key_gone001', 'gone', 'p', 'h1', '[]', 'ana@x.io', 't', 't')").run()
    await expect(keys.renew('key_gone001', PERSON)).rejects.toThrow(/not renewed/)
  })
})
