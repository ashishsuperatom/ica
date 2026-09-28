// The application checked against the composition graph, without asking the source a question: what a person opens
// must stand on what the domains' agents are composed from, so a screen and a chat cannot drift apart.
//
//   graph      the graph holds together and holds exactly what knowledge/index.mts writes (composition-graph verify)
//   views      every view a domain lists exists here, and every view here is listed by a domain; the views load clean
//   facts      every fact's domain is in the graph and places the fact's program; the program answers --help, and a
//              paged one names its columns (--columns)
//   fields     every column a dimension or a view's members read is one the fact's program gives
//   settings   every setting the application reads by name is one a domain gives
//   programs   no view reads the semantic graph: every figure comes from a domain's program
//
//   cd <repo>/vm/apps/engine && pnpm exec tsx <project>/app/server/verify.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, '..', '..')
const env = Object.fromEntries(readFileSync(join(PROJECT, '.env'), 'utf8').split('\n').map((l) => l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const graphPackage = createRequire(join(process.cwd(), 'package.json')).resolve('@superatom/composition-graph')
const { Store } = await import(pathToFileURL(graphPackage).href)
const { placeForRunning } = await import(`${process.cwd()}/knowledge.ts`)
const { handle } = await import('./index.mjs')
const { FACTS } = await import('./facts.mjs')
const { factsFor } = await import('./read.mjs')
const { DIMENSIONS } = await import('./dimensions.mjs')

const findings = []
const fail = (check, subject, says) => findings.push({ level: 'fail', check, subject, says })
const warn = (check, subject, says) => findings.push({ level: 'warn', check, subject, says })
const base = (n) => n.slice(n.lastIndexOf('/') + 1)

// ── graph: holds together, and holds what the knowledge writes ──
const DB = join(PROJECT, 'db', 'composition.sqlite')
const cli = join(dirname(graphPackage), '..', 'bin', 'composition-graph')
let said
try { said = execFileSync(cli, ['verify', '--db', DB, '--against', join(PROJECT, 'knowledge', 'index.mts')], { encoding: 'utf8' }) } catch (e) { said = String(e.stdout ?? '') + String(e.stderr ?? '') ; if (!said.trim()) fail('graph', DB, e.message) }
for (const line of said.split('\n')) {
  const m = line.match(/^(FAIL|warn)\s+(\S+)\s+(.*?) — (.*)$/)
  if (m) (m[1] === 'FAIL' ? fail : warn)(`graph ${m[2]}`, m[3], m[4])
}

const store = new Store(DB)
const domains = new Map(store.names('domain').map((d) => [d.name, store.get(d.name).body]))
const settingsInGraph = new Set(store.names('setting').map((s) => s.name))
store.close()

// ── views: the domains list them, and they load ──
let last = null
const ctx = { project: env.ICA_PROJECT, projectDir: PROJECT, who: 'verify', reply: (msg) => { last = msg },
  domain: (name) => placeForRunning(PROJECT, name, join(PROJECT, 'app', '.domains', name.toLowerCase().replace(/[^a-z0-9]+/g, '-')), env.DATASOURCE_URL),
  sources: async () => [] }
await handle({ t: 'app:catalog' }, ctx)
const catalog = last
if (catalog?.t !== 'app:catalog') fail('views', 'catalog', `the catalog did not load: ${catalog?.error ?? catalog?.reason ?? 'no answer'}`)
for (const p of catalog?.problems ?? []) fail('views', 'loader', p)
const views = new Map((catalog?.capabilities ?? []).map((c) => [c.focus, c]))
const listedBy = new Map()
for (const [name, d] of domains) for (const focus of d.capabilities ?? []) {
  if (listedBy.has(focus)) warn('views', focus, `listed by two domains: ${listedBy.get(focus)} and ${name}`)
  listedBy.set(focus, name)
  if (!views.has(focus)) fail('views', name, `lists the view "${focus}", which the application does not have`)
}
for (const focus of views.keys()) if (!listedBy.has(focus)) fail('views', focus, 'no domain lists this view, so no agent knows it is there')

// ── facts: in the graph, placed, and saying what they are ──
const facts = factsFor(ctx)
const today = new Date().toISOString().slice(0, 10)
const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)
const columns = new Map()
for (const [name, f] of Object.entries(FACTS)) {
  const d = domains.get(f.domain)
  if (!d) { fail('facts', name, `reads the domain "${f.domain}", which the graph does not hold`); continue }
  const placed = (d.files ?? []).map((n) => base(n))
  if (!placed.includes(f.program)) { fail('facts', name, `${f.program} is not among the files "${f.domain}" places (${placed.join(', ')})`); continue }
  if (!f.paged) continue
  const params = { span: { from: monthAgo, to: today }, today }
  try {
    const help = await facts.probe(name, '--help', params)
    if (!String(help.rows).trim()) fail('facts', name, `${f.program} --help says nothing`)
  } catch (e) { fail('facts', name, `${f.program} --help: ${e.message}`) }
  try {
    const got = await facts.probe(name, '--columns', params)
    const cols = got.rows?.columns
    if (!cols || !Object.keys(cols).length) fail('facts', name, `${f.program} --columns names no columns`)
    else columns.set(name, new Set(Object.keys(cols)))
  } catch (e) { fail('facts', name, `${f.program} --columns: ${e.message}`) }
}

// ── fields: what the dimensions read is what the programs give ──
const column = (check, subject, fact, col) => {
  if (!FACTS[fact]) return fail(check, subject, `reads the fact "${fact}", which does not exist`)
  const cols = columns.get(fact)
  if (cols && !cols.has(col)) fail(check, subject, `reads ${fact}'s column "${col}", which ${FACTS[fact].program} does not give (${[...cols].join(', ')})`)
}
for (const dim of DIMENSIONS) {
  for (const [fact, col] of Object.entries(dim.fields ?? {})) column('fields', dim.key, fact, col)
  if (dim.members?.fact) column('fields', `${dim.key} members`, dim.members.fact, dim.members.value)
}

// ── settings and programs: read in the application's own files ──
const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : p.endsWith('.mjs') ? [p] : [] })
for (const file of files(HERE)) {
  if (file === fileURLToPath(import.meta.url)) continue
  const text = readFileSync(file, 'utf8')
  const where = relative(PROJECT, file)
  for (const m of text.matchAll(/setting(?:Of)?\(\s*['"]([^'"]+)['"]/g)) if (!settingsInGraph.has(m[1])) fail('settings', where, `reads the setting "${m[1]}", which no domain gives`)
  if (/\bc\.ask\(|\bctx\.graph\b|semantic-graph|time-graph\.mjs/.test(text) && file.includes(`${join(HERE, 'capabilities')}/`)) fail('programs', where, 'reads the semantic graph, not a domain\'s program')
}

for (const f of findings) console.log(`${f.level === 'fail' ? 'FAIL' : 'warn'}  ${f.check.padEnd(15)} ${f.subject} — ${f.says}`)
const failed = findings.filter((f) => f.level === 'fail').length
console.log(`${views.size} views · ${Object.keys(FACTS).length} facts · ${domains.size} domains · ${settingsInGraph.size} settings — ${failed ? `${failed} failed` : 'the application stands on the composition graph'}${findings.length - failed ? `, ${findings.length - failed} warnings` : ''}`)
process.exit(failed ? 1 : 0)
