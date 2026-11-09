// ── THE AGENT'S WORKING DIRECTORY ────────────────────────────────────────────────────────────────────────────
//
// Under each project home (<root>/<projectId>/):
//
//   sessions/<id>/  one conversation's directory — the composer's cwd for that conversation
//   workspace/      the shared directory — the analyst, grounding and connector agents work here
//   db/             the ENGINE's private state: composition.sqlite (the agents' knowledge), datasource-index.sqlite
//                   (./find-schema), grounding.sqlite, agent-sessions.sqlite. Outside every agent's cwd, so an `ls`
//                   never surfaces it.
//
// In its directory an agent finds the tools for its part, generated here with the absolute paths they need:
//
//   the data             ./sources ./find-schema ./get-schema ./query   (./resolve: kept, not given for now)
//
// Which turn is live is in .turn, which data session this conversation is in .session — both written by the engine
// before it asks. A turn's files are in out/<qid>/.

import { askSocket, toolSocketOf } from '../tool-socket.js'
import { mkdir, writeFile, chmod, symlink, readlink, rm, readdir, rename, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { shareWithAgents } from '../agent-user.js'
import { fileURLToPath } from 'node:url'

/** The data seam a program imports as data/query.mjs: every read goes through the datasource manager, never a source directly. */
export const dataSeam = (managerUrl: string) => `// The data seam. You never see databases, ports, dialects, or credentials — you call
// query(dataSourceId, query, params) — the manager runs the query against the source. There is ONE endpoint: the datasource-manager, which routes
// by id to the right bridge; the bridge binds @name params in its own dialect and runs the query.
// Ask the manager 'GET /sources' for each source's kind/dialect BEFORE writing queries.
// THE ASKER'S DATA ACCESS comes with every read: a ticket the engine signs for whoever the work is for (their data
// access policies inside it). An agent's turn finds it beside this folder (.ticket); a program run for someone is
// handed it (SA_TICKET). The manager reads only what the ticket allows, and nothing without one.
import { readFileSync } from 'node:fs'
const MANAGER = process.env.DATASOURCE_URL ?? '${managerUrl}'
const TICKET = new URL('../.ticket', import.meta.url)
export function ticket() {
  let t = process.env.SA_TICKET ?? ''
  if (!t) try { t = readFileSync(TICKET, 'utf8').trim() } catch { t = '' }
  if (t === 'unchecked') throw new Error('your data access could not be checked — nothing was read')
  if (!t) throw new Error('this work carries no data access ticket — nothing was read')
  return t
}
// The tables this reader may not read, as their ticket says (its policies): hidden from what the index tools show them
// too. "SOURCE.table" in lower case. Read, not verified — hiding is the manager's to enforce, this only matches it.
export function denied() {
  const out = new Set()
  let t = ''
  try { t = ticket() } catch { return out }
  try {
    const p = JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString('utf8'))
    for (const [src, list] of Object.entries(p.policies ?? {})) for (const x of list ?? []) if (x && x.deny && x.table) out.add((src + '.' + String(x.table).split('.').pop()).toLowerCase())
  } catch { /* a ticket that cannot be read hides nothing; the manager refuses it */ }
  return out
}
export async function query(dataSourceId, sql, params = {}) {
  const r = await fetch(MANAGER + '/query', { method:'POST', headers:{'content-type':'application/json', 'x-sa-ticket': ticket()},
    body: JSON.stringify({ id: dataSourceId, sql, params }) })
  if (!r.ok) { const e = await r.text(); let m = e; try { m = JSON.parse(e).error ?? e } catch {} ; throw new Error(m) }
  const p = await r.json(); if (p?.error) throw new Error(p.error)
  const rows = p?.rows ?? []
  // What the manager says about a result that changes how it must be read (a result that reached the row limit)
  // goes to stderr, where whoever ran this sees it, and rides on the rows for a script that wants to check.
  if (Array.isArray(p?.notes) && p.notes.length) { for (const n of p.notes) console.error('NOTE: ' + n); Object.defineProperty(rows, 'notes', { value: p.notes }) }
  if (p?.cappedTo != null) Object.defineProperty(rows, 'cappedTo', { value: p.cappedTo })
  return rows
}
export async function sources() {   // list data sources + their kind/dialect
  const r = await fetch(MANAGER + '/sources', { headers: { 'x-sa-ticket': ticket() } })
  const b = await r.json(); if (!r.ok) throw new Error(b?.error ?? String(r.status)); return b.sources
}
`

export interface WorkspaceSpec {
  root: string
  projectId: string
  managerUrl?: string
  /** The project's committed configuration directory (settings.json). */
  projectDir?: string
  /** One conversation, one working directory: when given, the agent works in sessions/<sessionId>. */
  sessionId?: string
  /** A conversation's directory, or the shared workspace where the analyst, connector and grounding agents work.
   *  Both have the data tools. */
  tools?: 'conversation' | 'shared'
}

export async function prepareWorkspace(s: WorkspaceSpec): Promise<string> {
  const projectHome = join(s.root, s.projectId)
  // A session's agent works in its own folder INSIDE the session (work/), never beside the session's own files (its log,
  // STATE.json, ANSWER_HISTORY.jsonl, answers, attachments), so nothing an agent does in its folder can touch them.
  const dir = s.sessionId ? join(projectHome, 'sessions', s.sessionId, 'work') : join(projectHome, 'workspace')
  const dbDir = join(projectHome, 'db')
  // The engine's tool server (tool-socket.ts): the tools that read the engine's knowledge ask it, never its files.
  const socket = toolSocketOf(s.projectDir ?? process.env.ENGINE_PROJECT_DIR ?? projectHome)
  const managerUrl = s.managerUrl ?? 'http://localhost:4000'

  // @superatom/* must resolve from the project home for the data seams below. Project homes live outside the repository
  // (~/.superatom/<project>), where Node finds no node_modules by walking up, so the project home links to the engine's
  // by absolute path — always checked, never assumed: a resolution test from inside the engine's process answers for
  // the engine's environment (NODE_PATH under pm2), not for the tool's own process, which found nothing. A relative
  // link breaks when the home moves, so it is replaced.
  try {
    const link = join(projectHome, 'node_modules')
    const target = fileURLToPath(new URL('../node_modules', import.meta.url))   // apps/engine/node_modules
    const current = await readlink(link).catch(() => null)
    if (current !== target) {
      if (current !== null) await rm(link, { force: true })
      if (existsSync(target)) { await symlink(target, link, 'dir'); console.log(`[workspace] linked ${link} → ${target}`) }
    }
  } catch (e: any) {
    // Not fatal on its own — but every data seam will fail, so say it rather than swallow it.
    console.warn(`[workspace] @superatom/* does not resolve from ${projectHome} and the link failed — the data seams will not import: ${e?.message ?? e}`)
  }
  // The project's home, where its model is. Every agent in the shared workspace writes the same tools, so each resolves
  // it the way the engine does (ENGINE_PROJECT_DIR, else the project home) when its caller does not say.
  const projectDir = s.projectDir ?? process.env.ENGINE_PROJECT_DIR ?? projectHome
  const conversation = s.tools === 'conversation'
  for (const sub of ['', 'data', 'grounding', 'out', '.tools']) await mkdir(join(dir, sub), { recursive: true })
  await mkdir(dbDir, { recursive: true })



  if (!conversation) await writeFile(join(dir, 'CONTEXT.md'),
`# Project ${s.projectId}

The data sources: ./sources lists them, ./find-schema searches their fields, ./get-schema shows a source's tables or a
table's fields, and ./query reads them. data/query.mjs and grounding/grounding.mjs are the seams to
import.
Every tool explains itself with --help.

What a tool gives back is shaped by what it is for. Something to weigh — a node, the readings of a question, a
refusal — is written to be read, since what sits next to what is the point of it. Something to use — paths, keys,
rows — is given as JSON, and --json asks for that where both make sense. A long answer is kept whole on disk and
its beginning shown, with where the rest is: take what you need from it with grep or jq rather than reading it all.
`)

  await writeFile(join(dir, 'data', 'query.mjs'), dataSeam(s.managerUrl ?? 'http://localhost:4000'))

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
import { query as _query, sources as _sources } from '../data/query.mjs'   // grounding reads as whoever its work is for, like every reader
let _default
async function defaultSource() { if (!_default) _default = (await _sources())[0]?.id; return _default }
// The live data seam: routes each spec's SQL to its named source (or the sole source) and binds @name params.
// Hierarchies of the live kinds (column/derived-query/cross-source) resolve THROUGH this at query time — the
// source's own tree is the single source of truth, so results are always fresh and nothing is copied/synced.
const source = async (sql, src, params) => _query(src ?? await defaultSource(), sql, params ?? {})
const store = new GroundingStore(${JSON.stringify(join(projectHome, 'workspace', 'grounding', 'grounding.sqlite'))}, { source })   // the grounding agent's own database, in the agents' workspace — never the engine's db/
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

  const drivers: Record<string, string> = {
    'find-schema': `// Asked of the engine (tool-socket.ts), which answers from its own knowledge for whoever this turn's ticket is.
${askSocket(socket, dir)}
const r = await ask('find-schema', process.argv.slice(2))
if (r.error) { console.error(r.error); process.exit(1) }
console.log(r.text)
`,
    'find-concept': `// Asked of the engine (tool-socket.ts), which answers from its own knowledge for whoever this turn's ticket is.
${askSocket(socket, dir)}
// The version this session reads (.graph.json beside it): the published one unless it was pinned.
let graph = null
try { graph = JSON.parse(process.getBuiltinModule('node:fs').readFileSync(${JSON.stringify(join(dir, '.graph.json'))}, 'utf8')).graph ?? null } catch {}
const r = await ask('find-concept', { words: process.argv.slice(2).join(' '), graph })
if (r.error) { console.error(r.error); process.exit(1) }
console.log(r.text)
`,
    'experience': `// Asked of the engine (tool-socket.ts): what an intent has met — its signals, scenarios and cases — as JSON.
${askSocket(socket, dir)}
const r = await ask('experience', process.argv.slice(2))
if (r.error) { console.error(r.error); process.exit(1) }
console.log(r.text)
`,
    'sources': `// List data sources + their kind/dialect. Run: ./sources. Prints JSON.
import { sources } from ${JSON.stringify(join(dir, 'data', 'query.mjs'))}
console.log(JSON.stringify(await sources(), null, 2))
`,
    'query': `// Run a query against a source. Run: ./query "<source>" "<query>". Prints JSON rows.
// What was sent is recorded with the turn (out/<qid>/queries.jsonl): a query of the agent's own is a part of the
// answer that did not stand on the model, for the answer to say so and for the modeller to read later.
import { query } from ${JSON.stringify(join(dir, 'data', 'query.mjs'))}
import { readFile, appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
const HOME = ${JSON.stringify(dir)}
const [src, ...rest] = process.argv.slice(2)
if (!src || !rest.length) { console.error('usage: ./query "<source>" "<query>"  (list sources with ./sources)'); process.exit(1) }
const text = rest.join(' ')
const qid = (await readFile(join(HOME, '.turn'), 'utf8').catch(() => '')).trim()
const record = async (r) => { if (!qid) return; await mkdir(join(HOME, 'out', qid), { recursive: true }); await appendFile(join(HOME, 'out', qid, 'queries.jsonl'), JSON.stringify({ source: src, query: text, at: Date.now(), ...r }) + '\\n') }
const t0 = Date.now()
try {
  const rows = await query(src, text)
  await record({ rows: rows.length, ms: Date.now() - t0 })
  console.log(JSON.stringify(rows, null, 2))
} catch (e) { await record({ rows: 0, ms: Date.now() - t0, error: String(e && e.message || e) }); throw e }
`,
    'get-schema': `// Asked of the engine (tool-socket.ts), which answers from its own knowledge for whoever this turn's ticket is.
${askSocket(socket, dir)}
const r = await ask('get-schema', process.argv.slice(2))
if (r.error) { console.error(r.error); process.exit(1) }
console.log(r.text)
`,
    'resolve': `// Resolve a fuzzy human reference (a name/value) to concrete ids. Run: ./resolve "<text>". Prints JSON.
import { resolveEntity } from ${JSON.stringify(join(dir, 'grounding', 'grounding.mjs'))}
const t = process.argv.slice(2).join(' ').trim()
if (!t) { console.error('usage: ./resolve "<text>"'); process.exit(1) }
console.log(JSON.stringify(await resolveEntity(t), null, 2))
`,
  }
  const usages: Record<string, string> = {
    'find-schema':  'find-schema "<term>" [--source <SOURCE>] [--full]   → search ALL datasources for a field/table by name, type, or description: first the sources the hits belong to (kind, dialect, what each is), then the fields (SOURCE.TABLE.COLUMN : type); --source filters to one; --full adds PK/nullable/references',
    'find-concept': 'find-concept "<words>"   → the project\'s concepts from every domain that best match the words, whole (JSON) — for when your own concepts do not cover the question',
    'experience':   'experience <intent id> [--recent N]   → what that intent has met, as data: the signals it measures, its scenarios with their expectations, and its cases (JSON) — to set an answer beside or compute over',
    'sources':      'sources   → every data source with its kind + dialect (JSON)',
    'query':        'query "<source>" "<query in the source\'s own dialect>"   → JSON rows. e.g. query "<source>" "SELECT * FROM <table> FETCH FIRST 3 ROWS ONLY"',
    'get-schema':   'get-schema [<source>] [<table>]   → from the datasource index: every source; a source\'s tables with row and field counts; or a table\'s fields with type, key, nullable, references and description (JSON)',
    'resolve':      'resolve "<text>"   → resolve a fuzzy name/value to concrete ids (JSON)',
  }
  // Kept, but not given to agents for now (how a name becomes ids is being redesigned — perhaps by the data source
  // itself). The driver and the grounding seam stay; the tool is simply not written.
  for (const name of NOT_GIVEN) { delete drivers[name]; delete usages[name] }
  for (const [name, body] of Object.entries(drivers)) {
    // Prepend a --help guard. ESM hoists the body's imports above this, but they only OPEN cheap handles; the
    // guard still short-circuits before any query/search runs, printing usage and nothing else.
    // Clean errors (message only, no stack) + a --help guard. Any failure inside the tool prints one actionable
    // line and exits 1 — the agent reads a clear reason, not a Node stack trace.
    const help = `process.on('unhandledRejection', (e) => { console.error(String(e && e.message || e)); process.exit(1) })
process.on('uncaughtException', (e) => { console.error(String(e && e.message || e)); process.exit(1) })
if (process.argv.slice(2).some(a => a === '-h' || a === '--help')) { console.log(${JSON.stringify(usages[name])}); process.exit(0) }
`
    await writeFile(join(dir, '.tools', name + '.mjs'), help + body)
    // ── A QUESTION TAKES AS LONG AS IT TAKES ──────────────────────────────────────────────────────────────
    // A tool that is cut short teaches nothing: a query stopped at thirty seconds has not said the answer is
    // elsewhere, and asking something smaller answers a different question. The budget belongs to the TURN — the
    // engine ends a turn that goes silent or runs too long — so the work here must outlive the call that started
    // it. Reading tools therefore run DETACHED and file their result under what was asked, within this turn: a
    // call that is killed leaves the work running, and asking again picks up the finished result instead of
    // paying for it twice. Tools that change something are never reused this way.
    const detached = READ_ONLY.has(name)
    await writeFile(join(dir, name), detached
? `#!/usr/bin/env bash
D=${JSON.stringify(join(dir, '.tools', name + '.mjs'))}
RUNS=${JSON.stringify(join(dir, '.runs'))}
TURN=$(cat ${JSON.stringify(join(dir, '.turn'))} 2>/dev/null || echo none)
mkdir -p "$RUNS"
KEY=$(printf '%s|%s|%s' "$TURN" ${JSON.stringify(name)} "$*" | shasum | cut -c1-16)
OUT="$RUNS/$KEY.out"; ERR="$RUNS/$KEY.err"; CODE="$RUNS/$KEY.code"; PID="$RUNS/$KEY.pid"
run() { if command -v tsx >/dev/null 2>&1; then tsx "$D" "$@"; else npx --yes tsx "$D" "$@"; fi; }
if [ ! -f "$CODE" ] && [ ! -f "$PID" ]; then
  ( run "$@" >"$OUT" 2>"$ERR"; echo $? >"$CODE"; rm -f "$PID" ) &
  echo $! >"$PID"
fi
while [ ! -f "$CODE" ]; do sleep 0.3; done
# ── A BIG ANSWER IS KEPT, NOT POURED ─────────────────────────────────────────────────────────────────
# What a tool found is worth having whole; what a reader can hold is another matter. A long answer stays
# on disk in full and its beginning is shown, with where the rest is and how much of it there is — so
# nothing is lost, nothing is capped away silently, and what is needed from it can be taken with the
# tools already here (grep, jq) instead of being read in its entirety first.
BYTES=$(wc -c < "$OUT" | tr -d ' ')
if [ "$BYTES" -gt 16000 ]; then
  head -c 12000 "$OUT"
  printf '\\n\\n— shown: the first 12000 of %s characters (%s lines). All of it is in %s — take what you need from it (grep, jq), it is not going anywhere.\\n' "$BYTES" "$(wc -l < "$OUT" | tr -d ' ')" "$OUT"
else
  cat "$OUT"
fi
[ -s "$ERR" ] && cat "$ERR" >&2
exit "$(cat "$CODE")"
`
: PLAIN.has(name)
// Plain JavaScript (a thin client of the engine or the manager): Node itself, started in a few milliseconds — the work
// is the engine's, already loaded, its connections open.
? `#!/usr/bin/env bash
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, '.tools', name + '.mjs'))} "$@"
`
: `#!/usr/bin/env bash
D=${JSON.stringify(join(dir, '.tools', name + '.mjs'))}
if command -v tsx >/dev/null 2>&1; then exec tsx "$D" "$@"; else exec npx --yes tsx "$D" "$@"; fi
`)
    await chmod(join(dir, name), 0o755)
  }

  // The tools' own usage lines, together, so an agent whose reference can hold them starts a thread knowing its
  // tools rather than reading each one's help first.
  await removeWhatIsNotOurs(dir, Object.keys(drivers), conversation)
  await writeFile(join(dir, '.tools', 'USAGE.md'), Object.keys(drivers).filter((n) => usages[n]).map((n) => usages[n]).join('\n\n'))
  shareWithAgents(dir)   // the agent's folder is the agents' to write (where they run as their own user)
  return dir
}

/** The usage of the tools in a prepared workspace, as one text, for an agent's reference — all of them, or the named ones. */
export async function toolUsage(dir: string, only?: string[]): Promise<string> {
  let text = ''
  try { text = await readFile(join(dir, '.tools', 'USAGE.md'), 'utf8') } catch { return '' }
  if (!only) return text
  return text.split('\n\n').filter((u) => only.includes(u.trim().split(/\s/)[0])).join('\n\n')
}

/** Leave an agent only the named tools: the others' wrappers and drivers go, and the seams a domain does not use. */
export async function keepOnlyTools(dir: string, keep: string[]): Promise<void> {
  const wrappers = (await readdir(join(dir, '.tools'))).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''))
  for (const t of wrappers) if (!keep.includes(t)) { await rm(join(dir, t), { force: true }); await rm(join(dir, '.tools', `${t}.mjs`), { force: true }) }
  if (!keep.includes('resolve')) await rm(join(dir, 'grounding'), { recursive: true, force: true })
}

