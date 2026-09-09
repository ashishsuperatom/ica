// ── REWRITE RUNNABLE CONCEPTS INTO THE METADATA-BESIDE-THE-BODY SHAPE ─────────────────────────────────────
//
//   tsx tools/reshape-concepts.mts <project.sqlite> <workDir> [--apply]
//
// One-time, per store. Every runnable concept currently declares its metadata twice: once as a `meta` block
// inside the body and once as fields on the stored concept. This splits them apart — the body keeps only its
// function, and the metadata is rebuilt from the fields that were already stored.
//
// IT RE-RUNS EVERY CONCEPT. A concept enters the store by executing and having its invariants hold, and that
// rule does not get an exception for a migration. The parameters come from each concept's own last run, which
// is recorded, so it is exercised exactly as it was when it was accepted.
//
// WHAT IT WILL NOT INVENT. `dimensions` and `render` are new fields with nothing to migrate from. A guessed
// split axis is worse than an absent one — the GROUP BY can be read off the SQL but cannot distinguish an
// analysis axis from a column a join dragged in — so both are left unset for a person or the modeller to fill
// when the concept is next touched.
//
// Delete this file once every store has been converted.

import { NodeStore, namesFor, getSample } from '@superatom/node-store'
import { tryConcept } from '../concepts/runner.js'
import { saveConcept, managerSignSql } from '../concepts/save.js'
import { query } from '@superatom/scaffold'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const [dbPath, workDir, ...flags] = process.argv.slice(2)
if (!dbPath || !workDir) {
  console.error('usage: tsx tools/reshape-concepts.mts <project.sqlite> <workDir> [--apply]'); process.exit(1)
}
const APPLY = flags.includes('--apply')
const MANAGER = process.env.DATASOURCE_URL || 'http://localhost:4000'

/** The `meta` block, and the body without it. Text, not a parse: the block is a top-level export in a known
 *  position, and the body must come out byte-identical apart from that block — a reformatting parser would
 *  change every concept's identity for no reason anyone asked for. */
function split(source: string): { body: string; had: boolean } {
  const m = /^export\s+const\s+meta\s*=\s*\{/m.exec(source)
  if (!m) return { body: source, had: false }
  let i = source.indexOf('{', m.index), depth = 0
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') { depth--; if (depth === 0) { i++; break } }
  }
  const body = (source.slice(0, m.index) + source.slice(i)).replace(/\n{3,}/g, '\n\n').trim() + '\n'
  return { body, had: true }
}

/** point or window, from whatever the field happens to hold. The stored values were a typed union that
 *  nothing enforced, so they range from 'snapshot' to 'point-in-time (as at a month-end)'. */
const timeOf = (t: unknown): 'point' | 'window' | undefined => {
  const s = String(t ?? '').toLowerCase()
  if (!s) return undefined
  if (/during|period|window|trailing/.test(s)) return 'window'
  return 'point'
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60)

const store = new NodeStore(dbPath)
const rows = store.db.prepare(`
  SELECT c.id, c.label, c.props FROM nodes c
  WHERE c.kind='concept' AND EXISTS (
    SELECT 1 FROM nodes i WHERE i.kind='index' AND i.valid_to IS NULL
      AND json_extract(i.props,'$.target') = c.id)`).all() as any[]

const todo = rows.map((r) => ({ ...r, p: JSON.parse(r.props) }))
  .filter((r) => /export\s+default/.test(r.p.compute ?? ''))

await mkdir(workDir, { recursive: true })
let reshaped = 0, unchanged = 0, failed = 0, reused = 0

for (const c of todo) {
  const { body, had } = split(c.p.compute)
  if (!had) { unchanged++; continue }

  // Names come from the index, which is where names live. The primary is the label it was saved under; the
  // rest are aliases, and they are passed to the save rather than stored on the concept.
  const names = namesFor(store, c.id)
  const aliases = names.filter((n) => n !== c.label)
  const sample = getSample(store.db, c.id)
  const measure = (c.p.measures ?? [])[0] ?? {}
  const unit = typeof measure.note === 'string' && measure.note.startsWith('unit: ')
    ? measure.note.slice(6).trim() : undefined

  const derived: any = {
    name: c.label,
    description: String(c.p.value ?? '').trim(),
    aliases,
    sources: Array.isArray(c.p.sources) && c.p.sources.length ? c.p.sources : [c.p.source].filter(Boolean),
    params: Object.fromEntries((c.p.parameters ?? []).map((x: any) => [x.name, x.note ?? ''])),
    grain: c.p.grain,
    additive: typeof measure.additive === 'boolean' ? measure.additive : undefined,
    unit,
    time: timeOf(c.p.time),
  }
  for (const k of Object.keys(derived)) if (derived[k] === undefined) delete derived[k]

  const file = join(workDir, `${slug(c.label)}.mjs`)
  const metaFile = join(workDir, `${slug(c.label)}.meta.json`)
  await writeFile(file, body)
  // AN EXISTING METADATA FILE WINS. This is a two-pass tool by nature: the first pass writes what can be
  // migrated mechanically, a person fixes what cannot — a description too long to keep, an axis only they
  // know — and the second pass applies it. Regenerating here threw those edits away and then refused the
  // save for the very reason the person had just fixed.
  let meta = derived
  try { meta = JSON.parse(await readFile(metaFile, 'utf8')); reused++ }
  catch { await writeFile(metaFile, JSON.stringify(derived, null, 2) + '\n') }

  const over = meta.description.length > 300
  if (over) console.log(`  ! ${c.label} — description is ${meta.description.length} chars and will be refused`)

  if (!APPLY) { reshaped++; continue }

  const r = await tryConcept({ file, params: (sample?.params as any) ?? {}, meta, store,
                              timeoutMs: 10 * 60_000, query: (s, sql, p) => query(s, sql, p) })
  if (!r.ok) { failed++; console.log(`✗ ${c.label}\n    ${String(r.error).split('\n')[0].slice(0, 140)}`); continue }
  const saved = await saveConcept(store, r.runId, { changedBy: 'reshape', reason: 'metadata moved beside the body' },
                                  managerSignSql(MANAGER))
  if (!saved.ok) { failed++; console.log(`✗ ${c.label} — ${String(saved.reason ?? "").slice(0, 140)}`); continue }
  reshaped++
  console.log(`✓ ${c.label}  ${saved.conceptId}  ${names.length} name(s)`)
}

console.log(`\n${reshaped} reshaped, ${unchanged} already in the new shape, ${failed} failed` +
            (reused ? `, ${reused} used an edited metadata file` : '') +
            (APPLY ? '' : ' — dry run, pass --apply'))
store.close()
