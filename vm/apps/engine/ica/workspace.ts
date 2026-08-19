// ── ICA working directory ────────────────────────────────────────────────────
// Every ICA run operates in a real directory we create and FILL with the project's
// context, then harvest from afterwards. The agent reads the context, writes new
// units / UI / semantic-model code here, and we collect what it produced.
//
// Layout (per project; a run reuses the project dir so context accumulates):
//   <root>/<projectId>/
//     CONTEXT.md          — what the project is, the data sources, conventions
//     query.mjs           — the ONLY data access: query(dataSourceId, sql, params)
//     semantic/           — the partial semantic-model DAG (code + metadata)  [filled over time]
//     units/              — the partial UNIT library                          [filled over time]
//     out/                — where the agent writes this run's answer + UI

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface WorkspaceSpec {
  root: string                 // e.g. <repo>/vm/apps/workspace or an absolute scratch root
  projectId: string
  managerUrl?: string          // the datasource-manager (the ONE data seam), default http://localhost:4000
  context?: string             // freeform project description to drop into CONTEXT.md
}

export async function prepareWorkspace(s: WorkspaceSpec): Promise<string> {
  const dir = join(s.root, s.projectId)
  // Organized by CONCERN, not dumped flat. db/ holds every SQLite file; each concern (data / model /
  // grounding / analyst / connector) holds its own seam + role doc together. CONTEXT.md + run.mjs stay at
  // the root as the entry point + the program runner.
  for (const sub of ['', 'db', 'data', 'model', 'grounding', 'analyst', 'connector', 'units', 'programs', 'out'])
    await mkdir(join(dir, sub), { recursive: true })

  await writeFile(join(dir, 'CONTEXT.md'),
`# Project ${s.projectId} — workspace

Read this FIRST. It states the environment and the seams so you never probe or guess. Then read your
role file (./model/MODEL.md if you build the model, ./analyst/ANALYST.md if you answer questions).

## Environment
\`node\` and \`tsx\` are both on PATH and both run \`.mjs\`/\`.ts\`; every \`@superatom/*\` import resolves
from the monorepo, so there is nothing to install and no package.json to create. Run and explore code
however you see fit — there is no setup to do.

## Seams (grouped by concern)
- **Model — check FIRST.** ./model/model.mjs — what's already been figured out for this project. Probe it before
  touching data: \`find('term', …)\` (search concepts/units/past questions), \`concepts()\`, \`intents()\`,
  \`getConcept(name)\`, \`relationships(name)\`, \`conceptTree()\`. Reusing a modeled unit is deterministic and
  carries the corrections we've made — that's why it comes first.
- Data:       ./data/query.mjs      — use this to query the data source: \`query(sourceId, sql, params)\` + \`sources()\`.
- Introspect: ./data/introspect.mjs — schema/evidence helpers over the data.
- Grounding:  ./grounding/grounding.mjs — resolve a fuzzy human reference to concrete ids: \`resolveEntity(text)\`,
  \`resolveHierarchy(node, dir, name)\`, \`resolveValueByPattern(value)\` (built per-project by the grounding agent).
- Run:        ./run.mjs        — run a program: \`tsx run.mjs programs/<slug>/program.ts '<jsonParams>'\` (prints the output; writes the graph/shape to program.json).

## Layout
- db/       — every SQLite database (project.sqlite = the model/graph, grounding.sqlite, answers.sqlite). You never open these directly — the seams do.
- programs/ — one folder per answered question: \`program.ts\` + \`units/*.ts\`. This is where an ANSWER is built.
- units/    — a shared library of earlier units you may read for reference.
- out/      — you write \`built.json\` here (a pointer to the program you built); the ENGINE runs it and writes \`answer.json\`.

## What a UNIT and a PROGRAM are
A UNIT is one file with three exports: \`meta\` (its MEANING — name, inputs, output), a \`default\` async
\`compute(ctx, params)\` (a function of its input; parameterised so it works for other inputs/dates — compute
relative time like "this month" from an \`asOf\` param, never a frozen date), and \`ui\` (\`{ category }\`).
A PROGRAM is just a unit with \`meta.concept === 'program'\` that COMPOSES units with \`ctx.use\` and ends in a
final UI unit. The kernel injects \`ctx\` with exactly four capabilities:
- \`query(sourceId, sql, params)\` — query the data source (your SQL/API; the model tells you WHICH tables/joins).
- \`use(unitName, params)\`        — run/compose another unit (records the step + its output shape).
- \`decide(label, cond, reason)\`  — mark a branch: records which path and why; returns \`cond\`.
- \`log(message)\`                  — an optional human progress note (each step is auto-narrated anyway).
Running a program records a DAG + the SHAPE of each unit's output. Same shape on a re-run ⇒ the UI is reused;
a new shape ⇒ the UI is re-authored. So keep each unit's output structure stable across inputs.
${s.context ? '\n' + s.context + '\n' : ''}`)

  await writeFile(join(dir, 'data', 'query.mjs'),
`// The data seam. You never see databases, ports, dialects, or credentials — you call
// query(dataSourceId, sql, params). There is ONE endpoint: the datasource-manager, which routes
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
export async function sources() {   // list data sources + their kind/dialect
  const r = await fetch(MANAGER + '/sources'); return (await r.json()).sources
}
`)

  await writeFile(join(dir, 'model', 'model.mjs'),
`// The MODEL seam. The semantic model is CONCEPT + UNIT nodes in ../db/project.sqlite — the SAME node-store
// graph the intent nodes and units already live in (one project, one store — no separate model DB).
// You CONSOLIDATE finished analyses into this concept layer:
//   concept(name, props, summary?)     — upsert an entity/concept. props:
//        { status:'verified'|'candidate'|'blocked', grain, time:'snapshot'|'during'|'trailing', asOf,
//          measures:[{name,additive,stock,note}], dimensions:[{name,values}], parameters:[{name,default,learned}],
//          rules:[..], identity, source, unit }   ← one entity = one parameterised unit (its id)
//   relate(fromName, toName, rel)       — a typed edge. rel: { via, cardinality:'N:1'|'1:1'|'N:N', coverage, ok }
//   bindUnit(name, unitId)             — bind a concept to its one big unit (immutable)
//   setParent(childName, parentName?)  — place a concept in the TREE under a parent (omit/'root' → the root)
//   getConcept(name) · relationships(name) · concepts() · intents() · units() · conceptTree()
//   put(node) · edge({from,to,type,props}) · node(id) · search(q)   — low-level (register unit/program nodes)
// The concept layer is a TREE (root → concepts → their unit): every concept has ONE parent (a broader
// composite concept, or the root) via setParent, is 'simple' (one unit) or 'composite' (has sub-concepts)
// via props.form, and may declare parameters. Units are IMMUTABLE; the concept tree is what you rearrange.
//
// SEMANTIC ATOMS — small typed knowledge units indexed by an entity NAME (a simple word/phrase). Each says,
// about one subject: where it lives, how to compute/join it, how a value resolves, or — most valuable — how
// RELIABLE a path is (data-quality). Atoms are usage-learned (from real analysis), never invented cold.
//   putAtom({ atomKind:'where-to-find'|'how-to-compute'|'how-to-join'|'resolution-method'|'data-quality',
//             subject, location?, method?, coverage?, confidence?, evidence?, provenance?, note?, source? })
//        — write/update. Re-emitting the SAME content is a no-op; DIFFERENT content VERSIONS the atom (the old
//          one is archived + timestamped and kept, the new one goes live, linked back). Never a silent overwrite.
//   atomsFor(subject) · findAtoms({subject?,atomKind?,q?}) · atomHistory(id)   — read (live only; history = all versions)
import { NodeStore, upsertConcept as _c, relate as _r, bindUnit as _b, getConcept as _g, relationships as _rel, setParent as _sp, conceptTree as _ct,
  putAtom as _pa, findAtoms as _fa, atomsFor as _af, atomHistory as _ah } from '@superatom/node-store'
import { fileURLToPath } from 'node:url'
const store = new NodeStore(fileURLToPath(new URL('../db/project.sqlite', import.meta.url)))
export const concept = (name, props, summary) => _c(store, name, props, summary)
export const relate = (fromName, toName, rel) => _r(store, fromName, toName, rel)
export const bindUnit = (name, unitId) => _b(store, name, unitId)
export const setParent = (childName, parentName) => _sp(store, childName, parentName)
export const getConcept = (name) => _g(store, name)
export const relationships = (name) => _rel(store, name)
export const conceptTree = () => _ct(store)
export const putAtom = (atom) => _pa(store, atom)
export const findAtoms = (opts) => _fa(store, opts)
export const atomsFor = (subject) => _af(store, subject)
export const atomHistory = (id) => _ah(store, id)
export const concepts = () => store.listKind('concept')
export const intents  = () => store.listKind('intent')
export const units    = () => store.listKind('unit')
export const put  = (n) => store.putNode(n)
export const edge = (e) => store.putEdge(e)
export const node = (id) => store.getNode(id)
export const search = (q, opts) => store.search(q, opts)
// find(...terms): RECON. Run a search per term (probe several angles of what you think you need), dedupe, and
// return a COMPACT view (id, kind, name, summary, key props) so you can inspect + judge fit fast. Then use
// getConcept(name) / relationships(name) / node(id) for full detail on a candidate. Kept simple on purpose.
export const find = (...terms) => {
  const seen = new Map()
  for (const t of terms.flat()) for (const h of store.search(String(t), { limit: 8 }))
    if (!seen.has(h.id)) seen.set(h.id, { id: h.id, kind: h.kind, name: h.label, summary: h.summary, props: h.props })
  return [...seen.values()]
}
export const raw = store
export default store
`)

  await writeFile(join(dir, 'run.mjs'),
`// The RUN seam. Execute a program through the kernel and see what it produces:
//   tsx run.mjs programs/<slug>/program.ts '{"someParam":"value"}'
// The rendered output goes to stdout; the provenance (DAG + per-unit shape + output) is written to
// that program's program.json. ctx.use resolves unit names from <program>/units then <program>.
import { runProgram } from '@superatom/scaffold'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
async function main() {
  const [, , entry, paramsJson] = process.argv
  if (!entry) { console.error('usage: tsx run.mjs <programs/<slug>/program.ts> [jsonParams]'); process.exit(1) }
  const params = paramsJson ? JSON.parse(paramsJson) : {}
  const r = await runProgram({ entry, params, emit: (t) => process.stderr.write('  ' + t + '\\n') })
  const manifest = { root: r.root, ui: r.ui, finalShapeHash: r.finalShapeHash, ms: r.ms,
    nodes: r.nodes.map(n => ({ id: n.id, unit: n.unit, kind: n.kind, ms: n.ms, rows: n.rows, shapeHash: n.shapeHash })),
    edges: r.edges, branches: r.branches, output: r.output }
  await writeFile(join(dirname(entry), 'program.json'), JSON.stringify(manifest, null, 2))
  process.stderr.write(\`\\n  graph: \${r.nodes.length} nodes, \${r.edges.length} edges, \${r.branches.length} branches · shape \${r.finalShapeHash} · \${r.ms}ms\\n\`)
  console.log(JSON.stringify(r.output, null, 2))
}
main().catch((e) => { console.error(e); process.exit(1) })
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
import { query, sources } from './query.mjs'
export async function forSource(id) {
  const s = (await sources()).find(x => x.id === id)
  if (!s) throw new Error('unknown source: ' + id + ' (call sources() to list)')
  return getIntrospect(s.dialect, query, id)
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
import { query as _query, sources as _sources } from '../data/query.mjs'
let _default
async function defaultSource() { if (!_default) _default = (await _sources())[0]?.id; return _default }
// The live data seam: routes each spec's SQL to its named source (or the sole source) and binds @name params.
// Hierarchies of the live kinds (column/derived-query/cross-source) resolve THROUGH this at query time — the
// source's own tree is the single source of truth, so results are always fresh and nothing is copied/synced.
const source = async (sql, src, params) => _query(src ?? await defaultSource(), sql, params ?? {})
const store = new GroundingStore(fileURLToPath(new URL('../db/grounding.sqlite', import.meta.url)), { source })
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
  return dir
}
