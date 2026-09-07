// ── MIGRATE: name-as-identity → index → content-addressed concept ────────────────────────────────────────
//
//   pnpm exec tsx apps/engine/tools/migrate-concept-index.mts <project-id> [--apply]
//
// Without --apply it reports what it WOULD do and changes nothing. Run it that way first: this rewrites the
// identity of every concept in a project, and a migration you cannot read before running is one you find out
// about afterwards.
//
// WHAT IT DOES, per live concept:
//   1. hash its body            → concept:<hash>, written once, never updated again
//   2. index its name           → index:<slug> → that hash
//   3. index each alias         → index:<alias> → the SAME hash   (an alias stops being a lesser name)
//   4. leave the old row        → removed only with --apply, after every pointer is in place
//
// ARCHIVED VERSIONS (`@vN`) become content-addressed too, and their names are NOT indexed — they are bodies
// that a name once pointed at. History moves to the index: "this phrase meant that body, until then".
import { NodeStore, upsertConcept } from '@superatom/node-store'
import { conceptHash, indexId, putIndex } from '../../../packages/node-store/src/concept.js'
import { join } from 'node:path'

const projectId = process.argv[2]
const APPLY = process.argv.includes('--apply')
if (!projectId) { console.error('usage: migrate-concept-index.mts <project-id> [--apply]'); process.exit(1) }

const root = process.env.ENGINE_STATE_DIR ?? join(process.cwd(), '.state')
const db = join(root, projectId, 'db', 'project.sqlite')
const store = new NodeStore(db)
console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} · ${db}\n`)

const rows = store.db.prepare("SELECT * FROM nodes WHERE kind='concept' ORDER BY valid_from").all() as any[]
const live = rows.filter(r => r.valid_to == null)
const arch = rows.filter(r => r.valid_to != null)
console.log(`  ${live.length} live · ${arch.length} archived\n`)

let bodies = 0, indexes = 0, collisions = 0
const seen = new Map<string, string>()

for (const r of [...live, ...arch]) {
  const props = typeof r.props === 'string' ? JSON.parse(r.props || '{}') : (r.props ?? {})
  const hash = conceptHash(props)
  const isLive = r.valid_to == null
  if (seen.has(hash)) { collisions++; if (collisions <= 3) console.log(`  same body, two rows: ${r.id}  ≡  ${seen.get(hash)}`) }
  else { seen.set(hash, r.id); bodies++ }

  // EVERY body is written, archived ones included. They are what a name USED to point at, and a program built
  // last week still refers to one — that is the whole reason for content addressing. What archived bodies do
  // NOT get is an index entry: no name points at them any more, so nothing finds them by searching, which is
  // the property the old `valid_to` was providing.
  const names = isLive ? [r.label, ...(Array.isArray(props.aliases) ? props.aliases : [])].filter(Boolean) : []
  indexes += names.length
  if (isLive && live.indexOf(r) < 3) console.log(`  ${r.label}\n    → ${hash}\n    ← ${names.map(n => indexId(n)).join('\n    ← ')}`)

  if (APPLY) {
    if (!store.getNode(hash)) {
      store.putNode({ id: hash, kind: 'concept', label: r.label, summary: r.summary ?? undefined, props })
      // A body has no validity window: it simply exists, for ever. The window moved to the index, which is
      // where it always belonged — "what did this name mean, when".
      store.db.prepare('UPDATE nodes SET valid_from=?, valid_to=NULL WHERE id=?').run(r.valid_from ?? Date.now(), hash)
    }
    for (const n of names) putIndex(store, n, hash, { changedBy: 'migration', reason: 'name-as-id → index' })
  }
}

if (APPLY) {
  // The old rows go LAST, once every pointer resolves — so an interrupted migration leaves a project that
  // still answers, with both models present, rather than one with no concepts at all.
  const old = store.db.prepare("SELECT id FROM nodes WHERE kind='concept' AND id NOT LIKE 'concept:%' ").all() as any[]
  const stale = rows.filter(r => !/^concept:[0-9a-f]{16}$/.test(r.id)).map(r => r.id)
  for (const id of stale) store.db.prepare('DELETE FROM nodes WHERE id=?').run(id)
  console.log(`\n  removed ${stale.length} name-addressed rows (${old.length} other)`)
}

console.log(`\n  ${bodies} distinct bodies · ${indexes} index entries · ${collisions} duplicate bodies`)
console.log(APPLY ? '\n  APPLIED' : '\n  dry run — re-run with --apply to write')
