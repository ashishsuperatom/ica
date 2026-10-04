// A SHIPPED MIGRATION NEVER CHANGES. A database that applied a migration refuses to start if its text changes — so an
// edit, even to a comment, takes every such database down (it did, once: ProjectDO migration 21's comment). Fresh
// databases in tests apply everything happily and cannot see it; this lock can. Every migration's fingerprint is in
// shipped.lock.json: a changed one fails here, and so does one missing from the lock (add it with `pnpm lock`).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fingerprint } from '../src/index.ts'
import { LISTS } from './shipped-lists.mts'

const lock: Record<string, Record<string, string>> = JSON.parse(readFileSync(new URL('../shipped.lock.json', import.meta.url), 'utf8'))

test('no shipped migration has changed, and every migration is locked', () => {
  const problems: string[] = []
  for (const [db, list] of Object.entries(LISTS)) {
    for (const m of list) {
      const want = lock[db]?.[String(m.id)]
      if (!want) problems.push(`${db} migration ${m.id} ("${m.name}") is not in shipped.lock.json — run: pnpm -C vm/packages/migrate lock`)
      else if (want !== fingerprint(m)) problems.push(`${db} migration ${m.id} ("${m.name}") has changed since it was locked — a shipped migration is never edited; put the change in a new migration`)
    }
  }
  assert.deepEqual(problems, [])
})
