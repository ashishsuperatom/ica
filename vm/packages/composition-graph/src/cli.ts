// composition-graph — read a project's composition graph: this engine's replica of it (the platform holds the graph and
// is where it changes — in the console, with `sacli graph import <knowledge/index.mts>`, or `sacli call graph:…`).
//
//   composition-graph domains [--as-of <iso>] [--viewer <scope,…>]
//   composition-graph names [--kind concept|file|domain|setting] [--as-of <iso>] [--viewer <scope,…>]
//   composition-graph show <name> [--as-of <iso>]
//   composition-graph history <name>
//   composition-graph changes [--limit n]
//   composition-graph compose <domain> [--as-of <iso>] [--viewer <scope,…>] [--used]
//   composition-graph versions                                       the published versions, and what is in the draft
//   composition-graph verify [--against <knowledge/index.mts>]      the graph holds together, and holds what was written
//   composition-graph check <knowledge/index.mts>                   written knowledge, checked before it is imported (no graph needed)
//   composition-graph guide                                          how concepts and domains are written
//
// A viewer (--viewer user:u1,group:finance) sees global and its own scopes only.
// Where: --db <file>, else $COMPOSITION_GRAPH_DB, else <$ENGINE_PROJECT_DIR>/db/composition.sqlite.

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Kind } from './store.js'
import { openStore, verifyAgainst } from './node.js'
import { compose, domains } from './compose.js'
import { draft, published } from './versions.js'
import { importDomains, type WrittenDomain, type WrittenSetting } from './import.js'
import { CONCEPT_GUIDE } from './guide.js'
import { verifyGraph, type Finding } from './verify.js'

const argv = process.argv.slice(2)
const flags: Record<string, string | true> = {}
const args: string[] = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) flags[k] = true; else { flags[k] = v; i++ } }
  else args.push(a)
}
const text = (v: string | true | undefined) => (typeof v === 'string' ? (v.startsWith('@') ? readFileSync(v.slice(1), 'utf8') : v) : undefined)
const fail = (m: string): never => { console.error(m); process.exit(1) }
const [command0, ...rest0] = args
if (command0 === 'guide') { process.stdout.write(CONCEPT_GUIDE); process.exit(0) }
if (command0 === 'check') {
  // The written knowledge, imported into a graph in memory and verified: what an author runs before importing it.
  const file = resolve(rest0[0] ?? fail('check <knowledge/index.mts>'))
  const mod = await import(pathToFileURL(file).href)
  const dir = file.replace(/\/[^/]+$/, '')
  const read = (domain: string, f: string) => readFileSync(f.includes('/') ? join(dir, f) : join(dir, domain.replace(/\s+/g, '-').toLowerCase(), f), 'utf8')
  const scratch = openStore(':memory:')
  importDomains(scratch, (mod.domains ?? []) as WrittenDomain[], read, { by: 'check' }, (mod.settings ?? []) as WrittenSetting[])
  const findings = verifyGraph(scratch)
  for (const f of findings) console.log(`${f.level === 'fail' ? 'FAIL' : 'warn'}  ${f.check.padEnd(9)} ${f.subject} — ${f.says}`)
  const failed = findings.filter((f) => f.level === 'fail').length
  console.log(failed ? `${failed} failed, ${findings.length - failed} warnings` : `holds together${findings.length ? ` (${findings.length} warnings)` : ''}`)
  process.exit(failed ? 1 : 0)
}
const dbFile = (typeof flags.db === 'string' ? flags.db : undefined) ?? process.env.COMPOSITION_GRAPH_DB
  ?? (process.env.ENGINE_PROJECT_DIR ? join(process.env.ENGINE_PROJECT_DIR, 'db', 'composition.sqlite') : undefined)
  ?? fail('where is the graph? --db <file>, or COMPOSITION_GRAPH_DB, or ENGINE_PROJECT_DIR')
const asOf = typeof flags['as-of'] === 'string' ? Date.parse(flags['as-of']) : undefined
if (asOf !== undefined && Number.isNaN(asOf)) fail(`--as-of ${flags['as-of']} is not a moment: give an ISO date or time`)
const viewer = typeof flags.viewer === 'string' ? flags.viewer.split(',').map((x) => x.trim()).filter(Boolean) : undefined
const store = openStore(dbFile)
const [command, ...rest] = args