/** Tools that exist but are not given to agents for now. */
const NOT_GIVEN = ['resolve']

/** Tools that only read: their work outlives the call, and asking the same thing twice in a turn costs nothing. */
const READ_ONLY = new Set<string>()
/** Tools that are plain JavaScript — thin clients of the engine (tool-socket.ts) or the manager — run by Node itself. */
const PLAIN = new Set(['find-schema', 'get-schema', 'find-concept', 'experience', 'sources', 'query'])

// ── THE WORKSPACE HOLDS WHAT THIS ENGINE WRITES, AND NOTHING ELSE ─────────────────────────────────────────────
// A workspace outlives engine versions, and an agent reads whatever it finds: an earlier engine's tools, question
// programs and turn files were read as current, and used. So preparing a workspace also removes what the current
// engine does not put there. Each entry below names who writes it.
const OWNED = new Set([
  'CONTEXT.md', 'data', 'grounding', 'out', '.tools', '.runs',      // this file (.runs: work that outlived its call)
  '.turn', '.session', '.agent', '.ticket',                         // agents/composer, agents/analyst: the turn in progress (and whose)
  '.domain.json', '.reference.md', '.harness-session', '.system-prompt.md',   // a session that is a domain: what it was made with (knowledge.ts, composer)
  'AGENTS.md', 'SYSTEM_REFERENCE.md', '.claude',                    // the harnesses (ica/pi.ts, ica/codex.ts, ica/claude.ts)
])
const OWNED_IN: Record<string, Set<string>> = {
  data: new Set(['query.mjs']),
  grounding: new Set(['grounding.mjs', 'GROUNDING.md']),            // GROUNDING.md: agents/grounding
}

