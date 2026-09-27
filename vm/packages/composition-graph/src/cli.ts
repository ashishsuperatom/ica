// composition-graph — read and change a project's composition graph. Every change carries --by, and should carry
// --reason and --from: who changed it, why, and from what evidence.
//
//   composition-graph domains
//   composition-graph show <name> [--as-of <iso>]
//   composition-graph history <name>
//   composition-graph changes [--limit n]
//   composition-graph compose <domain> [--as-of <iso>] [--used]
//   composition-graph put <name> --kind part|file|domain --body <json|@file>     (a file: --kind file --text @<path>)
//   composition-graph remove <name>
//   composition-graph import <knowledge/index.mts>
//
// Where: --db <file>, else $COMPOSITION_GRAPH_DB, else <$ENGINE_PROJECT_DIR>/db/composition.sqlite.

import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Store, type Kind } from './store.js'
import { compose, domains } from './compose.js'
import { importDomains, type WrittenDomain } from './import.js'

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
const dbFile = (typeof flags.db === 'string' ? flags.db : undefined) ?? process.env.COMPOSITION_GRAPH_DB
  ?? (process.env.ENGINE_PROJECT_DIR ? join(process.env.ENGINE_PROJECT_DIR, 'db', 'composition.sqlite') : undefined)
  ?? fail('where is the graph? --db <file>, or COMPOSITION_GRAPH_DB, or ENGINE_PROJECT_DIR')
const ctx = { by: text(flags.by) ?? process.env.COMPOSITION_GRAPH_BY ?? process.env.USER ?? 'someone', reason: text(flags.reason), from: text(flags.from) }
const asOf = typeof flags['as-of'] === 'string' ? Date.parse(flags['as-of']) : undefined
const store = new Store(dbFile)
const [command, ...rest] = args

if (command === 'domains') {
  for (const d of domains(store)) console.log(`${d.name}\t${d.capabilities.join(', ')}`)
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
  const c = compose(store, rest[0] ?? fail('compose <domain>'), asOf)
  if (flags.used) console.log(JSON.stringify(c.used, null, 2)); else process.stdout.write(c.text + '\n')
} else if (command === 'put') {
  const name = rest[0] ?? fail('put <name> --kind part|file|domain --body <json|@file>')
  const kind = (flags.kind as Kind) ?? fail('--kind part|file|domain')
  const body = kind === 'file' ? { name: basename(name), text: text(flags.text) ?? fail('a file: --text @<path>') } : JSON.parse(text(flags.body) ?? fail('--body <json|@file>'))
  const r = store.put(name, kind, body, ctx)
  console.log(r.changed ? `${name} → ${r.hash.slice(0, 12)}` : `${name} unchanged`)
} else if (command === 'remove') {
  console.log(store.remove(rest[0] ?? fail('remove <name>'), ctx) ? `${rest[0]} removed` : `there is no "${rest[0]}"`)
} else if (command === 'import') {
  // A knowledge/index.mts: domains with parts in their forms and the files they bring (import.ts).
  const file = resolve(rest[0] ?? fail('import <knowledge/index.mts>'))
  const mod = await import(pathToFileURL(file).href)
  const dir = file.replace(/\/[^/]+$/, '')
  const read = (domain: string, f: string) => readFileSync(join(dir, domain.replace(/\s+/g, '-').toLowerCase(), f), 'utf8')
  for (const r of importDomains(store, (mod.domains ?? []) as WrittenDomain[], read, ctx)) console.log(r.changed ? `${r.kind} ${r.name} → ${r.hash.slice(0, 12)}` : `${r.kind} ${r.name} unchanged`)
} else {
  fail('commands: domains · show · history · changes · compose · put · remove · import   (every change: --by --reason --from)')
}
store.close()
