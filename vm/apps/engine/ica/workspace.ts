// ── THE AGENT'S WORKING DIRECTORY ────────────────────────────────────────────────────────────────────────────
//
// Under each project home (<root>/<projectId>/):
//
//   sessions/<id>/  one conversation's directory — the composer's cwd for that conversation
//   workspace/      the shared directory — the analyst, grounding and connector agents work here
//   db/             the ENGINE's private state: semantic-graph.sqlite (the model, memory, data sessions),
//                   datasource-index.sqlite (./find-schema), grounding.sqlite, agent-sessions.sqlite. Outside every agent's
//                   cwd, so an `ls` never surfaces it.
//
// In its directory an agent finds the tools for its part, generated here with the absolute paths they need:
//
//   the semantic graph   ./match ./look ./ask ./run-program ./commit ./behind   (conversation, analyst)
//   the data             ./sources ./query ./introspect ./find-schema ./resolve                            (analyst, connector, grounding)
//   hand-off             ./escalate                                                                          (conversation)
//
// Which turn is live is in .turn, which data session this conversation is in .session — both written by the engine
// before it asks. A turn's files are in out/<qid>/.

import { mkdir, writeFile, chmod, symlink, readlink, rm, readdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const semanticCli = fileURLToPath(new URL('../graph/semantic-cli.ts', import.meta.url))
const modelCli = fileURLToPath(new URL('../../../packages/semantic-graph/src/cli.ts', import.meta.url))

export interface WorkspaceSpec {
  root: string
  projectId: string
  managerUrl?: string
  /** The project's committed configuration directory (settings.json). */
  projectDir?: string
  /** One conversation, one working directory: when given, the agent works in sessions/<sessionId>. */
  sessionId?: string
  /** A conversation's directory has the semantic graph and ./escalate. The shared workspace — where the analyst, connector
   *  and grounding agents all work, so one set of tools for all of them — has the semantic graph and the data. */
  tools?: 'conversation' | 'shared'
}

export async function prepareWorkspace(s: WorkspaceSpec): Promise<string> {
  const projectHome = join(s.root, s.projectId)
  const dir = s.sessionId ? join(projectHome, 'sessions', s.sessionId) : join(projectHome, 'workspace')
  const dbDir = join(projectHome, 'db')
  const managerUrl = s.managerUrl ?? 'http://localhost:4000'
  // The project's home, where its model is. Every agent in the shared workspace writes the same tools, so each resolves
  // it the way the engine does (ENGINE_PROJECT_DIR, else the project home) when its caller does not say.
  const projectDir = s.projectDir ?? process.env.ENGINE_PROJECT_DIR ?? projectHome
  const conversation = s.tools === 'conversation'
  for (const sub of conversation ? ['', 'out', '.tools'] : ['', 'data', 'grounding', 'out', '.tools']) await mkdir(join(dir, sub), { recursive: true })
  await mkdir(dbDir, { recursive: true })

  // @superatom/* must resolve from the project home for the data seams below. State lives outside the repository
  // (~/.superatom/state), where Node finds no node_modules by walking up, so the project home links to the engine's
  // by absolute path. A relative link breaks when the state directory moves, so it is replaced.
  const resolvesAlready = (() => {
    try { createRequire(join(projectHome, 'noop.js')).resolve('@superatom/introspect'); return true }
    catch { return false }
  })()

  if (!resolvesAlready) {
    try {
      const link = join(projectHome, 'node_modules')
      const target = fileURLToPath(new URL('../node_modules', import.meta.url))   // apps/engine/node_modules
      const current = await readlink(link).catch(() => null)
      if (current !== target) {
        if (current !== null) await rm(link, { force: true })
        if (existsSync(target)) await symlink(target, link, 'dir')
      }
      console.log(`[workspace] linked ${join(projectHome, 'node_modules')} → ${target}`)
    } catch (e: any) {
      // Not fatal on its own — but every data seam will fail, so say it rather than swallow it.
      console.warn(`[workspace] @superatom/* does not resolve from ${projectHome} and the fallback link failed — the data seams will not import: ${e?.message ?? e}`)
    }
  }


  if (!conversation) await writeFile(join(dir, 'CONTEXT.md'),
`# Project ${s.projectId}

The data sources: ./sources lists them, ./find-schema searches their fields, ./introspect and ./query read them, and
./resolve turns a name into ids. data/query.mjs, data/introspect.mjs and grounding/grounding.mjs are the same seams to
import. The semantic graph: ./match reads a question into it and ./look reads the graph itself; a program on it answers with ./run-program.
Every tool explains itself with --help.
`)

  if (!conversation) await writeFile(join(dir, 'data', 'query.mjs'),
`// The data seam. You never see databases, ports, dialects, or credentials — you call
// query(dataSourceId, query, params) — the manager runs the query against the source. There is ONE endpoint: the datasource-manager, which routes
// by id to the right bridge; the bridge binds @name params in its own dialect and runs the query.
// Ask the manager 'GET /sources' for each source's kind/dialect BEFORE writing queries.
const MANAGER = process.env.DATASOURCE_URL ?? '${s.managerUrl ?? 'http://localhost:4000'}'
export async function query(dataSourceId, sql, params = {}) {
  const r = await fetch(MANAGER + '/query', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ id: dataSourceId, sql, params }) })
  if (!r.ok) throw new Error(r.status + ' ' + await r.text())
  const p = await r.json(); if (p?.error) throw new Error(p.error)
  return p?.rows ?? []
}
// SYSTEM-only raw-SQL path (NOT for agent data queries): the introspect/grounding seams read catalogs and build
// indexes in raw dialect SQL. This posts { raw:true } so the manager runs it as-is, skipping the agent query path.
// Agent queries must go through query() above — that is the access-control boundary.
export async function rawQuery(dataSourceId, sql, params = {}) {
  const r = await fetch(MANAGER + '/query', { method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({ id: dataSourceId, sql, params, raw: true }) })
  if (!r.ok) throw new Error(r.status + ' ' + await r.text())
  const p = await r.json(); if (p?.error) throw new Error(p.error)
  return p?.rows ?? []
}
export async function sources() {   // list data sources + their kind/dialect
  const r = await fetch(MANAGER + '/sources'); return (await r.json()).sources
}
`)

  if (!conversation) await writeFile(join(dir, 'data', 'introspect.mjs'),
`// Introspection helpers over the data seam — DIALECT-SPECIFIC, resolved per source automatically.
// They hide the SQL, NEVER the DATA: every helper returns raw evidence (values, distributions,
// mismatches, sample rows) so YOU can catch bad data — they never hand you a black-box verdict.
// Prefer them over re-writing survey/profile SQL; drop to raw query() for anything they don't cover.
//   const I = await forSource(id)
//   await I.tables()                       → [{name, rows}] (all tables + row counts, fast)
//   await I.columns(table)                 → [{name, type}]
//   await I.sampleRows(table, n)           → real rows (LOOK at actual data)
//   await I.profile(table, column)         → {total, distinct, nulls, nullRate, min, max, mean, mode, topValues}
//   await I.verifyJoin(fromT, fromCol, toT, toCol) → {coverage, cardinality, unmatchedSamples, fromTopValues, hint}
//                                            (unmatchedSamples reveals sentinels/orphans — YOU judge; hint is a soft aside)
//   await I.checkRelation(table, expr)     → {total, violations, violationRate, sampleViolations} (conservation/arithmetic)
import { getIntrospect } from '@superatom/introspect'
import { rawQuery, sources } from './query.mjs'   // introspect reads catalogs in raw dialect SQL (trusted system path)
export async function forSource(id) {
  const s = (await sources()).find(x => x.id === id)
  if (!s) throw new Error('unknown source: ' + id + ' (call sources() to list)')
  return getIntrospect(s.dialect, rawQuery, id)
}
`)

  if (!conversation) await writeFile(join(dir, 'grounding', 'grounding.mjs'),
`// The GROUNDING seam. Grounding turns a fuzzy human reference — a name, a place, an id — into concrete
// structured ids, using indexes built per-project FROM this project's OWN data (nothing dataset-specific is
// assumed; entity types, hierarchies and value patterns are all discovered here and stored). The grounding
// agent BUILDS these indexes; the analyst READS them. It answers three questions, each a distinct resolver:
//   resolveEntity(text, {typeHint?, perType?})  — "which specific thing is this?"  value → ranked ids, PER type
//   resolveHierarchy(node, dir, name)           — one reference's members/ancestors (resolved against the source)
//   getHierarchy(name)                          — the hierarchy's relationship, to fold into your own query for a whole set
//   resolveValueByPattern(value)                — "what kind of value is this?"      id → { type, where it lives }
//
// BUILD (grounding agent): call build(config). You discover the config by exploring the data; the mechanical
// population is deterministic. config = {
//   entities:    [{ type, sql, source? }],        // sql returns rows { id, value } — one row per resolvable name
//   hierarchies: [{ name, entityType, childType?, resolver, source?, oneToMany?, spec }],
//   patterns:    [{ name, regex, entityType, location, howToFind, confidence }],   // format → where an id lives
//   aliases:     [{ type, id, alias }],           // curated human synonyms
// }
// A hierarchy is resolved LIVE against the source — nothing is copied, so it never goes stale. Prefer a live
// kind whenever the source already holds the tree simply; do NOT duplicate it. resolver + spec:
//   'column'        spec:{ table, idCol, parentCol } — child row carries a parent-key (self-ref tree or clean FK)
//   'derived-query' spec:{ descendantsSql, ancestorsSql? } — needs a join; each template binds @id
//   'cross-source'  spec:{ descendantsSql, ancestorsSql?, source } — related level in another source
//   'materialized'  spec:{ childrenSql } — the ONLY kind that COPIES edges (childrenSql → { parent_id, child_id });
//                   reserve it for hierarchies too expensive to resolve live, and re-run build() to refresh.
// build() is idempotent (re-running replaces). Verify with stats() and by calling the resolvers.
import { GroundingStore, buildGrounding } from '@superatom/grounding'
import { fileURLToPath } from 'node:url'
import { rawQuery as _query, sources as _sources } from '../data/query.mjs'   // grounding builds/resolves in raw SQL (trusted system path)
let _default
async function defaultSource() { if (!_default) _default = (await _sources())[0]?.id; return _default }
// The live data seam: routes each spec's SQL to its named source (or the sole source) and binds @name params.
// Hierarchies of the live kinds (column/derived-query/cross-source) resolve THROUGH this at query time — the
// source's own tree is the single source of truth, so results are always fresh and nothing is copied/synced.
const source = async (sql, src, params) => _query(src ?? await defaultSource(), sql, params ?? {})
const store = new GroundingStore(${JSON.stringify(join(dbDir, 'grounding.sqlite'))}, { source })
// Grounding holds the CURRENT state only (not versioned). NOT DONE YET: re-running build() is not a clean
// refresh — it upserts on top, so values gone from the source linger and a differently-shaped re-run leaves
// both shapes. (Flagging the consequence; not a decision on how to fix it.)
export async function build(config) { return buildGrounding(store, source, config) }
export const resolveEntity = (text, opts) => store.resolveEntity(text, opts)
export const resolveHierarchy = (node, dir, name) => store.resolveHierarchy(node, dir, name)   // async: pull a reference's members/ancestors
export const getHierarchy = (name) => store.getHierarchy(name)   // join-mode: the relationship's spec to compose into your OWN SQL (no N+1)
export const resolveValueByPattern = (value) => store.resolveValueByPattern(value)
export const stats = () => store.stats()   // the ONE structural reader (defined on GroundingStore)
export const raw = store
`)

  const graphTool = (command: string) => `// ${command} — the semantic graph. See apps/engine/graph/semantic-cli.ts.
import { spawnSync } from 'node:child_process'
const r = spawnSync('tsx', [${JSON.stringify(semanticCli)}, ${JSON.stringify(command)}, ...process.argv.slice(2),
  '--db', ${JSON.stringify(dbDir)}, '--project', ${JSON.stringify(projectDir)},
  '--manager', ${JSON.stringify(managerUrl)}, '--home', ${JSON.stringify(dir)}], { stdio: 'inherit', env: { ...process.env, NODE_NO_WARNINGS: '1' } })
process.exit(r.status ?? 1)
`
  const drivers: Record<string, string> = {
    escalate: `// Hand this question to the analyst and stop.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const HOME = ${JSON.stringify(dir)}
const reason = process.argv.slice(2).join(' ').trim()
if (!reason) { console.error('usage: ./escalate "<what is blocking you>"'); process.exit(1) }
const qid = (await readFile(join(HOME, '.turn'), 'utf8').catch(() => '')).trim()
if (!qid) { console.error('there is no turn in progress here'); process.exit(1) }
await mkdir(join(HOME, 'out', qid), { recursive: true })
await writeFile(join(HOME, 'out', qid, 'escalate.json'), JSON.stringify({ reason }, null, 2))
console.log('escalated')
`,

    'find-schema': `// Datasource index. "<term>" = matching fields across ALL sources (SOURCE.CONTAINER.FIELD : type). Search by field/table name, by type (date/number), or by what a column MEANS. --source <S> filters to one source; --full adds PK/nullable/references.
import { DataSourceIndex, searchDataSource } from '@superatom/datasource-index'
const store = new DataSourceIndex(${JSON.stringify(join(dbDir, 'datasource-index.sqlite'))})
const args = process.argv.slice(2)
const full = args.includes('--full')
const si = args.indexOf('--source')
const source = si >= 0 ? args[si + 1] : undefined
const skip = si >= 0 ? si + 1 : -1   // index of the source VALUE to drop (only when --source is present)
const q = args.filter((a, i) => a !== '--full' && a !== '--source' && i !== skip).join(' ').trim()
if (!q) { console.log(JSON.stringify({ hint: 'find-schema "<term>" [--source <SOURCE>] [--full] — search every datasource for a field/table by name, type, or description' })); process.exit(0) }
const r = searchDataSource(store, q, { source, limit: full ? 40 : 60 })
const view = (e) => full ? e : (e.key + ' : ' + (e.type || '?') + (e.isKey ? ' [PK]' : '') + (e.references ? (' → ' + e.references) : ''))
// SAY WHAT WAS NOT SHOWN. This returns a bounded slice, and a bare array of six fields reads as "there are
// six". That is not hypothetical: a search for "customer" showed 6 fields of one source out of 324, and the
// agent concluded that source held almost no customer data. The count and the per-source split make a slice
// recognisable as one, and point at the flag that narrows it.
const spread = Object.entries(r.bySource).map(([s, n]) => s + ':' + n).join(' · ')
console.log(JSON.stringify({
  fields: r.entries.map(view),
  shown: r.shown,
  matched: r.matched,
  bySource: r.bySource,
  note: r.shown < r.matched
    ? 'showing ' + r.shown + ' of ' + r.matched + ' matching fields (' + spread + ') — narrow the term, or scope with --source <SOURCE>'
    : 'all ' + r.matched + ' matching fields',
}, null, 2))
`,
    'sources': `// List data sources + their kind/dialect. Run: ./sources. Prints JSON.
import { sources } from ${JSON.stringify(join(dir, 'data', 'query.mjs'))}
console.log(JSON.stringify(await sources(), null, 2))
`,
    'query': `// Run a query against a source. Run: ./query "<source>" "<query>". Prints JSON rows.
import { query } from ${JSON.stringify(join(dir, 'data', 'query.mjs'))}
const [src, ...rest] = process.argv.slice(2)
if (!src || !rest.length) { console.error('usage: ./query "<source>" "<query>"  (list sources with ./sources)'); process.exit(1) }
console.log(JSON.stringify(await query(src, rest.join(' ')), null, 2))
`,
    'introspect': `// Inspect data schema/evidence. Run ONE of:
//   ./introspect "<source>" tables
//   ./introspect "<source>" columns "<table>"
//   ./introspect "<source>" sample "<table>" [n]
//   ./introspect "<source>" profile "<table>" "<column>"
//   ./introspect "<source>" verify-join "<fromT>" "<fromCol>" "<toT>" "<toCol>"
import { forSource } from ${JSON.stringify(join(dir, 'data', 'introspect.mjs'))}
const [src, cmd, ...a] = process.argv.slice(2)
if (!src || !cmd) { console.error('usage: ./introspect "<source>" <tables|columns|sample|profile|verify-join> [args]'); process.exit(1) }
const I = await forSource(src)
let r
if (cmd === 'tables') r = await I.tables()
else if (cmd === 'columns') r = await I.columns(a[0])
else if (cmd === 'sample') { const n = a.slice(1).map(Number).find(x => Number.isFinite(x) && x > 0); r = await I.sampleRows(a[0], n ?? 8) }
else if (cmd === 'profile') r = await I.profile(a[0], a[1])
else if (cmd === 'verify-join') r = await I.verifyJoin(a[0], a[1], a[2], a[3])
else { console.error('unknown subcommand: ' + cmd); process.exit(1) }
console.log(JSON.stringify(r, null, 2))
`,
    'resolve': `// Resolve a fuzzy human reference (a name/value) to concrete ids. Run: ./resolve "<text>". Prints JSON.
import { resolveEntity } from ${JSON.stringify(join(dir, 'grounding', 'grounding.mjs'))}
const t = process.argv.slice(2).join(' ').trim()
if (!t) { console.error('usage: ./resolve "<text>"'); process.exit(1) }
console.log(JSON.stringify(await resolveEntity(t), null, 2))
`,
  }
  const usages: Record<string, string> = {
    escalate: conversation
      ? 'escalate "<what is blocking you>"   → hand this question to the analyst and stop.'
      : 'escalate "<what the graph is missing>"   → stop, telling the person what the graph does not hold yet and where in the data it is.',
    'find-schema':  'find-schema "<term>" [--source <SOURCE>] [--full]   → search ALL datasources for a field/table by name, type, or description (SOURCE.TABLE.COLUMN : type); --source filters to one; --full adds PK/nullable/references',
    'sources':      'sources   → every data source with its kind + dialect (JSON)',
    'query':        'query "<source>" "<query>"   → run a query against a source → JSON rows   (list sources: ./sources)',
    'introspect':   'introspect "<source>" <cmd>   where <cmd> = tables | columns "<table>" | sample "<table>" [n] | profile "<table>" "<column>" | verify-join "<fromT>" "<fromCol>" "<toT>" "<toCol>"',
    'resolve':      'resolve "<text>"   → resolve a fuzzy name/value to concrete ids (JSON)',
  }
  // A conversation has the semantic graph and hands off with ./escalate; the analyst has the graph and the data; the
  // connector and grounding agents have the data.
  if (conversation) for (const name of Object.keys(drivers)) if (name !== 'escalate') delete drivers[name]
  for (const name of Object.keys(SEMANTIC_USAGE)) { drivers[name] = graphTool(name); usages[name] = SEMANTIC_USAGE[name] }
  // Building the model: the one semantic-graph tool, on this project's store, with the agent at work as who changed it.
  if (!conversation) {
    drivers['semantic-graph'] = `// semantic-graph — the project's model, built and changed through checked, recorded operations. See packages/semantic-graph/MODELING.md.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const agent = (() => { try { return readFileSync(${JSON.stringify(join(dir, '.agent'))}, 'utf8').trim() } catch { return 'agent' } })()
const args = process.argv.slice(2).map((a) => (a === '-h' ? '--help' : a))
const r = spawnSync('tsx', [${JSON.stringify(modelCli)}, ...args, '--db', ${JSON.stringify(join(dbDir, 'semantic-graph.sqlite'))}, '--model', 'model'],
  { stdio: 'inherit', env: { ...process.env, NODE_NO_WARNINGS: '1', SEMANTIC_GRAPH_BY: agent } })
process.exit(r.status ?? 1)
`
    usages['semantic-graph'] = 'semantic-graph help   → the commands that read and build the project\'s model; every change is checked and recorded with who made it and why'
  }
  for (const [name, body] of Object.entries(drivers)) {
    // Prepend a --help guard. ESM hoists the body's imports above this, but they only OPEN cheap handles; the
    // guard still short-circuits before any query/search runs, printing usage and nothing else.
    // Clean errors (message only, no stack) + a --help guard. Any failure inside the tool prints one actionable
    // line and exits 1 — the agent reads a clear reason, not a Node stack trace.
    const help = `process.on('unhandledRejection', (e) => { console.error(String(e && e.message || e)); process.exit(1) })
process.on('uncaughtException', (e) => { console.error(String(e && e.message || e)); process.exit(1) })
${name === 'semantic-graph' ? '' : `if (process.argv.slice(2).some(a => a === '-h' || a === '--help')) { console.log(${JSON.stringify(usages[name])}); process.exit(0) }\n`}`
    await writeFile(join(dir, '.tools', name + '.mjs'), help + body)
    await writeFile(join(dir, name),
`#!/usr/bin/env bash
D=${JSON.stringify(join(dir, '.tools', name + '.mjs'))}
if command -v tsx >/dev/null 2>&1; then exec tsx "$D" "$@"; else exec npx --yes tsx "$D" "$@"; fi
`)
    await chmod(join(dir, name), 0o755)
  }

  await removeWhatIsNotOurs(dir, Object.keys(drivers), conversation)
  return dir
}

const SEMANTIC_USAGE: Record<string, string> = {
  match: `match '<the question, as asked>' [--json]   → the subgraphs the question could be. Give it minutes, not seconds: it tries the best few against the data. Its words are resolved to measures, dimensions, conditions and records (looked up by name at their sources); every route the graph holds is built; each is said back in the graph's own words with what is uncertain about it; the best few are asked against the data so it can separate them. Ends with what to change if the first one is not it`,
  look: `look [<node>] [<to>|<text>]   → the graph itself: nothing for every fact, dimension and calendar; a node for what it holds, what it links to, what links to it and what it is sliced by; two nodes for every way from one to the other; a node and some text for which record that text means`,
  ask: `ask '<question>' [--json]   → a question's answer, or the rule that refuses it and what to change. Give it minutes, not seconds: a fact built by a program reads a whole span from the source before it groups, which is tens of seconds when nothing has read that span yet and nothing at all when something has. A question: {"measures":["Fact.measure" | "[A.x] / [B.y]"], "by":[{"to":"Pillar","via":["person","pillar"]} | {"attribute":"a"} | {"attribute":"rag","of":"Project"}], "where":[{"to":"Dimension","via":[…],"in":["key"]} | {"attribute":"a","in":["v"]} | {"condition":"valid project"}], "without":["a condition a fact is always kept to"], "span":{"from":"2026-09-01","through":"2026-10-31"} | {"this":"Month"} | {"previous":"Month","count":3} | {"last":30,"unit":"Day"}, "currency":"AUD", "order":{"by":"column","desc":true}, "limit":10 — also having, totals, share, compare, fill, cumulative, rolling, limitPer, notIn/none/contains/startsWith`,
  'run-program': `run-program [program.mjs] ['<params>']   → run the program in this folder and read its answer as the person would — headline, narration, tables with their row counts; run it as often as it takes, then ./commit. Allow it a few minutes: a question whose fact is built by a program reads a whole span before it groups. A program is named for its idea and takes the question's values (span, records) as params: export const meta = { name, description, params: { name: 'what it means' }, logic }; export default async (ctx, params) => ({ status?: 'answered'|'unknowable'|'uncertain', missing?: '<the plain reason, when not answered>', scope?: '<the records and conditions kept to>', headline?: { label, value: <cell> }, data: { name: <table> }, views: [{ id, component: 'table'|'bar'|'line'|'kpi', data: '<data key>', title, encode: { columns: [...] } | { x, y, series } }], narration: [{ text: 'October is {oct}', cites: { oct: <cell> }, why }], nextSteps: [{ label, why }] }). ctx.ask(question, label) returns a table { columns: [{ name, role, unit }], rows: [{ Pillar: 7, Pillar_label: 'Consulting', Month: '2026-09', revenue: 4372656 }] } — a record by its id, its name beside it — the program's only data; ctx.transform(label, () => …), ctx.decide(label, took, why), ctx.decideAt(label, value, op, threshold, why), await ctx.verify(label, () => holds), ctx.caveat(text), ctx.explain(text). A cell is { data: '<data key>', row: 0 | { Month: '2026-09' }, column }; every number in a sentence is a {slot} citing a cell`,
  commit: `commit   → give the answer of the last ./run-program as this conversation's next step, and end the turn`,
  behind: `behind ['<group>'] [<call>]   → what is under the answer on screen: the rows of one group (a group is JSON, e.g. '{"Pillar":"15"}'), or with no group, the steps and questions it was reached by`,
}

// ── THE WORKSPACE HOLDS WHAT THIS ENGINE WRITES, AND NOTHING ELSE ─────────────────────────────────────────────
// A workspace outlives engine versions, and an agent reads whatever it finds: an earlier engine's tools, question
// programs and turn files were read as current, and used. So preparing a workspace also removes what the current
// engine does not put there. Each entry below names who writes it.
const OWNED = new Set([
  'CONTEXT.md', 'data', 'grounding', 'out', '.tools',               // this file
  '.turn', '.session', '.agent',                                    // agents/composer, agents/analyst: the turn in progress
  'AGENTS.md', 'SYSTEM_REFERENCE.md', '.claude',                    // the harnesses (ica/pi.ts, ica/codex.ts, ica/claude.ts)
  'connector', 'templates',                                         // agents/connector
])
const OWNED_IN: Record<string, Set<string>> = {
  data: new Set(['query.mjs', 'introspect.mjs']),
  grounding: new Set(['grounding.mjs', 'GROUNDING.md']),            // GROUNDING.md: agents/grounding
}

async function removeWhatIsNotOurs(dir: string, tools: string[], conversation = false) {
  const owned = new Set([...OWNED, ...tools].filter((e) => !(conversation && ['data', 'grounding', 'CONTEXT.md'].includes(e))))
  const gone = (p: string) => rm(p, { recursive: true, force: true })
  for (const e of await readdir(dir)) if (!owned.has(e)) await gone(join(dir, e))
  for (const [sub, keep] of Object.entries(OWNED_IN))
    for (const e of await readdir(join(dir, sub)).catch(() => [] as string[])) if (!keep.has(e)) await gone(join(dir, sub, e))
  for (const e of await readdir(join(dir, '.tools'))) if (!tools.includes(e.replace(/\.mjs$/, ''))) await gone(join(dir, '.tools', e))
  // A turn leaves what it answered with — built.json and the run.json it came from, and the program.mjs and params.json it ran — or escalate.json or
  // explain.md, or nothing yet while it runs. The verbs read these after a restart, so they are kept; anything else in
  // out/ was written for an earlier engine.
  const TURN_FILES = new Set(['built.json', 'run.json', 'escalate.json', 'program.mjs', 'params.json', 'explain.md'])
  for (const e of await readdir(join(dir, 'out'))) {
    // An answer given before built.json was named step.json.
    if (existsSync(join(dir, 'out', e, 'step.json')) && !existsSync(join(dir, 'out', e, 'built.json'))) await rename(join(dir, 'out', e, 'step.json'), join(dir, 'out', e, 'built.json')).catch(() => {})
    const files = await readdir(join(dir, 'out', e)).catch(() => null)
    if (files === null || files.some((f) => !TURN_FILES.has(f))) await gone(join(dir, 'out', e))
  }
}
