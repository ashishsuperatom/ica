// Building the DATASOURCE INDEX — ONE implementation, two callers: the bootstrap CLI
// (scripts/build-datasource-index.ts) and the admin console, which triggers it live over the hub. Having the
// admin path re-implement this is how the two would drift, so the CLI is a thin wrapper around this function.
//
// RESUMABLE by construction: the index IS the done-state. Enumerate every container first, skip the ones already
// indexed, persist per container. Re-running after a failure continues where it stopped.
//
// Progress is reported through `log` rather than printed, so the same run can go to a terminal or to an admin's
// screen without the builder knowing which.
import { DataSourceIndex, putEntries, applyRowCounts, dataSourceStats, ensureDataSourceIndex } from '@superatom/datasource-index'
import { getIndexer } from './indexer.js'

export interface BuildOpts {
  store: DataSourceIndex
  managerUrl: string
  seedTables?: Record<string, string[]>   // per-source table hints (a source with no catalog to enumerate)
  only?: string                           // one source id, else every source the manager knows
  wipe?: boolean                          // start that source's index empty instead of resuming
  log?: (line: string) => void
}

export interface BuildResult {
  // `skipped` = genuinely returned no fields. `failed` = could not be read, which is NOT the same and must
  // never be reported as emptiness — see step 2.
  sources: Array<{ id: string; dialect: string; containers: number; indexed: number; fields: number; skipped: number; failed?: number; error?: string }>
  totals: unknown
}

