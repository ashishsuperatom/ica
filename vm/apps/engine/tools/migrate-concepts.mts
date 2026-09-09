// ── MIGRATE PROSE CONCEPTS TO RUNNABLE ONES ───────────────────────────────────────────────────────────────
//
//   tsx tools/migrate-concepts.mts <project.sqlite> <outDir> [--apply]
//
// Reads the existing store and writes a DRAFT function per concept. It saves nothing. It cannot: a concept
// enters the store only by being run, and no tool can run a body it has just invented on someone's behalf.
//
// WHAT IT DOES MECHANICALLY. The parts that are already unambiguous: the query becomes a `ctx.query`, the
// declared source becomes `meta.sources`, the placeholders become parameters, the description and aliases
// carry across, and every prose `rule` is preserved verbatim as a comment beside the code it constrains.
//
// WHAT IT REFUSES TO GUESS. Which number is the ATOMIC VALUE. A query returning one row of one aggregate is
// obvious; a query returning a ranking is not — the value might be the total, the top row, or the count of
// rows, and picking wrong would produce a concept that runs, passes, and means something nobody intended.
// That is left as a marked TODO, because a draft that fails honestly is better than one that succeeds
// misleadingly.
//
// AND IT REFUSES TO CONVERT WHAT IS NOT A COMPUTATION. Not everything in a concept store computes: a
// predicate meant to be pasted into other queries, a strategy for approaching a problem, an anti-pattern
// carrying a deliberately BROKEN query beside the correct one. Forcing those into a function shape would
// damage them to satisfy a rule they were never part of. They are reported as notes and left alone.
//
// Nothing here knows anything about any particular dataset: every decision is taken from the shape of what
// is stored, never from what it happens to be about.

import { NodeStore } from '@superatom/node-store'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const [dbPath, outDir, ...flags] = process.argv.slice(2)
if (!dbPath || !outDir) {
  console.error('usage: tsx tools/migrate-concepts.mts <project.sqlite> <outDir> [--apply]')
  process.exit(1)
}
const APPLY = flags.includes('--apply')
const MANAGER = process.env.DATASOURCE_URL || 'http://localhost:4000'

/** Each source's dialect, asked once. WITHOUT THIS the classifier is wrong in the worst way: a concept
 *  written for one source's dialect fails to parse under another's and is filed as "not a computation" — so
 *  an entire project's concepts would be dismissed as notes because they were read with the wrong grammar.
 *  The manager already publishes this per source; there is no reason to guess it. */
async function dialects(): Promise<Record<string, string>> {
  try {
    const r = await fetch(`${MANAGER}/sources`, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return {}
    const { sources } = (await r.json()) as any
    return Object.fromEntries((sources ?? []).map((s: any) => [s.id, s.dialect]).filter(([, d]: any[]) => d))
  } catch { return {} }
}

/** Does this parse as a COMPLETE query? The manager decides, because it owns the parser — and the answer is
 *  also the classifier: what parses is a computation, what does not is one of the other kinds. */
async function parses(sql: string, dialect?: string): Promise<boolean> {
  try {
    const r = await fetch(`${MANAGER}/signature`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql, dialect }), signal: AbortSignal.timeout(10_000),
    })
    if (!r.ok) return false
    return ((await r.json()) as any).signature != null
  } catch { return false }
}

/** Whole sentences up to a limit — a description cut mid-word reads as damage rather than as a summary. The
 *  full text survives as a comment above, so nothing is lost by keeping this short. */
function firstSentences(text: string, max = 400): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
  return (end > 80 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(' '))).trim()
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60)
const comment = (s: string, indent = '// ') =>
  String(s).split('\n').map((l) => indent + l).join('\n')

/** A parameter placeholder in the modeller's convention, e.g. `<year>` — but NOT always a bare word. Real
 *  stored concepts carry things like `<end+1day>`, which a `\w+` pattern silently leaves in the SQL, breaking
 *  the parse and filing a perfectly good measure as "not a computation". Anything between the brackets. */
const PLACEHOLDER = /<([^<>]+)>/g
/** A placeholder made safe to be a bind name and a destructured identifier. The original wording survives in
 *  the params documentation, where it is a description rather than a symbol. */
const ident = (raw: string) => raw.trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1')
const paramsIn = (sql: string) =>
  [...new Map([...sql.matchAll(PLACEHOLDER)].map((m) => [ident(m[1]), m[1]])).entries()]

