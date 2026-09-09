// Run a directory of migrated concepts against live data and save the ones that pass.
//
//   tsx tools/run-migration.mts <dir> <project.sqlite> <paramsJson> [--apply]
//
// Nothing is saved without running, and nothing that fails is saved at all — the same rule the authoring
// tool enforces, applied in bulk. Dry by default: a migration that writes before you have read the values it
// produced is a migration you cannot check.
import { NodeStore } from '@superatom/node-store'
import { tryConcept } from '../concepts/runner.js'
import { saveConcept, managerSignSql } from '../concepts/save.js'
import { query } from '@superatom/scaffold'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const [dir, dbPath, paramsJson, ...flags] = process.argv.slice(2)
if (!dir || !dbPath) { console.error('usage: tsx tools/run-migration.mts <dir> <db> <paramsJson> [--apply]'); process.exit(1) }
const APPLY = flags.includes('--apply')
const PARAMS = paramsJson ? JSON.parse(paramsJson) : {}
const MANAGER = process.env.DATASOURCE_URL || 'http://localhost:4000'

const store = new NodeStore(dbPath)
const files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')).sort()
let ok = 0, failed = 0

for (const f of files) {
  const name = f.replace(/\.mjs$/, '')
  // Per-concept parameters, falling back to a shared set — most concepts in a batch want the same window.
  const params = PARAMS[name] ?? PARAMS._ ?? {}
  // A migration runs queries nobody has tuned, against whatever the source is doing today. The authoring
  // default is right for someone iterating; a bulk pass needs longer before it calls a slow query a hang.
  const r = await tryConcept({ file: join(dir, f), params, store, timeoutMs: 10 * 60_000,
                               query: (s, sql, p) => query(s, sql, p) })
  if (!r.ok) {
    failed++
    console.log(`✗ ${name}\n    ${String(r.error).split('\n')[0].slice(0, 150)}`)
    continue
  }
  ok++
  const v = r.result?.value
  const shown = typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : JSON.stringify(v)
  console.log(`✓ ${name}  value=${shown}  rows=${r.result?.distribution?.length ?? 0}  ${r.verifications.length} invariant(s)  ${r.ms}ms`)
  for (const c of r.caveats) console.log(`      ⚠ ${c}`)
  if (APPLY) {
    const s = await saveConcept(store, r.runId, { changedBy: 'migration', reason: 'migrated from prose to a runnable concept' },
                                managerSignSql(MANAGER))
    if (!s.ok) console.log(`      ✗ not saved — ${s.reason}`)
  }
}
console.log(`\n${ok} ran, ${failed} failed${APPLY ? ' · saved the ones that ran' : ' · dry run, nothing saved'}`)
store.close()