// The graph changes only in the platform: what used to change this file here now says where.
const WRITES = ['concept', 'join', 'leave', 'publish', 'restore', 'put', 'remove', 'import']
if (WRITES.includes(command ?? '')) fail(`the graph lives in the platform — change it in the console, with sacli graph import <knowledge/index.mts>, or sacli call graph:<…>; this reads ${dbFile}, the engine's replica`)
if (command === 'domains') {
  for (const d of domains(store, { asOf, viewer })) console.log(`${d.name}\t${d.capabilities.join(', ')}`)
} else if (command === 'names') {
  for (const n of store.names(flags.kind as Kind | undefined, { asOf, viewer })) console.log(`${n.kind}\t${n.name}\t${n.scope}${n.owner ? `\t${n.owner}` : ''}\t${n.hash.slice(0, 12)}`)
} else if (command === 'versions') {
  for (const v of store.versions()) console.log(`${v.name}\t${new Date(v.at).toISOString()}\t${v.by}\t${v.changes} changes\t${v.message}`)
  const d = draft(store), p = published(store)
  console.log(d.length ? `draft: ${d.length} node${d.length === 1 ? '' : 's'} differ from ${p?.name ?? 'nothing published yet'} — ${d.map((x) => x.name).join(', ')}` : `the draft is ${p?.name ?? 'empty'}`)
} else if (command === 'show') {
  const n = store.get(rest[0] ?? fail('show <name>'), asOf) ?? fail(`there is no "${rest[0]}"${asOf ? ' at that moment' : ''}`)
  console.log(JSON.stringify({ name: n.name, kind: n.kind, hash: n.hash, body: n.body }, null, 2))
} else if (command === 'history') {
  for (const c of store.history(rest[0] ?? fail('history <name>')))
    console.log(`${new Date(c.at).toISOString()}  ${(c.fromHash ?? '—').slice(0, 10)} → ${(c.toHash ?? 'removed').slice(0, 10)}  by ${c.by}${c.reason ? ` · ${c.reason}` : ''}${c.from ? ` · from ${c.from}` : ''}`)
} else if (command === 'changes') {
  for (const c of store.changes(Number(flags.limit) || 50))
    console.log(`${new Date(c.at).toISOString()}  ${c.kind} ${c.name}  ${(c.fromHash ?? '—').slice(0, 10)} → ${(c.toHash ?? 'removed').slice(0, 10)}  by ${c.by}${c.reason ? ` · ${c.reason}` : ''}`)
} else if (command === 'compose') {
  const c = compose(store, rest[0] ?? fail('compose <domain>'), asOf, { viewer })
  if (flags.used) console.log(JSON.stringify(c.used, null, 2)); else process.stdout.write(c.text + '\n')
} else if (command === 'verify') {
  const findings: Finding[] = verifyGraph(store)
  if (typeof flags.against === 'string') {
    const file = resolve(flags.against)
    const mod = await import(pathToFileURL(file).href)
    const dir = file.replace(/\/[^/]+$/, '')
    const read = (domain: string, f: string) => readFileSync(f.includes('/') ? join(dir, f) : join(dir, domain.replace(/\s+/g, '-').toLowerCase(), f), 'utf8')
    findings.push(...verifyAgainst(store, (mod.domains ?? []) as WrittenDomain[], read, (mod.settings ?? []) as WrittenSetting[]))
  }
  for (const f of findings) console.log(`${f.level === 'fail' ? 'FAIL' : 'warn'}  ${f.check.padEnd(9)} ${f.subject} — ${f.says}`)
  const failed = findings.filter((f) => f.level === 'fail').length
  console.log(failed ? `${failed} failed, ${findings.length - failed} warnings` : `the graph holds together${typeof flags.against === 'string' ? ' and holds what the knowledge writes' : ''}${findings.length ? ` (${findings.length} warnings)` : ''}`)
  if (failed) process.exitCode = 1
} else {
  fail('commands: guide · check · domains · names · show · history · changes · compose · concept · join · leave · put · remove · import · verify · versions · publish · restore   (every change: --by --reason --from; writes: --scope --owner)')
}
store.close()