function draft(name: string, props: any, sql: string, source: string): string {
  const params = paramsIn(sql)
  const bind = params.map(([id]) => id).join(', ')
  // Placeholders become real bind parameters; the query is otherwise untouched, because rewriting someone
  // else's SQL is how a migration introduces a bug nobody looks for.
  const bound = sql.replace(PLACEHOLDER, (_m, raw) => `:${ident(raw)}`)
  const rules: string[] = Array.isArray(props.rules) ? props.rules : []

  return `// ${name}
//
// MIGRATED DRAFT — not yet a concept. Run it, decide the value, then save it:
//   tsx concept-try.mjs concepts/${slug(name)}.mjs '{${params.map(([id]) => `"${id}": …`).join(', ')}}'
//
${props.value ? comment(props.value) + '\n//\n' : ''}${
  rules.length
    ? '// RULES CARRIED OVER FROM THE PROSE. Each one is either already IN the query below — in which case\n' +
      '// delete it, because a restated filter is a second copy that will drift — or it is an invariant, in\n' +
      '// which case make it a ctx.verify so it is checked on every run instead of remembered.\n' +
      rules.map((r, i) => comment(`(${i + 1}) ${r}`)).join('\n') + '\n'
    : ''}
export const meta = {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(firstSentences(String(props.value ?? '')))},
  aliases: ${JSON.stringify(Array.isArray(props.aliases) ? props.aliases : [])},
  sources: ${JSON.stringify([source])},
  params: {${params.map(([id, raw]) => `\n    ${JSON.stringify(id)}: ${JSON.stringify(`TODO: what this means (was <${raw}>)`)},`).join('')}
  },
  returns: 'TODO: what the value means — its unit and its grain',
}

export default async function (ctx, { ${bind} }) {
  const rows = await ctx.query(${JSON.stringify(source)}, \`
${bound.trim()}
\`, { ${bind} })

  // TODO: which number is the ATOMIC VALUE? The migration will not guess: for a single aggregate it is that
  // number, for a ranking it might be the total, the top row, or the count — and guessing wrong yields a
  // concept that runs, passes, and means something nobody intended.
  const value = null

  // TODO: turn each carried-over rule that is an INVARIANT into a check. They run on every execution and
  // travel with this body when it is copied into an answer, which prose never did.
  // await ctx.verify('<what must hold>', () => <expression>)

  return { value, distribution: rows }
}
`
}

const DIALECT = await dialects()
const KNOWN = Object.keys(DIALECT)
const store = new NodeStore(dbPath)
const live = store.db.prepare(`
  SELECT c.id, c.props,
    (SELECT group_concat(substr(i.id,7), ',') FROM nodes i
      WHERE i.kind='index' AND i.id NOT LIKE '%@%' AND json_extract(i.props,'$.target') = c.id) AS names
  FROM nodes c WHERE c.kind='concept'`).all() as any[]

const drafts: string[] = []
const notes: Array<{ name: string; why: string }> = []
const skipped: string[] = []

for (const row of live) {
  if (!row.names) continue                                  // superseded body: the index has moved off it
  const name = String(row.names).split(',')[0]
  const props = typeof row.props === 'string' ? JSON.parse(row.props) : row.props
  const sql = String(props.compute ?? '').trim()
  if (!sql) { notes.push({ name, why: 'no compute — prose knowledge, nothing to run' }); continue }
  // THE SOURCE FIELD IS PROSE IN PRACTICE. The schema calls it a datasource id, and real stored concepts
  // hold things like "SOURCEID (dialect) — schema.table". So the id is RECOGNISED against what the manager
  // actually has, rather than trusted — otherwise the dialect lookup misses and the concept is read with the
  // wrong grammar and dismissed.
  const declared = `${props.source ?? ''} ${props.find ?? ''}`
  const source = KNOWN.find((id) => declared.includes(id)) ?? String(props.source ?? 'CHANGEME').split(/[\s(—]/)[0]
  const dialect = DIALECT[source]
  if (!(await parses(sql, dialect))) {
    notes.push({ name, why: 'compute is not a complete query — a fragment, a strategy, or an anti-pattern' })
    continue
  }
  drafts.push(name)
  if (APPLY) {
    await mkdir(outDir, { recursive: true })
    await writeFile(join(outDir, `${slug(name)}.mjs`), draft(name, props, sql, source))
  }
}

console.log(`${live.filter((r) => r.names).length} live concepts`)
console.log(`  ${drafts.length} convertible → drafts${APPLY ? ` written to ${outDir}` : ' (dry run — pass --apply to write)'}`)
console.log(`  ${notes.length} stay as notes:`)
for (const n of notes) console.log(`     ${n.name.padEnd(46)} ${n.why}`)
if (skipped.length) console.log(`  ${skipped.length} skipped`)
console.log(`\nNothing was saved. Each draft must be run before it can become a concept.`)
store.close()
