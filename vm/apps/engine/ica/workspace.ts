// ── THE AGENT'S WORKING DIRECTORY ────────────────────────────────────────────────────────────────────────────
//
// Under each project home (<root>/<projectId>/):
//
//   sessions/<id>/  one conversation's directory — the composer's cwd for that conversation
//   workspace/      the shared directory — the analyst, grounding and connector agents work here
//   db/             the ENGINE's private state: graph.sqlite (programs, memory, data sessions), datasource-index.sqlite
//                   (./find-schema), grounding.sqlite, agent-sessions.sqlite. Outside every agent's cwd, so an `ls` never surfaces it.
//
// In either directory the agent finds its tools, generated here with the absolute paths they need:
//
//   the graph       ./catalog ./define ./try ./ask ./find ./members
//   the data        ./sources ./query ./introspect ./find-schema ./resolve
//   hand-off        ./escalate
//
// and writes the programs it defines under programs/<name>/ (contract.json + program.mjs). Which turn is live is in
// .turn, which data session this conversation is in .session — both written by the engine before it asks.

import { mkdir, writeFile, chmod, symlink, readlink, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const graphCli = fileURLToPath(new URL('../graph/cli.ts', import.meta.url))

export interface WorkspaceSpec {
  root: string
  projectId: string
  managerUrl?: string
  /** The project's committed configuration directory (settings.json). */
  projectDir?: string
  /** One conversation, one working directory: when given, the agent works in sessions/<sessionId>. */
  sessionId?: string
}

export async function prepareWorkspace(s: WorkspaceSpec): Promise<string> {
  const projectHome = join(s.root, s.projectId)
  const dir = s.sessionId ? join(projectHome, 'sessions', s.sessionId) : join(projectHome, 'workspace')
  const dbDir = join(projectHome, 'db')
  const managerUrl = s.managerUrl ?? 'http://localhost:4000'
  for (const sub of ['', 'data', 'grounding', 'programs', 'out', '.tools']) await mkdir(join(dir, sub), { recursive: true })
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


  await writeFile(join(dir, 'CONTEXT.md'),
`# Project ${s.projectId}

Programs live in the graph. Find what exists with ./catalog; write a program in programs/<name>/ as contract.json and
program.mjs and define it with ./define; check it with ./try; answer the person by applying a message to their data
session with ./ask. Every tool explains itself with --help.
`)

  await writeFile(join(dir, 'data', 'query.mjs'),
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

  await writeFile(join(dir, 'data', 'introspect.mjs'),
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

  await writeFile(join(dir, 'grounding', 'grounding.mjs'),
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

  const graphTool = (command: string) => `// ${command} — the graph. See apps/engine/graph/cli.ts.
import { spawnSync } from 'node:child_process'
const r = spawnSync('tsx', [${JSON.stringify(graphCli)}, ${JSON.stringify(command)}, ...process.argv.slice(2),
  '--db', ${JSON.stringify(dbDir)}, '--project', ${JSON.stringify(s.projectDir ?? projectHome)},
  '--manager', ${JSON.stringify(managerUrl)}, '--home', ${JSON.stringify(dir)}], { stdio: 'inherit', env: { ...process.env, NODE_NO_WARNINGS: '1' } })
process.exit(r.status ?? 1)
`
  const drivers: Record<string, string> = {
    catalog: graphTool('catalog'),
    define: graphTool('define'),
    try: graphTool('try'),
    ask: graphTool('ask'),
    find: graphTool('find'),
    members: graphTool('members'),
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
// six". That is not hypothetical: a search for "customer" showed 6 TotalGroup fields out of 324, and the
// agent concluded TotalGroup held almost no customer data. The count and the per-source split make a slice
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
    catalog: 'catalog [words]   → the programs that exist, with each relation\'s measures, dimensions, entities and time',
    define: 'define programs/<name> [--replace "<why>"]   → define the program in that directory (contract.json + program.mjs), or correct the one with its name',
    try: 'try <program> [\'<request json>\']   → ask a program directly, to check it while you write it',
    ask: 'ask \'<message json>\'   → apply a message to this conversation\'s data session and answer it: {"ask":"<program>","request":{…}} starts a question; {"filter":{…}}, {"split":{"add":[…]}}, {"measures":{"add":[…]}}, {"set":{…}}, {"assume":{…}}, {"intervene":{…}}, {"asOf":"YYYY-MM-DD"} follow up — several parts in one message apply together',
    find: 'find \'<query json>\'   → something the person was shown: {"row":3} in the current answer · {"text":"acme"} · {"column":"region","equals":"north"}',
    members: 'members <relation> <dimension> [text]   → which members of a dimension match what was typed',
    escalate: 'escalate "<what is blocking you>"   → hand this question to the analyst and stop.',
    'find-schema':  'find-schema "<term>" [--source <SOURCE>] [--full]   → search ALL datasources for a field/table by name, type, or description (SOURCE.TABLE.COLUMN : type); --source filters to one; --full adds PK/nullable/references',
    'sources':      'sources   → every data source with its kind + dialect (JSON)',
    'query':        'query "<source>" "<query>"   → run a query against a source → JSON rows   (list sources: ./sources)',
    'introspect':   'introspect "<source>" <cmd>   where <cmd> = tables | columns "<table>" | sample "<table>" [n] | profile "<table>" "<column>" | verify-join "<fromT>" "<fromCol>" "<toT>" "<toCol>"',
    'resolve':      'resolve "<text>"   → resolve a fuzzy name/value to concrete ids (JSON)',
  }
  for (const [name, body] of Object.entries(drivers)) {
    // Prepend a --help guard. ESM hoists the body's imports above this, but they only OPEN cheap handles; the
    // guard still short-circuits before any query/search runs, printing usage and nothing else.
    // Clean errors (message only, no stack) + a --help guard. Any failure inside the tool prints one actionable
    // line and exits 1 — the agent reads a clear reason, not a Node stack trace.
    const help = `process.on('unhandledRejection', (e) => { console.error(String(e && e.message || e)); process.exit(1) })
process.on('uncaughtException', (e) => { console.error(String(e && e.message || e)); process.exit(1) })
if (process.argv.slice(2).some(a => a === '-h' || a === '--help')) { console.log(${JSON.stringify(usages[name])}); process.exit(0) }\n`
    await writeFile(join(dir, '.tools', name + '.mjs'), help + body)
    await writeFile(join(dir, name),
`#!/usr/bin/env bash
D=${JSON.stringify(join(dir, '.tools', name + '.mjs'))}
if command -v tsx >/dev/null 2>&1; then exec tsx "$D" "$@"; else exec npx --yes tsx "$D" "$@"; fi
`)
    await chmod(join(dir, name), 0o755)
  }

  await removeWhatIsNotOurs(dir, Object.keys(drivers))
  return dir
}

// ── THE WORKSPACE HOLDS WHAT THIS ENGINE WRITES, AND NOTHING ELSE ─────────────────────────────────────────────
// A workspace outlives engine versions, and an agent reads whatever it finds: an earlier engine's tools, question
// programs and turn files were read as current, and used. So preparing a workspace also removes what the current
// engine does not put there. Each entry below names who writes it.
const OWNED = new Set([
  'CONTEXT.md', 'data', 'grounding', 'programs', 'out', '.tools',   // this file
  '.turn', '.session', '.agent',                                    // agents/composer, agents/analyst: the turn in progress
  'AGENTS.md', 'SYSTEM_REFERENCE.md', '.claude',                    // the harnesses (ica/pi.ts, ica/codex.ts, ica/claude.ts)
  'connector', 'templates',                                         // agents/connector
])
const OWNED_IN: Record<string, Set<string>> = {
  data: new Set(['query.mjs', 'introspect.mjs']),
  grounding: new Set(['grounding.mjs', 'GROUNDING.md']),            // GROUNDING.md: agents/grounding
}

async function removeWhatIsNotOurs(dir: string, tools: string[]) {
  const owned = new Set([...OWNED, ...tools])
  const gone = (p: string) => rm(p, { recursive: true, force: true })
  for (const e of await readdir(dir)) if (!owned.has(e)) await gone(join(dir, e))
  for (const [sub, keep] of Object.entries(OWNED_IN))
    for (const e of await readdir(join(dir, sub)).catch(() => [] as string[])) if (!keep.has(e)) await gone(join(dir, sub, e))
  for (const e of await readdir(join(dir, '.tools'))) if (!tools.includes(e.replace(/\.mjs$/, ''))) await gone(join(dir, '.tools', e))
  // A program is a directory with a contract.json; anything else in programs/ was written for an earlier engine.
  for (const e of await readdir(join(dir, 'programs'))) if (!existsSync(join(dir, 'programs', e, 'contract.json'))) await gone(join(dir, 'programs', e))
  // A turn leaves step.json or escalate.json, or nothing yet while it runs.
  for (const e of await readdir(join(dir, 'out'))) {
    const files = await readdir(join(dir, 'out', e)).catch(() => null)
    if (files === null || files.some((f) => f !== 'step.json' && f !== 'escalate.json')) await gone(join(dir, 'out', e))
  }
}
