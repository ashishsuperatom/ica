// ── CLEAR EVERY CONCEPT FROM A PROJECT STORE ──────────────────────────────────────────────────────────────
//
//   tsx tools/reset-concepts.mts <project.sqlite> [--apply]
//
// For a project that should start with no concepts and let the modeller write them from its own analyses.
//
// THIS IS A RESET, NOT AN OPERATION. Everything else in this system is additive: a concept is immutable, an
// edit mints a new body, a rename repoints, and the old body stays because a program built on it is still
// true. That property is what makes the store trustworthy, and it is exactly what this tool breaks. It exists
// for one moment in a project's life — before anyone has come to depend on anything — and running it later
// falsifies the record of every program that was built from what it removes.
//
// WHAT GOES: concept bodies, every name that reaches one (live and archived, so history goes too rather than
// dangling), the edges tying programs to them, and the derived run, sample and signature tables.
//
// WHAT STAYS: intents, programs, units, the datasource index, retrieval state, and the schema itself — the
// full-text index and every table are recreated on the next open, so a cleared store is a working store.
//
// It refuses nothing and asks nothing, so it prints what it would remove and does nothing until --apply.

import { NodeStore } from '@superatom/node-store'

const [dbPath, ...flags] = process.argv.slice(2)
if (!dbPath) { console.error('usage: tsx tools/reset-concepts.mts <project.sqlite> [--apply]'); process.exit(1) }
const APPLY = flags.includes('--apply')

const store = new NodeStore(dbPath)
const one = (sql: string) => (store.db.prepare(sql).get() as any)?.n ?? 0

const counts = {
  'concept bodies':          one(`SELECT COUNT(*) n FROM nodes WHERE kind='concept'`),
  'names (live)':            one(`SELECT COUNT(*) n FROM nodes WHERE kind='index' AND valid_to IS NULL`),
  'names (archived)':        one(`SELECT COUNT(*) n FROM nodes WHERE kind='index' AND valid_to IS NOT NULL`),
  'edges to/from concepts':  one(`SELECT COUNT(*) n FROM edges
                                   WHERE from_id IN (SELECT id FROM nodes WHERE kind='concept')
                                      OR to_id   IN (SELECT id FROM nodes WHERE kind='concept')`),
  'run records':             one(`SELECT COUNT(*) n FROM concept_run`),
  'samples':                 one(`SELECT COUNT(*) n FROM concept_sample`),
  'signatures':              one(`SELECT COUNT(*) n FROM concept_signature`),
}
for (const [what, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(6)}  ${what}`)

// PROGRAMS THAT WERE BUILT FROM ONE. Named rather than counted, because this is the cost of the reset: their
// record of what they were built from stops resolving, and a person should see whose work that is.
const orphaned = store.db.prepare(`
  SELECT DISTINCT n.label FROM edges e JOIN nodes n ON n.id = e.from_id
   WHERE e.to_id IN (SELECT id FROM nodes WHERE kind='concept') AND n.kind = 'program'`).all() as any[]
if (orphaned.length) {
  console.log(`\n${orphaned.length} program(s) recorded being built from a concept; that record will no longer resolve:`)
  for (const p of orphaned) console.log(`     ${p.label}`)
}

if (!APPLY) { console.log('\nDry run. Nothing was removed — pass --apply.'); store.close(); process.exit(0) }

store.db.transaction(() => {
  store.db.exec(`
    DELETE FROM edges WHERE from_id IN (SELECT id FROM nodes WHERE kind='concept')
                         OR to_id   IN (SELECT id FROM nodes WHERE kind='concept');
    DELETE FROM nodes WHERE kind IN ('concept', 'index');
    DELETE FROM concept_run;
    DELETE FROM concept_sample;
    DELETE FROM concept_signature;`)
})()

// The full-text index is external-content, so it is rebuilt from what remains rather than left holding rows
// whose nodes are gone.
store.db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild');`)

console.log(`\nCleared. ${one(`SELECT COUNT(*) n FROM nodes WHERE kind='concept'`)} concepts, ` +
            `${one(`SELECT COUNT(*) n FROM nodes WHERE kind='index'`)} names remain.`)
store.close()
