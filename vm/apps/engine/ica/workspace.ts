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

import { mkdir, writeFile, chmod, cp, symlink, readlink, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// The guide is generated from the engine's OWN shared prompts, so the tool and the system prompt can never
// describe different contracts — one module, two readers.
const guideImport = new URL('../agents/shared-prompts/authoring-reference.js', import.meta.url).href
const reviewImport = new URL('../answer-review.js', import.meta.url).href

// The display helpers describe themselves — see FORMAT_HELPERS. Adding one there teaches the agent about it,
// with no line here to remember to update.
import { formatHelpText } from '@superatom/scaffold'

export interface WorkspaceSpec {
  root: string                 // e.g. <repo>/vm/apps/workspace or an absolute scratch root
  projectId: string
  managerUrl?: string          // the datasource-manager (the ONE data seam), default http://localhost:4000
  context?: string             // freeform project description to drop into CONTEXT.md
}

export async function prepareWorkspace(s: WorkspaceSpec): Promise<string> {
  // ── HOW A PROJECT'S FILES ARE ORGANIZED (and why) ──────────────────────────────────────────────────────────
  // Under each project home (<root>/<projectId>/) there are TWO sibling folders, deliberately separated:
  //
  //   workspace/   the AGENT's write-root — the only place the agent works. It is the agent's cwd, and holds
  //                everything the agent should touch: programs/ + out/ (its work), the seams (data/ model/
  //                grounding/ concepts/ + .tools/ CLIs) it calls to reach data/model, CONTEXT.md, run.mjs.
  //                Organized by CONCERN, not dumped flat, so each concern keeps its seam + role doc together.
  //   db/          the ENGINE's PRIVATE state — project.sqlite (concepts/intents/graph), grounding.sqlite,
  //                answers.sqlite. The agent must NOT touch these, so they live OUTSIDE workspace/.
  //
  // WHY: an agent poking or corrupting the engine's own store would be a mess to debug. Keeping db/ out of the
  // agent's cwd means its normal `ls`/`find` never even surfaces our databases. This is HYGIENE, not a hard wall
  // (a determined shell can still reach `../db`) — the seams themselves reach the db by a relative path
  // (`../../db/…`), which is exactly how the engine reads/writes the same files from its side.
  const projectHome = join(s.root, s.projectId)
  const dir = join(projectHome, 'workspace')
  const dbDir = join(projectHome, 'db')
  // Organized by CONCERN, not dumped flat: each concern (data / model / grounding / analyst / connector) holds its
  // own seam + role doc together. CONTEXT.md + run.mjs stay at the workspace root as the entry point + runner.
  for (const sub of ['', 'data', 'model', 'grounding', 'analyst', 'connector', 'composer', 'concepts', 'units', 'programs', 'out', '.tools'])
    await mkdir(join(dir, sub), { recursive: true })
  await mkdir(dbDir, { recursive: true })   // engine-private, outside the workspace

  // ── `@superatom/*` MUST RESOLVE FROM THE PROJECT HOME ──────────────────────
  // `@superatom/*` is the standard specifier everywhere — the seams below, the units the agent writes, and
  // the docs that teach it. That is deliberate: it is OUR package namespace, it reads the same in generated
  // code as in the repo, and it stays correct wherever the code is moved to. So we do NOT bake absolute
  // paths as a workaround; we make the specifier resolve. (Absolute paths were considered and rejected: they
  // could only ever cover the seams, since the agent writes its own import lines.)
  //
  // Node resolves it by walking UP from the importing file looking for a node_modules that holds it. In the
  // shipped layout that is enough: the packages are dependencies of the workspace root (see the root
  // package.json), so pnpm links them into <root>/node_modules, and the state dir lives under the root —
  // /app/data/state/<project>/… walks up to /app/node_modules and finds them. Nothing to do here.
  //
  // It stops being enough when ENGINE_STATE_DIR points somewhere that is NOT under the root — a separate
  // mount, say. Then the walk never reaches the packages. So: ask Node, and only intervene if it says no.
  //
  // (Both halves were learned the hard way. The first fresh install had every seam fail with
  // ERR_MODULE_NOT_FOUND because resolution rested on a symlink someone had made by hand a fortnight
  // earlier and no code created — the agent could not look up a single concept, and answered by escalating.)
  const resolvesAlready = (() => {
    try { createRequire(join(projectHome, 'noop.js')).resolve('@superatom/scaffold'); return true }
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
      console.warn(`[workspace] ${projectHome} is not under the workspace root, so @superatom/* did not resolve; linked node_modules into it. Putting ENGINE_STATE_DIR under the root avoids this.`)
    } catch (e: any) {
      // Not fatal on its own — but every seam and every generated unit will fail, so say it rather than swallow it.
      console.warn(`[workspace] @superatom/* does not resolve from ${projectHome} and the fallback link failed — seams and generated units will not import: ${e?.message ?? e}`)
    }
  }

  // Seed READ-ONLY example programs into programs/ so the analyst learns the SHAPE of a program from a real,
  // correct one instead of reverse-engineering the engine source. They ship with the engine (versioned), use an
  // ILLUSTRATIVE fake schema (so they can't be copy-run — the analyst must adapt to the real source), and are
  // named example.* so reuse ignores them (reuse is node-based; examples are never registered as nodes).
  await cp(fileURLToPath(new URL('../examples', import.meta.url)), join(dir, 'programs'), { recursive: true, force: true }).catch(() => {})

  await writeFile(join(dir, 'CONTEXT.md'),
`# Project ${s.projectId} — workspace

Read this FIRST. It states the environment and the seams so you never probe or guess. Then read your
role file (./model/MODEL.md if you build the model, ./analyst/ANALYST.md if you answer questions).

## Environment
\`node\` and \`tsx\` are both on PATH and both run \`.mjs\`/\`.ts\`; every \`@superatom/*\` import resolves
from the monorepo, so there is nothing to install and no package.json to create. Run and explore code
however you see fit — there is no setup to do.

## Tools — just RUN these (they work from ANY directory, first try; each prints JSON to stdout)
Search the project's knowledge:
- \`./find-concept "<phrase or name>" [--full]\` → the NAMES of matching concepts — search whenever you need one; nothing is surfaced for you. Add \`--full\` for a matched concept's method. A query is required.
Query the data:
- \`./sources\`                        → the data sources + their kind/dialect.
- \`./find-schema "<term>" [--source <S>] [--full]\` → search ALL sources for where a field/table lives (SOURCE.TABLE.COLUMN : type); the fastest way to find where data is before querying.
- \`./query "<source>" "<query>"\`     → run a query against a source → JSON rows.
- \`./introspect "<source>" <tables|columns|sample|profile|verify-join> [args]\` → schema/evidence.
- \`./resolve "<text>"\`               → a fuzzy name/value → concrete ids (grounding).
Each prints JSON to stdout; run any of them with \`--help\` for its exact arguments. NEVER \`node\`/\`require\`/\`cat\` a \`.mjs\` to do these — just run the tool.

## Write/run seams (import these in your program/unit/model CODE — they take rich args, not a CLI)
- Concepts: ./model/model.mjs      — WRITE concepts: \`concept(name, props, meta)\`, \`getConcept(name, asOf?)\`, \`conceptHistory(name)\`. (To SEARCH, use \`./find-concept\`.)
- Ground: ./grounding/grounding.mjs — \`build(config)\` the grounding indexes (grounding agent).
- Data:   ./data/query.mjs         — \`query()\`/\`sources()\` inside program/unit code.
${formatHelpText().split('\n').map((l: string) => l ? `  ${l}` : l).join('\n')}
- Run:    ./run.mjs                — run a program: \`tsx run.mjs programs/<slug>/program.ts '<jsonParams>'\`.

## Layout
This folder is your whole workspace. The engine's databases (the model/graph, grounding, answers) live OUTSIDE it and you reach them only through the seams above — there is nothing for you to open directly.
- programs/ — one folder per answered question: \`program.ts\` + \`units/*.ts\`. This is where an ANSWER is built. The \`example.*\` folders are read-only REFERENCE TEMPLATES (illustrative fake schema) — read one for the SHAPE of a program (imports, units, ctx.use/ctx.query, the view unit), then write your OWN against your real source (\`./find-schema\`); never run one or point built.json at it.
- units/    — a shared library of earlier units you may read for reference.
- out/      — you write \`built.json\` here (a pointer to the program you built); the ENGINE runs it and writes \`answer.json\`.

## What a UNIT and a PROGRAM are
A UNIT is one file with three exports: \`meta\` (its MEANING — name, inputs, output), a \`default\` async
\`compute(ctx, params)\` (a function of its input; parameterised so it works for other inputs/dates — compute
relative time like "this month" from an \`asOf\` param, never a frozen date), and \`ui\` (\`{ category }\`).
A PROGRAM is just a unit with \`meta.concept === 'program'\` that COMPOSES units with \`ctx.use\` and ends in a
final UI unit. The kernel injects \`ctx\` with exactly four capabilities:
- \`query(sourceId, query, params)\` — query the source (\`./sources\` says what it is; the model tells you WHICH tables/joins).
- \`use(unitName, params)\`        — run/compose another unit (records the step + its output shape).
- \`decide(label, cond, reason)\`  — mark a branch: records which path and why; returns \`cond\`.
- \`log(message)\`                  — an optional human progress note (each step is auto-narrated anyway).
Running a program records a DAG + the SHAPE of each unit's output. Same shape on a re-run ⇒ the UI is reused;
a new shape ⇒ the UI is re-authored. So keep each unit's output structure stable across inputs.
${s.context ? '\n' + s.context + '\n' : ''}`)

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

  await writeFile(join(dir, 'model', 'model.mjs'),
`// The MODEL seam — how you WRITE what you learn. You CONSOLIDATE finished analyses into the concept layer.
// Concepts are a FLAT, time-versioned set (no tree). Where they are kept is the engine's business, not yours:
// a concept describes where the DATA lives and how a quantity is computed, never anything about this system. A concept is a GENERAL idea of computation — most are lean (a value + one or two facets); the
// data-model block (measures/dimensions/…) is an OPTIONAL specialization for entities/measures only.
//   concept(name, props, meta)  — upsert a concept (versioned). meta: { changedBy, reason? }. props:
//        { value, aliases?, status:'unverified'|'corroborated'|'verified', rules?, requires?, supersedes?,
//          find?, compute?, present?,           ← general facets; compute is a runnable query
//          source?, grain?, keying?, time?, measures?, dimensions?, parameters?, provenance? }  ← optional
//   getConcept(name, asOf?)  — the live concept, or (asOf = unix ms) the version live at that instant
//   conceptHistory(name)     — the full timeline (each version + who/when/why)
//   concepts() · intents() · units() · put(node) · edge({from,to,type,props}) · node(id) · search(q)
//
import { NodeStore, upsertConcept as _c, getConcept as _g, conceptHistory as _ch } from '@superatom/node-store'
import { fileURLToPath } from 'node:url'
const store = new NodeStore(fileURLToPath(new URL('../../db/project.sqlite', import.meta.url)))
export const concept = (name, props, meta) => _c(store, name, props, meta)
export const getConcept = (name, asOf) => _g(store, name, asOf)
export const conceptHistory = (name) => _ch(store, name)
export const concepts = () => store.listKind('concept')
export const intents  = () => store.listKind('intent')
export const units    = () => store.listKind('unit')
export const put  = (n) => store.putNode(n)
export const edge = (e) => store.putEdge(e)
export const node = (id) => store.getNode(id)
export const search = (q, opts) => store.search(q, opts)
// find(...terms): RECON. Run a search per term (probe several angles of what you think you need), dedupe, and
// return a COMPACT view (id, kind, name, summary, key props) so you can inspect + judge fit fast. Then use
// getConcept(name) / node(id) for full detail on a candidate. Kept simple on purpose.
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
// stdout says it RAN, where the full result is, and the shape of what came back. The result itself — output,
// DAG, per-unit shapes — goes to that program's program.json, which is also what the engine reads.
//
// IT USED TO PRINT THE WHOLE OUTPUT. That is how an agent came to ship a twenty-row ranking of identical
// zeros: it received the entire table, said "Built and verified", and committed. It had the data and skimmed
// it. So stdout now carries the SHAPE — "1 distinct (0)" cannot be skimmed the way twenty zeros can — plus
// the path, so anything larger is fetched deliberately with whatever tool suits it, at any size.
//
// And the review line lives HERE, not in the system prompt, because it belongs beside the thing being
// reviewed: it arrives every time a program runs, at the moment there is something to read, rather than six
// kilobytes earlier in an instruction competing with finishing the turn.
// ctx.use resolves unit names from <program>/units then <program>.
import { runProgram } from '@superatom/scaffold'
import { describeShape } from ${JSON.stringify(reviewImport)}
import { writeFile, appendFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
// WHAT THE PROGRAM IS DOING, WHILE IT DOES IT. Two destinations, because there are two readers.
//   stderr — you, if you ran this yourself in a terminal.
//   ../run-events.jsonl — the engine, which tails it and turns each line into a live event for the user.
//
// A file because the program runs in its OWN OS PROCESS, started either by the engine or by the agent from its
// shell — and it is the agent's runs that go quiet for minutes. A pipe would only carry the engine's. This
// wrapper is the one thing both paths share, so the trace is identical either way.
//
// OUTSIDE the workspace, beside db/, for the same reason the databases are: this is the engine's business, not
// the agent's. In out/ it would sit next to built.json in a directory the agent is told to write to, and an
// unexplained file there is something to be read, tidied away, or wondered about.
//
// A SPOOL, not a log. Every line is consumed the moment it is read, so history has no value — it is truncated
// once it grows, which keeps a workspace from accumulating a file nobody will ever open.
const EVENTS = join(process.cwd(), '..', 'run-events.jsonl')
const SPOOL_MAX = 2 * 1024 * 1024
// WHOSE RUN THIS IS. One workspace serves every chat in a project, so the spool is shared and a reader has to
// know which turn each line belongs to — otherwise two people asking at once see each other's queries. The
// engine sets these when it starts a program; when the AGENT starts one they are inherited from the agent's
// own session if its harness can carry them, and absent otherwise (the reader then attributes by which session
// has a run in flight, and delivers to nobody rather than to the wrong person when that is ambiguous).
const OWNER = { qid: process.env.SA_QID || undefined, sid: process.env.SA_SID || undefined }
const run = String(Date.now()) + '-' + process.pid   // several programs can be in flight in one workspace
async function main() {
  const [, , entry, paramsJson] = process.argv
  if (!entry) { console.error('usage: tsx run.mjs <programs/<slug>/program.ts> [jsonParams]'); process.exit(1) }
  const params = paramsJson ? JSON.parse(paramsJson) : {}
  await mkdir(dirname(EVENTS), { recursive: true }).catch(() => {})
  const note = (ev) => appendFile(EVENTS, JSON.stringify({ ...ev, ...OWNER, run, program: entry, at: Date.now() }) + '\\n').catch(() => {})
  // Truncate at the START of a run, never during one: the reader tolerates the file shrinking (it re-reads from
  // the top) but doing it mid-run would drop this run's own earlier lines before anyone had seen them.
  try { if ((await stat(EVENTS)).size > SPOOL_MAX) await writeFile(EVENTS, '') } catch { /* no file yet */ }
  await note({ t: 'program:start' })
  try {
    const r = await runProgram({ entry, params, emit: (t) => process.stderr.write('  ' + t + '\\n'), onEvent: note })
    const manifest = { root: r.root, ui: r.ui, finalShapeHash: r.finalShapeHash, ms: r.ms,
      nodes: r.nodes.map(n => ({ id: n.id, unit: n.unit, kind: n.kind, ms: n.ms, rows: n.rows, shapeHash: n.shapeHash })),
      edges: r.edges, branches: r.branches, output: r.output }
    await writeFile(join(dirname(entry), 'program.json'), JSON.stringify(manifest, null, 2))
    process.stderr.write(\`\\n  graph: \${r.nodes.length} nodes, \${r.edges.length} edges, \${r.branches.length} branches · shape \${r.finalShapeHash} · \${r.ms}ms\\n\`)
    await note({ t: 'program:end', ms: r.ms, nodes: r.nodes.length })
    const rel = join(dirname(entry), 'program.json')
    console.log('\u2713 ran \u00b7 full output \u2192 ' + rel)
    for (const line of describeShape(r.output)) console.log('  ' + line)
    console.log('')
    console.log('Read the output as the person who asked would. Empty, sidesteps the question, or figures that')
    console.log('plainly do not fit \u2014 fix it or escalate.')
  } catch (e) {
    // A crash is the most useful event of all — it is the one the watcher is waiting to hear about, and
    // without it a failed program is indistinguishable from a slow one right up until the turn gives up.
    await note({ t: 'program:failed', error: String(e?.message ?? e).slice(0, 400) })
    throw e
  }
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
import { rawQuery, sources } from './query.mjs'   // introspect reads catalogs in raw dialect SQL (trusted system path)
export async function forSource(id) {
  const s = (await sources()).find(x => x.id === id)
  if (!s) throw new Error('unknown source: ' + id + ' (call sources() to list)')
  return getIntrospect(s.dialect, rawQuery, id)
}
`)

  await writeFile(join(dir, 'concepts', 'find.mjs'),
`// The CONCEPT seam — knowledge whose discovery has already been paid for. Each concept says WHERE the data
// lives, HOW to compute it (a runnable query step-list), HOW to present it, and its REVIEW checks. You answer by REWRITING the concepts that fit into your program — a
// concept is a GUIDE, never an import.
//   findConcept('revenue by pillar')  → up to \`limit\` matching concepts (guide fields), best match first
//   listConcepts()                    → every concept's phrase (the menu) — see what exists before you search
import { NodeStore } from '@superatom/node-store'
import { fileURLToPath } from 'node:url'
const store = new NodeStore(fileURLToPath(new URL('../../db/project.sqlite', import.meta.url)))
const propsOf = (n) => (typeof n.props === 'string' ? JSON.parse(n.props || '{}') : (n.props || {}))
const guide = (n) => { const { _v, ...g } = propsOf(n); return { name: n.label, version: _v?.version, ...g } }   // name = the label; hide raw version metadata
// SPECIFICITY ranking (same idea the engine uses to surface concept names): a concept's NAME is its set of
// selector-words; the concept whose selector the query covers the MOST wins (most-specific match), falling back
// to fewer-word / more-general concepts. Pure lexical. Returns the top specificity tier (within 1 of the best).
const C_STOP = new Set(('a an the of on in for by per to and or is are was be with as at this that it id what ' +
  'which who how me my we our you your can do get give show tell find value from over under across').split(' '))
const stemw = (w) => { for (const suf of ['ing','ed','es','s','ly']) { if (w.endsWith(suf) && w.length - suf.length >= 3) { w = w.slice(0, -suf.length); break } } if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1); return w }
const cWords = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !C_STOP.has(w)).map(stemw))
export function findConcept(query, limit = 8) {
  const qw = cWords(query)
  if (!qw.size) return []
  const rows = store.db.prepare("SELECT * FROM nodes WHERE kind = 'concept' AND valid_to IS NULL").all()
  const scored = rows
    .map((n) => { const cw = cWords(n.label); if (!cw.size) return { n, matched: 0, cover: 0 }; let m = 0; for (const w of cw) if (qw.has(w)) m++; return { n, matched: m, cover: m / cw.size } })
    .filter((x) => x.matched > 0)
    .sort((a, b) => (b.matched - a.matched) || (b.cover - a.cover))
  return scored.slice(0, limit).map((x) => guide(x.n))   // generous: top matches by specificity (best first), no tight tier — the agent filters
}
export function listConcepts() {
  return store.db.prepare("SELECT label FROM nodes WHERE kind = 'concept' AND valid_to IS NULL ORDER BY label").all()
    .map((r) => r.label).filter(Boolean)
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
const store = new GroundingStore(fileURLToPath(new URL('../../db/grounding.sqlite', import.meta.url)), { source })
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

  // ── Search TOOLS: robust, CWD-independent bash wrappers over the seams ────────────────────────────────────
  // The agents kept failing to search (require() an ESM file, `node` not resolving @superatom, a relative path
  // from the wrong CWD) then falling back to `ls`. These wrappers END that: each bakes the ABSOLUTE workspace
  // path and runs its driver with tsx (node can't resolve node-store's .ts imports; tsx can), so `./find-*`
  // returns clean JSON on the FIRST try from ANY directory. The agent never reads the .mjs source.
  const drivers: Record<string, string> = {
    'find-concept': `// Concepts. "<phrase>" → the NAMES of matching concepts (+ how many exist in total, so an empty library is distinguishable from no match). Read one with \`./get-concept "<exact name>"\`. A query is required.
import { findConcept, listConcepts } from ${JSON.stringify(join(dir, 'concepts', 'find.mjs'))}
const q = process.argv.slice(2).join(' ').trim()
const total = listConcepts().length
if (!q) { console.log(JSON.stringify(total ? { total, note: total + ' concepts in the library — pass a phrase to search' } : { total: 0, note: 'the concept library is empty (0 concepts)' })); process.exit(0) }
const matched = findConcept(q).map(c => c.name)
console.log(JSON.stringify({ matched, of: total, note: total === 0 ? 'the concept library is empty (0 of 0)' : (matched.length + ' matched of ' + total + ' concepts') + (matched.length ? ' — read one with ./get-concept "<name>"' : '') }, null, 2))
`,
    'get-concept': `// ONE concept, in full guide form: "<exact name>" (as listed by ./find-concept). Returns the guide only — what it is, its rules, where the data lives, how to compute it, how to present it.
import { findConcept, listConcepts } from ${JSON.stringify(join(dir, 'concepts', 'find.mjs'))}
const name = process.argv.slice(2).join(' ').trim()
if (!name) { console.log(JSON.stringify({ error: 'a concept name is required — list them with ./find-concept "<phrase>"' })); process.exit(0) }
const norm = (x) => String(x || '').toLowerCase().replace(/\\s+/g, ' ').trim()
const hit = findConcept(name, 50).find(c => norm(c.name) === norm(name))
if (!hit) {
  const near = findConcept(name, 5).map(c => c.name)
  console.log(JSON.stringify({ error: 'no concept by that exact name', didYouMean: near, note: 'names come from ./find-concept' }, null, 2))
  process.exit(0)
}
// The GUIDE fields only. Retrieval metadata (aliases), audit trail (evidence, provenance, verifiedAt) and
// versioning are what got this concept FOUND and TRUSTED — they are not instructions for writing a program,
// so they stay out of the caller's context.
const KEEP = ['name', 'value', 'status', 'rules', 'requires', 'supersedes', 'dataSource', 'find', 'compute', 'present', 'review', 'source', 'grain', 'keying', 'time', 'measures', 'dimensions', 'parameters']
const out = {}
for (const k of KEEP) if (hit[k] !== undefined) out[k] = hit[k]
console.log(JSON.stringify(out, null, 2))
`,
    'get-program': `// ONE program, in full: every question form it answers, its saved params, its category.
// The shortlist (./find-program) says which one to open; this opens it. Read its code from programs/<name>/.
import { NodeStore } from '@superatom/node-store'
const store = new NodeStore(${JSON.stringify(join(dbDir, 'project.sqlite'))})
const name = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ').trim()
if (!name) { console.log(JSON.stringify({ hint: 'get-program <program>   — one program, with every question form it answers and its saved params' })); process.exit(0) }
const P = (n) => (typeof n.props === 'string' ? JSON.parse(n.props || '{}') : (n.props || {}))
const strip = (d) => String(d || '').replace('programs/', '')
const want = strip(name)
const questions = []
const params = {}
let found = null
for (const h of store.search(want, { limit: 40 })) {
  const p = P(h)
  const dir = h.kind === 'program' ? p.dir : p.program
  if (!dir || strip(dir) !== want) continue
  if (!found) found = { program: dir, category: p.category }
  const qs = h.kind === 'program' ? h.label : (p.question || h.label)
  if (qs && !questions.includes(qs)) questions.push(qs)
  if (p.params && typeof p.params === 'object') Object.assign(params, p.params)
}
console.log(JSON.stringify(found ? { program: found.program, category: found.category, answers: questions, params } : { error: 'no such program: ' + name }, null, 2))
`,
    'find-schema': `// Datasource index. "<term>" = matching fields across ALL sources (SOURCE.CONTAINER.FIELD : type). Search by field/table name, by type (date/number), or by what a column MEANS. --source <S> filters to one source; --full adds PK/nullable/references.
import { NodeStore, searchDataSource } from '@superatom/node-store'
const store = new NodeStore(${JSON.stringify(join(dbDir, 'project.sqlite'))})
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
    'authoring-guide': `// The authoring guide — how to WRITE a program: the contract types, the mechanics, the canonical example.
// Pulled rather than preloaded. It is only needed once the agent is about to write a unit, and most turns reuse
// an existing program instead — so it lives here rather than in every question's system prompt. Read it when
// you are ready to write, or again if a long turn has pushed it out of context.
import { authoringGuide } from ${JSON.stringify(guideImport)}
const type = process.argv.slice(2).filter((a) => !a.startsWith('-'))[0] || 'default'
console.log(authoringGuide(type))
`,
    'find-program': `// Programs that answered a similar question — the SHORTLIST: what each answers, and its name.
// Deliberately no params and no source: a list is for choosing which one to look at. ./get-program <name> opens one.
import { NodeStore } from '@superatom/node-store'
const store = new NodeStore(${JSON.stringify(join(dbDir, 'project.sqlite'))})
const q = process.argv.slice(2).filter(a => !a.startsWith('--')).join(' ').trim()
const P = (n) => (typeof n.props === 'string' ? JSON.parse(n.props || '{}') : (n.props || {}))
const out = []
for (const h of store.search(q, { limit: 20 })) {
  const p = P(h)
  const row = h.kind === 'intent' && p.program ? { question: p.question ?? h.label, program: p.program, category: p.category }
            : h.kind === 'program' ? { question: h.label, program: p.dir, category: p.category }
            : null
  if (row) out.push(row)
}
const seen = new Set()
console.log(JSON.stringify(out.filter(o => o.program && !seen.has(o.program) && seen.add(o.program)).slice(0, 8), null, 2))
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
  // Each tool is SELF-DOCUMENTING: `<tool> --help` prints how to use it (args/subcommands) — so the agent
  // never needs to read the .mjs to learn what to pass, and never sees the implementation.
  const usages: Record<string, string> = {
    'find-concept': 'find-concept "<phrase>"   → the NAMES of matching concepts. A query is required. Read one with get-concept.',
    'get-concept':  'get-concept "<exact name>"   → ONE concept\'s guide: what it is, its rules, where the data lives, how to compute and present it',
    'find-schema':  'find-schema "<term>" [--source <SOURCE>] [--full]   → search ALL datasources for a field/table by name, type, or description (SOURCE.TABLE.COLUMN : type); --source filters to one; --full adds PK/nullable/references',
    'authoring-guide': 'authoring-guide [type]   → how to WRITE a program: the contract, the mechanics, the canonical example. Read it when you are about to write.',
    'find-program': 'find-program "<question>"   → the shortlist: programs that answered a similar question (what it answers · name · category)',
    'get-program': 'get-program <program>   → ONE program in full: every question form it answers, its saved params, its category',
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

  return dir
}
