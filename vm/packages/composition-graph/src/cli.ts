// composition-graph — read and change a project's composition graph. Every change carries --by, and should carry
// --reason and --from: who changed it, why, and from what evidence.
//
//   composition-graph domains [--as-of <iso>] [--viewer <scope,…>]
//   composition-graph names [--kind concept|file|domain|setting] [--as-of <iso>] [--viewer <scope,…>]
//   composition-graph show <name> [--as-of <iso>]
//   composition-graph history <name>
//   composition-graph changes [--limit n]
//   composition-graph compose <domain> [--as-of <iso>] [--viewer <scope,…>] [--used]
//   composition-graph concept <name> --title <t> --text <text|@file> [--form text|bullets|numbered]   add or edit an atomic concept
//   composition-graph concept <name> --title <t> --form composed [--text <line>] [--parts a,b]       an intermediate concept
//   composition-graph join <domain|intermediate> <concept> [--at <position>]   attach a concept (an intermediate takes atomic ones)
//   composition-graph leave <domain|intermediate> <concept>                    detach it (the concept stays in the graph)
//   composition-graph versions                                       the published versions, and what is in the draft
//   composition-graph publish --message <m>                          publish the draft as the next version (the agents read it)
//   composition-graph restore <version>                              set the draft to that version (new changes); publish to make it current
//   composition-graph put <name> --kind concept|file|domain|setting --body <json|@file>   (a file: --kind file --text @<path>)
//   composition-graph remove <name>
//
// Every write may carry --scope global|group:<name>|user:<id> and --owner <who>; left out, a new node is global and
// an existing one keeps its own. A viewer (--viewer user:u1,group:finance) sees global and its own scopes only.
//   composition-graph import <knowledge/index.mts>
//   composition-graph verify [--against <knowledge/index.mts>]      the graph holds together, and holds what was written
//
// Where: --db <file>, else $COMPOSITION_GRAPH_DB, else <$ENGINE_PROJECT_DIR>/db/composition.sqlite.

import { readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Store, type Kind } from './store.js'
import { compose, domains } from './compose.js'
import { compose as attach, write as governedWrite, GovernanceRefusal } from './governance.js'
import { publishDraft, restoreVersion, draft, published } from './versions.js'
import { importDomains, type WrittenDomain, type WrittenSetting } from './import.js'
import { verifyGraph, verifyAgainst, type Finding } from './verify.js'

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
if (asOf !== undefined && Number.isNaN(asOf)) fail(`--as-of ${flags['as-of']} is not a moment: give an ISO date or time`)
const viewer = typeof flags.viewer === 'string' ? flags.viewer.split(',').map((x) => x.trim()).filter(Boolean) : undefined
const place = { ...(typeof flags.scope === 'string' ? { scope: flags.scope } : {}), ...(typeof flags.owner === 'string' ? { owner: flags.owner } : {}) }
const said = (name: string, r: { hash: string; changed: boolean }) => console.log(r.changed ? `${name} → ${r.hash.slice(0, 12)}` : `${name} unchanged`)
const store = new Store(dbFile)
const [command, ...rest] = args

