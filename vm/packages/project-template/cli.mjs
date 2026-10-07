#!/usr/bin/env node
// The project template: what every project home's dashboard and knowledge helpers are made of, so a new project starts
// with the same thing and every project stays in step with it.
//
//   shared/   the files that are the same in every project — the dashboard server's generic files, the whole client,
//             the program helpers. `check` says which differ in a home; `sync` writes them.
//   start/    a new project's own files, written once (never over a file that is there): its facts, dimensions, name
//             and starting points, an empty knowledge index. They are the project's to change.
//
//   node cli.mjs new   <workspace> --name "<name>" --currency <code> --locale <tag> [--hub <wss url>]
//   node cli.mjs check <home>     the shared files a home has changed or lacks (exit 1 when any)
//   node cli.mjs sync  <home>     write the template's shared files into the home
//
// A change to a shared file is made here, then synced to every home — never in one home alone. `{{PLATFORM}}` in a
// file is this repository's place on the machine the template is written on.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLATFORM = resolve(HERE, '..', '..', '..')

const [command, home, ...rest] = process.argv.slice(2)
const flags = {}
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i]
const usage = 'usage: node cli.mjs new|check|sync <project workspace> [--name "<name>" --currency <code> --locale <tag> --hub <wss url>]'
if (!['new', 'check', 'sync'].includes(command) || !home) { console.error(usage); process.exit(1) }
const HOME = resolve(home)

const files = (dir) => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : [p] })
const render = (text, values) => text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? values[k] : m))
const SHARED = files(join(HERE, 'shared')).map((p) => relative(join(HERE, 'shared'), p))
const shared = (rel) => render(readFileSync(join(HERE, 'shared', rel), 'utf8'), { PLATFORM })
const write = (rel, text) => { const p = join(HOME, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text) }

if (command === 'check') {
  const off = SHARED.filter((rel) => !existsSync(join(HOME, rel)) || readFileSync(join(HOME, rel), 'utf8') !== shared(rel))
  for (const rel of off) console.log(`${existsSync(join(HOME, rel)) ? 'differs' : 'missing'}  ${rel}`)
  console.log(off.length ? `${off.length} of ${SHARED.length} shared files are not the template's` : `all ${SHARED.length} shared files are the template's`)
  process.exit(off.length ? 1 : 0)
}

if (command === 'new') {
  // The author's folder (~/.superatom/state/<project id>/author/): where the project's knowledge and app are written,
  // then imported and published to the platform — never read by the engine. Bound to its project, so its material can go
  // to no other project.
  const PROJECT_ID = HOME.split(sep).reverse().find((s) => /^[0-9a-f-]{36}$/.test(s))
  if (!PROJECT_ID) { console.error(`${HOME}: an author's folder sits in its project's folder (~/.superatom/state/<project id>/author)`); process.exit(1) }
  mkdirSync(HOME, { recursive: true })
  if (!existsSync(join(HOME, '.sacli.json'))) writeFileSync(join(HOME, '.sacli.json'), JSON.stringify({ project: PROJECT_ID }, null, 2) + '\n')
  const missing = ['name', 'currency', 'locale'].filter((k) => !flags[k])
  if (missing.length) { console.error(`${usage}\nmissing: ${missing.map((k) => `--${k}`).join(' ')}`); process.exit(1) }
  const values = { PLATFORM, NAME: flags.name, SLUG: flags.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), CURRENCY: flags.currency.toUpperCase(), LOCALE: flags.locale,
    PROJECT_ID, HUB: flags.hub ?? 'wss://superadmin.superatom.site' }
  for (const rel of files(join(HERE, 'start')).map((p) => relative(join(HERE, 'start'), p))) {
    if (existsSync(join(HOME, rel))) { console.log(`kept     ${rel}`); continue }
    write(rel, render(readFileSync(join(HERE, 'start', rel), 'utf8'), values))
    console.log(`started  ${rel}`)
  }
}

// new and sync: files the template no longer ships (moved into the platform) go, so a home never keeps a stale copy.
const RETIRED = JSON.parse(readFileSync(join(HERE, 'retired.json'), 'utf8'))
for (const rel of RETIRED) if (existsSync(join(HOME, rel))) { rmSync(join(HOME, rel)); console.log(`retired  ${rel}`) }
// …and the folders that held only those files.
for (const dir of [...new Set(RETIRED.map((r) => dirname(r)))].sort((a, b) => b.length - a.length)) { const p = join(HOME, dir); if (existsSync(p) && !readdirSync(p).length) rmSync(p, { recursive: true }) }

// new and sync: the shared files, as the template has them.
let changed = 0
for (const rel of SHARED) {
  const text = shared(rel)
  if (existsSync(join(HOME, rel)) && readFileSync(join(HOME, rel), 'utf8') === text) continue
  write(rel, text)
  changed++
  console.log(`wrote    ${rel}`)
}
console.log(`${changed} shared files written, ${SHARED.length - changed} already the template's`)
if (command === 'new') console.log(`next: cd ${join(HOME, 'app', 'web')} && pnpm install — then add a domain to knowledge/index.mts, its facts, dimensions and views`)