export async function buildDatasourceIndex(opts: BuildOpts): Promise<BuildResult> {
  const { store, managerUrl } = opts
  const log = opts.log ?? (() => {})
  const seeds = opts.seedTables ?? {}

  const rawQuery = async (id: string, sql: string): Promise<any[]> => {
    const r = await fetch(managerUrl + '/query', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, sql, raw: true }),   // raw: the trusted system path — no rewrite, no row cap
    })
    const j: any = await r.json()
    if (j.error) throw new Error(j.error)
    return j.rows || []
  }

  // THE SCHEMA MUST EXIST BEFORE ANYTHING TOUCHES IT. Every read and write helper in @superatom/datasource-index calls this
  // first, but the two statements below go at the table directly — the resume read and the wipe — so on a
  // database that has never held an index, the build died on its first act with "no such table:
  // datasource_index". Invisible for as long as every box happened to have an old table already; the first
  // genuinely fresh volume hit it immediately, which is what a fresh volume is for.
  ensureDataSourceIndex(store)

  let sources: Array<{ id: string; dialect: string }> =
    await (await fetch(managerUrl + '/sources')).json().then((j: any) => j.sources || [])
  if (opts.only) sources = sources.filter(s => s.id === opts.only)

  if (opts.wipe) {
    store.db.exec('DELETE FROM datasource_index' + (opts.only ? ` WHERE source='${opts.only.replace(/'/g, "''")}'` : ''))
    log(`cleared the existing index${opts.only ? ` for ${opts.only}` : ''}`)
  }

  const result: BuildResult['sources'] = []
  for (const s of sources) {
    log(`— ${s.id} [${s.dialect}] —`)
    let indexer
    try { indexer = getIndexer(s.dialect) }
    catch (e: any) { log(`  ${e.message}`); result.push({ id: s.id, dialect: s.dialect, containers: 0, indexed: 0, fields: 0, skipped: 0, failed: 0, error: e.message }); continue }

    // STEP 1 — enumerate every container BEFORE indexing any, so progress is a known fraction.
    // The source's own catalog is the primary list; seeds and type-specific fallbacks fill in where there is none.
    log('  step 1 · enumerating tables…')
    let catalogTables: string[] | undefined
    try {
      const j: any = await (await fetch(managerUrl + '/introspect', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id }),
      })).json()
      const t = (j.tables || []).map((x: any) => String(x?.name ?? x ?? '')).filter(Boolean)
      if (t.length) { catalogTables = t; log(`  step 1 · ${t.length} tables from the source's own catalog`) }
    } catch { /* no catalog → fall back to seeds / type knowledge */ }

    let containers: string[]
    try { containers = await indexer.listContainers(s.id, rawQuery, { seedTables: seeds[s.id], catalogTables }) }
    catch (e: any) { log(`  step 1 FAILED: ${e.message}`); result.push({ id: s.id, dialect: s.dialect, containers: 0, indexed: 0, fields: 0, skipped: 0, failed: 0, error: e.message }); continue }

    // What is already indexed, so a resume skips it. If this cannot be read for any reason, the honest
    // fallback is to index everything rather than to stop: redoing work is a cost, refusing to build is a wall.
    let done = new Set<string>()
    try { done = new Set<string>((store.db.prepare('SELECT DISTINCT container FROM datasource_index WHERE source=?').all(s.id) as any[]).map(r => r.container)) }
    catch (e: any) { log(`  (could not read what is already indexed — ${e?.message ?? e}; indexing everything)`) }
    const todo = containers.filter(c => !done.has(c))
    log(`  step 1 · ${containers.length} tables (${done.size} already indexed, ${todo.length} to do)`)

    // STEP 2 — index the remainder one at a time, persisting each, so a failure loses only the current one.
    //
    // EMPTY AND FAILED ARE NOT THE SAME THING, and conflating them was worse than any bug it hid. A container
    // that returns no fields is a FACT about the data. One that throws is an absence of information — and when
    // the credentials were missing, all 118 threw, were counted as empty, and the build reported a clean
    // finish in 1.3 seconds having never reached NetSuite at all. Read literally it said the customer's
    // account was empty. It is also load-bearing: step 3 disables containers it believes have no rows, so
    // believing an outage is emptiness would switch off every table the engine can see.
    let i = 0, ok = 0, empty = 0, failed = 0, fields = 0
    let firstError = ''
    if (todo.length) log(`  step 2 · indexing ${todo.length}…`)
    for (const c of todo) {
      i++
      try {
        const entries = await indexer.indexContainer(s.id, c, rawQuery)
        if (entries.length) { putEntries(store, entries); ok++; fields += entries.length } else empty++
      } catch (e: any) {
        failed++
        if (!firstError) firstError = String(e?.message ?? e)
      }
      if (i % 25 === 0 || i === todo.length)
        log(`  …${i}/${todo.length} (${ok} indexed, ${empty} empty, ${failed} failed, ${fields} fields)`)
    }
    if (todo.length) log(`  step 2 · done: +${ok} tables, ${fields} new fields${failed ? `, ${failed} FAILED` : ''}`)

    // Everything failed and nothing succeeded — that is a source we could not reach, not a source with nothing
    // in it. Say so, with the reason, and stop: continuing to step 3 would disable every container on the
    // strength of row counts we never obtained.
    if (failed && !ok && !empty) {
      log(`  ✗ ${s.id} is UNREACHABLE — nothing was indexed. First error: ${firstError}`)
      log(`    Nothing has been changed. Fix the source, then run this again.`)
      result.push({ id: s.id, dialect: s.dialect, containers: containers.length, indexed: 0, fields: 0, skipped: 0, failed, error: firstError })
      continue
    }
    if (failed) log(`  ⚠ ${failed} of ${todo.length} could not be read (first: ${firstError}) — they are NOT recorded as empty`)

    // STEP 3 — real row counts, so empty tables stop surfacing in search. Anything that could not be counted
    // stays enabled: silence is not evidence of emptiness.
    if (indexer.rowCounts) {
      log('  step 3 · counting rows, disabling empty tables…')
      try {
        const { disabled, enabled } = applyRowCounts(store, s.id, await indexer.rowCounts(s.id, rawQuery))
        log(`  step 3 · ${disabled} empty (disabled), ${enabled} with rows`)
      } catch (e: any) { log(`  step 3 skipped (everything stays enabled): ${e.message}`) }
    }
    result.push({ id: s.id, dialect: s.dialect, containers: containers.length, indexed: ok, fields, skipped: empty, failed })
  }

  const totals = dataSourceStats(store)
  log('done.')
  return { sources: result, totals }
}