/** The operator's own change, with the graph's rules (the levels, what exists); a refusal is a sentence. */
const operator = <T,>(fn: () => T): T => { try { return fn() } catch (e) { if (e instanceof GovernanceRefusal) fail(e.message); throw e } }
if (command === 'domains') {
  for (const d of domains(store, { asOf, viewer })) console.log(`${d.name}\t${d.capabilities.join(', ')}`)
} else if (command === 'names') {
  for (const n of store.names(flags.kind as Kind | undefined, { asOf, viewer })) console.log(`${n.kind}\t${n.name}\t${n.scope}${n.owner ? `\t${n.owner}` : ''}\t${n.hash.slice(0, 12)}`)
} else if (command === 'concept') {
  const name = rest[0] ?? fail('concept <name> --title <t> --text <text|@file> [--form text|bullets|numbered|composed]')
  const form = (flags.form as string) ?? 'text'
  const title = text(flags.title) ?? fail('--title <t>')
  if (!['text', 'bullets', 'numbered', 'composed'].includes(form)) fail('--form text, bullets, numbered or composed')
  if (form === 'composed') {
    const parts = typeof flags.parts === 'string' ? flags.parts.split(',').map((x) => x.trim()).filter(Boolean) : []
    const line = text(flags.text)
    said(name, operator(() => governedWrite(store, { id: ctx.by, admin: true }, name, 'concept', { title, form: 'composed', ...(line ? { text: line } : {}), concepts: parts }, { reason: ctx.reason, from: ctx.from }, place)))
  } else {
    const body = text(flags.text) ?? fail('--text <text|@file>')
    const concept = form === 'text' ? { title, form: 'text', text: body } : { title, form, items: body.split('\n').map((l) => l.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim()).filter(Boolean) }
    said(name, store.put(name, 'concept', concept, ctx, place))
  }
} else if (command === 'join') {
  const [into, concept] = rest
  if (!into || !concept) fail('join <domain|intermediate> <concept> [--at <position>]')
  said(into, operator(() => attach(store, { id: ctx.by, admin: true }, into, concept, { at: typeof flags.at === 'string' ? Number(flags.at) : undefined }, ctx.reason)))
} else if (command === 'leave') {
  const [from, concept] = rest
  if (!from || !concept) fail('leave <domain|intermediate> <concept>')
  said(from, operator(() => attach(store, { id: ctx.by, admin: true }, from, concept, { leave: true }, ctx.reason)))
} else if (command === 'versions') {
  for (const v of store.versions()) console.log(`${v.name}\t${new Date(v.at).toISOString()}\t${v.by}\t${v.changes} changes\t${v.message}`)
  const d = draft(store), p = published(store)
  console.log(d.length ? `draft: ${d.length} node${d.length === 1 ? '' : 's'} differ from ${p?.name ?? 'nothing published yet'} — ${d.map((x) => x.name).join(', ')}` : `the draft is ${p?.name ?? 'empty'}`)
} else if (command === 'publish') {
  const v = operator(() => publishDraft(store, { id: ctx.by, admin: true }, text(flags.message) ?? ''))
  console.log(`published ${v.name} → change ${v.upto} (${v.changes} changes)`)
} else if (command === 'restore') {
  const name = rest[0] ?? fail('restore <version>')
  const changed = operator(() => restoreVersion(store, { id: ctx.by, admin: true }, name))
  console.log(changed.length ? `the draft is ${name} again: ${changed.join(', ')} — publish to make it current` : `the draft already is ${name}`)
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
} else if (command === 'put') {
  const name = rest[0] ?? fail('put <name> --kind concept|file|domain|setting --body <json|@file>')
  const kind = (flags.kind as Kind) ?? fail('--kind concept|file|domain|setting')
  const body = kind === 'file' ? { name: basename(name), text: text(flags.text) ?? fail('a file: --text @<path>') } : JSON.parse(text(flags.body) ?? fail('--body <json|@file>'))
  said(name, store.put(name, kind, body, ctx, place))
} else if (command === 'remove') {
  console.log(store.remove(rest[0] ?? fail('remove <name>'), ctx) ? `${rest[0]} removed` : `there is no "${rest[0]}"`)
} else if (command === 'import') {
  // A knowledge/index.mts: domains with concepts in their forms and the files they bring (import.ts).
  const file = resolve(rest[0] ?? fail('import <knowledge/index.mts>'))
  const mod = await import(pathToFileURL(file).href)
  const dir = file.replace(/\/[^/]+$/, '')
  const read = (domain: string, f: string) => readFileSync(f.includes('/') ? join(dir, f) : join(dir, domain.replace(/\s+/g, '-').toLowerCase(), f), 'utf8')
  for (const r of importDomains(store, (mod.domains ?? []) as WrittenDomain[], read, ctx, (mod.settings ?? []) as WrittenSetting[])) console.log(r.changed ? `${r.kind} ${r.name} → ${r.hash.slice(0, 12)}` : `${r.kind} ${r.name} unchanged`)
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
  fail('commands: domains · names · show · history · changes · compose · concept · join · leave · put · remove · import · verify · versions · publish · restore   (every change: --by --reason --from; writes: --scope --owner)')
}
store.close()