async function removeWhatIsNotOurs(dir: string, tools: string[], conversation = false) {
  const owned = new Set([...OWNED, ...tools].filter((e) => !(conversation && e === 'CONTEXT.md')))
  const gone = (p: string) => rm(p, { recursive: true, force: true })
  // A CONVERSATION'S FOLDER IS THE CONVERSATION'S. What its agent made there — rows, scripts, the files its answers
  // name, its question folders — is what its answers stand on and what the analyst will read, so nothing of it is
  // removed; the platform refreshes only what the platform put there, below. The shared workspace is the platform's
  // own and is swept of what it no longer writes.
  if (!conversation) for (const e of await readdir(dir)) if (!owned.has(e)) await gone(join(dir, e))
  for (const [sub, keep] of Object.entries(OWNED_IN))
    for (const e of await readdir(join(dir, sub)).catch(() => [] as string[])) if (!keep.has(e)) await gone(join(dir, sub, e))
  for (const e of await readdir(join(dir, '.tools'))) if (!tools.includes(e.replace(/\.mjs$/, ''))) await gone(join(dir, '.tools', e))
  // A turn leaves what it answered with — built.json and the run.json it came from, and the program.mjs and params.json it ran — or
  // explain.md, or said.md with the queries.jsonl it sent itself, or nothing yet while it runs. The verbs read these after a restart, so they are kept; anything else in
  // out/ was written for an earlier engine.
  const TURN_FILES = new Set(['built.json', 'run.json', 'program.mjs', 'params.json', 'explain.md', 'said.md', 'queries.jsonl'])
  if (!conversation) for (const e of await readdir(join(dir, 'out'))) {
    // An answer given before built.json was named step.json.
    if (existsSync(join(dir, 'out', e, 'step.json')) && !existsSync(join(dir, 'out', e, 'built.json'))) await rename(join(dir, 'out', e, 'step.json'), join(dir, 'out', e, 'built.json')).catch(() => {})
    const files = await readdir(join(dir, 'out', e)).catch(() => null)
    if (files === null || files.some((f) => !TURN_FILES.has(f))) await gone(join(dir, 'out', e))
  }
}
