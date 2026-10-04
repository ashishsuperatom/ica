// Add every migration not yet in shipped.lock.json. An existing entry is never rewritten: a changed migration is a
// mistake to undo, not to lock again.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fingerprint } from './src/index.ts'
import { LISTS } from './test/shipped-lists.mts'

const file = new URL('./shipped.lock.json', import.meta.url)
const lock: Record<string, Record<string, string>> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
let added = 0
for (const [db, list] of Object.entries(LISTS)) {
  lock[db] ??= {}
  for (const m of list) if (!lock[db][String(m.id)]) { lock[db][String(m.id)] = fingerprint(m); added++; console.log(`locked ${db} ${m.id} (${m.name})`) }
}
writeFileSync(file, JSON.stringify(lock, null, 2) + '\n')
console.log(`${added} added`)
