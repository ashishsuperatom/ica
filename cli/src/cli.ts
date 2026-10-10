// sacli — the Superatom CLI. An agent (Codex, Claude, any coding agent) or a person works with Superatom through a key:
// an organisation's (sak_org_<org>_…) or a project's (sak_<project>_…), made by a person or by a key above it. A key
// holds capabilities — the names roles use — never more than its maker holds now; everything it does is checked by the
// platform the same way as for a person, and recorded in the audit history.

import { parseArgs, type ParseArgsConfig } from 'node:util'
import { createInterface } from 'node:readline'
import { CliError, DEFAULT_HUB, maskKey, orgOfKey, projectOfKey, readCredentials, writeCredentials, configPath, folderProfile, folderProject } from './config.ts'
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, type Hub } from './hub.ts'
import { viaDaemon, stopDaemon, daemonStatus, serveDaemon, type Conn } from './daemon.ts'
import { card, sessionView, table } from './render.ts'
import { engineCommand, realDeps } from './engine.ts'
import { loadFile } from './load.ts'
import { initAgent } from './agent-template.ts'

export const VERSION = '0.1.0'

export interface Io { stdout: (s: string) => void; stderr: (s: string) => void; env: NodeJS.ProcessEnv; stdin?: () => Promise<string>; isTTY?: boolean
  /** This program's own file, to start the background connection with; without it every command connects directly. */
  script?: string
  cwd?: string }

const HELP: Record<string, string> = {
  main: `sacli — the Superatom CLI

Usage: sacli <command> [options]

Commands:
  login            save a key (from --key, $SACLI_KEY or stdin) as a profile
  profiles         the saved profiles — one key each — and which is in use
  projects         the organisation's projects: list, create, delete, restore (an organisation key)
  engine           where the project's engine runs: start (in Docker; --native for PM2), status, stop, logs
  keys             keys below this one: list, create, revoke (--project <id> for a project's, with an organisation key)
  api              call the platform's REST API with this key: sacli api <METHOD> <path> [--data '<json>']
  datasources      the project's data sources: list, show, create, update, remove, my-key (a person's own key)
  dsi              each source's index: stats, show [--as-of], describe, enable, disable, build, status, snapshot
  storage          what a project (or, with an organisation key, every project) keeps: totals, list, delete
  use              make a profile the one in use (--here: for this folder only)
  logout           forget a saved key
  whoami           the key in use, its project, and whether the hub accepts it
  agents           the project's agents
  session open     start a session with an agent
  session get      a session: its current thread, answers and actions
  session intent   change a session: set/add/remove, call a function, take an action
  session goto     move a session to another block
  ask              ask the project a question in words
  activity         what is running for you in the project (builds, runs), and what ran lately
  warehouse        the organisation's warehouse: tables, query, append — and, with an organisation key, create and grant
  app publish      publish the project's app (its server/ and web/ source) — the engine downloads and runs it
  program build    build a program from its source folder: the build and its source are kept by the platform
  graph import     import the project's written knowledge (knowledge/index.mts) into its graph, on the platform
  agent            an agent as one folder — its domain, its programs, its STATE: init a new one, push it to the platform
  map              the project's map — the sections and places people see, each place an agent: show, set
  call             send any message the platform takes, with its fields as JSON (prints the reply as JSON)
  status           the background connection: up, since when, how long until it closes
  disconnect       close the background connection now

Global options:
  --profile <name>   the saved key to use (default: the default profile)
  --key <key>        an agent key for this command only (or $SACLI_KEY)
  --hub <url>        the hub (default ${DEFAULT_HUB}, or $SACLI_HUB)
  --json             machine-readable output
  --timeout <s>      how long to wait for a reply (default 120)
  --no-daemon        connect for this command only (no background connection; also $SACLI_NO_DAEMON=1)
  -h, --help         help for a command
  -V, --version      the version

A key belongs to one project (sak_<project>_…) or one organisation (sak_org_<org>_…), and a profile holds one key:
each profile is one project or organisation. An organisation key holding org.projects works on all its projects. The profile in use is
--profile, else $SACLI_PROFILE, else the nearest .sacli.json in this folder or above, else the default.
Commands share one background connection per project, kept for an hour after the last command.

Exit codes: 0 done · 1 refused or failed · 2 bad usage · 3 the key was refused · 4 network or timeout
Run 'sacli <command> --help' for a command's options.`,
  login: `sacli login [--key <key>] [--profile <name>] [--hub <url>]

Saves an agent API key, after checking the hub accepts it. The key is read from --key, $SACLI_KEY, or stdin
(so it never has to appear in your shell history):  printf %s "$KEY" | sacli login
Keys are made in the admin console, or by a key above them (sacli keys create). Saved in ${'$'}SACLI_CONFIG or ~/.config/superatom/credentials.json (mode 600).`,
  logout: `sacli logout [--profile <name>]      forgets the saved key`,
  whoami: `sacli whoami [--profile <name>]      the key in use (masked), its project, and whether the hub accepts it`,
  agents: `sacli agents                        the project's agents (needs project.view)`,
  session: `sacli session <open|get|intent|goto> …

  sacli session open <agent> [--id <session>]
  sacli session get <session> [--as-of <iso time>]
  sacli session intent <session> [--set <path>=<json>]… [--add <path>=<json>]… [--remove <path>[=<json>]]…
                                 [--call <package>.<fn>] [--param <name>=<json>]… [--act <package>.<action>]
                                 [--to current|new] [--block <block>]
  sacli session goto <session> <block>

An intent to "current" (the default) replaces the current block's answer; "new" opens a block. An intent from an
earlier block (--block) branches the session into a new thread. Values are JSON; a bare word is a string.`,
  profiles: `sacli profiles      the saved profiles, their projects or organisations, and which one is in use here`,
  projects: `sacli projects <list|create|delete|restore|rename> …     with an organisation key holding org.projects

  sacli projects list [--deleted]
  sacli projects create <name>          a project whose engine runs outside the platform (it connects out)
  sacli projects delete <id>            removable for 30 days: sacli projects restore <id>
  sacli projects restore <id>
  sacli projects rename <id> <name>      the name its people see`,
  engine: `sacli engine <start|status|stop|logs> [--project <id>]

  sacli engine start [--native] [--image <ref>] [--wait <s>]
                     runs the project's engine in Docker — container and volume sa-engine-<project>, restarted unless
                     stopped; the image (default superatom-engine:local) is built from the repo when there is none.
                     Again: nothing changes, or, when the image changed, the container is made again on the same volume.
                     --native runs it under PM2 instead, from the project's home (~/.superatom/<project>/.env).
                     Waits until the hub has the engine (default 180 s).
  sacli engine status          where it runs on this machine, and whether the hub has it
  sacli engine stop            stops it (the data stays: the volume, or the home)
  sacli engine logs [--follow] [--lines <n>]

The project is the key's (a profile is one project), or --project with an organisation key. What the engine connects
with comes from the platform and needs project.manage; it is never printed.`,
  keys: `sacli keys <list|create|revoke> … [--project <id>]

  sacli keys list
  sacli keys create <name> --can <capability>,… [--days <n> | --never] [--save-as <profile>]
  sacli keys revoke <key id>

The keys of this key's node: its organisation's, or its project's — or, with an organisation key and --project, that
project's. A new key holds at most what this one holds, and goes when this one goes; a key revokes only keys below it.
The new key is shown once; with --save-as it is saved as that profile instead and never printed.
Capabilities are the names roles use (sacli api GET /api/me shows what this key holds).`,
  api: `sacli api <GET|POST|PUT|DELETE> <path> [--data '<json>']     e.g. sacli api GET /api/projects/<id>/agent-keys`,
  datasources: `sacli datasources <list|show|create|update|remove|my-key> … [--project <id>]

  sacli datasources list
  sacli datasources show <name>
  sacli datasources create <name> --connector <id> [values] [--kind sql] [--dialect mssql] [--description "…"] [--auth shared|per-user]
  sacli datasources update <name> [values] [--kind …] [--dialect …] [--description …] [--auth …]
  sacli datasources remove <name>
  sacli datasources bridge <name> <file.mjs>      the code its connector runs (a template's copy, e.g. mssql.bridge.mjs);
                                                  --bridge <file> on create or update does the same
  sacli datasources my-key <name> [values]        your own key, for a source that reaches each person with theirs

Values — what the connector asks for (sacli api GET /api/projects/<id>/connectors lists each connector's fields):
  --set <field>=<value>             a setting
  --secret <field>=<value>          a secret; <field>=@<file> reads it from a file (a PEM key, a certificate, …)
  --values-file <file> [--prefix P] KEY=VALUE lines: each key matched to a field by name, ignoring case, _ and -, after
                                    taking away the prefix (FABRIC_TENANT_ID with --prefix FABRIC_ → tenantId); a value
                                    @<file> is read from that file
Secrets go to the platform, sealed; they are never printed, and never written on any engine's disk.`,
  storage: `sacli storage [list|delete] … [--project <id>]

  sacli storage                                     how much the project keeps, by kind and by person (your own);
                                                    with an organisation key and no --project: every project, summed
  sacli storage list [--by <who>] [--kind <kind>] [--page n]   the objects themselves: where, how big, who, when,
                                                    and whether in use (yours; anyone's for who runs the project)
  sacli storage delete <key>… | --everything [--by <who>]      remove them (never what is in use)
Kinds: parcel, program, bridge, app, attachment, dashboard.`,
  dsi: `sacli dsi <stats|show|describe|enable|disable|build|status|snapshot> …

  sacli dsi stats                                   each source: tables, fields, disabled, gone, its last build
  sacli dsi show <source>[.<table>] [--as-of <iso time>]   the index now, or as it was then
  sacli dsi describe <source>.<table>[.<field>] "<text>" --by human|ai     who wrote it decides where it is kept
  sacli dsi enable|disable <source>.<table>[.<field>]     a disabled table hides all its fields from find-schema/get-schema
  sacli dsi build [<source>…] [--tables a,b] [--fresh]    one build at a time; --tables reads only those tables
  sacli dsi status [--watch]                        the build running (stage, table, counts) or the last one
  sacli dsi snapshot                                the whole current index, as one JSON document`,
  use: `sacli use <profile> [--here]   make <profile> the default, or (--here) write .sacli.json so this folder uses it`,
  app: `sacli app publish <app folder>

The project's own application — server/ (what the engine runs) and the dashboard's web/ source — kept by the platform as
a new version (unchanged source: nothing new); the engine downloads it and reloads. No node_modules or builds travel.
Needs project.manage.`,
  program: `sacli program build <folder>

A program's source — manifest.json, doc.md, server/…, web/… — built by the project's engine and kept by the platform,
the build with the source it came from. Needs project.ask.`,
  agent: `sacli agent init <folder>            a new agent's folder from the template, named for its last part
  sacli agent push <folder> [--reason '<why>']   its domain imported, each program built, the agent written

An agent is one folder: agent.json (its title, domain, programs, the agent that answers in words, tools, look, where its
STATE starts and its starting points), knowledge/index.mts (its domain — the concepts it answers from) and
programs/<name>/ (each program: manifest.json, doc.md, server/, web/). A click changes STATE through an Intent; a
question in words is answered from the domain and the programs' docs, and may change STATE the same way.
Needs project.ask; importing the domain and writing a global agent need someone who may publish.`,
  map: `sacli map [show]                      the project's map: its sections, and each place's address and agent
  sacli map set <map.json> [--reason '<why>']   write it (someone who may publish)

The map is what people see to find their way: { "sections": [{ "label", "items": [{ "agent", "slug"?, "label"?,
"icon"? }] }] }. Every place is an agent of the project; its slug (else the agent's name) is its address, /<slug>, and
is never one of the app's own (about, agents, activity, connections, profile, settings, a, c, s, w, u, dashboard,
admin, api, ws, assets, auth). An agent not on the map is found by search and on the All agents page.`,
  graph: `sacli graph import <knowledge/index.mts> [--reason '<why>']

The project's written knowledge — its domains, their concepts and files, its settings — imported into the project's
composition graph, which the platform holds (engines download it). What is unchanged records nothing. Needs
project.publish.`,
  call: `sacli call <message> [--data '<json>']    e.g. sacli call graph:agent --data '{"name":"trips","body":{…}}'`,
  activity: `sacli activity         what is running for this key (program builds, session runs) and what ran in the last day`,
  status: `sacli status        whether the background connection for this key is up, and for how long`,
  disconnect: `sacli disconnect    closes the background connection for this key (the next command opens a new one)`,
  ask: `sacli ask <question> [--session <id>] [--channel <name>] [--graph draft|<version>]   asks in words; prints the answer (needs project.ask); --channel answers as that chat (teams) reads it; --graph asks a NEW session of the knowledge at the draft or an earlier version (v1…) instead of the published one — to try a change before publishing, or compare versions (needs project.publish)`,
  warehouse: `sacli warehouse <tables|query|append|create|grants|grant|revoke> …

  sacli warehouse tables                               the tables you may see, and their columns
  sacli warehouse query "<sql>" [--limit <n>]          SQL over them (read-only; a project key reads its grant only)
  sacli warehouse append <table> [--rows '<json>' | --file <rows.json>]   rows (a JSON list; stdin when neither)
With an organisation key (sak_org_…) made by someone who may manage the warehouse:
  sacli warehouse explore <rows|values|profile|spread> <table | --sql "<query>"> [--column c] [--q text] [--sort c --desc] [--page n --size n]
  sacli warehouse load <file> [--project <id>] [--replace | --append] [--table <name>] [--sheet <name>] [--tables a,b]
                                                       a file's tables into the warehouse: a DuckDB database (each table;
                                                       --tables picks, views too), a CSV (one table) or an Excel workbook
                                                       (each sheet; --sheet picks). Types are DuckDB's, mapped to the
                                                       warehouse's; names made lower_case. --project grants each table to
                                                       that project to read. A table already there is refused unless
                                                       --replace (dropped, made anew) or --append (same columns).
  sacli warehouse create <table> --column <name>:<type>[!] …   types: string long int double float boolean date
                                                              timestamp timestamptz; a ! makes the column required
  sacli warehouse grants --project <id>                what a project may read and write
  sacli warehouse grant <table> --project <id> [--columns a,b] [--write]   let a project read (all or some columns)
                                                              — and, with --write, append (all columns)
  sacli warehouse revoke <table> --project <id>

A project key needs warehouse.use to read and warehouse.append to append, and appends only to tables the organisation
granted the project to write. An organisation key needs warehouse.query, warehouse.write or warehouse.manage.`,
}

const GLOBAL: ParseArgsConfig['options'] = {
  profile: { type: 'string' }, key: { type: 'string' }, hub: { type: 'string' }, json: { type: 'boolean' },
  timeout: { type: 'string' }, 'no-daemon': { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
}

const value = (raw: string): unknown => { try { return JSON.parse(raw) } catch { return raw } }
function pair(raw: string, flag: string): [string, unknown] {
  const eq = raw.indexOf('=')
  if (eq < 1) throw new CliError(`--${flag} ${raw}: write <name>=<value>`, 2)
  return [raw.slice(0, eq), value(raw.slice(eq + 1))]
}
function dotted(raw: string | undefined, flag: string): [string, string] | null {
  if (raw === undefined) return null
  const m = /^([\w-]+)\.([\w-]+)$/.exec(raw)
  if (!m) throw new CliError(`--${flag} ${raw}: write <package>.<name>`, 2)
  return [m[1], m[2]]
}

export async function run(argv: string[], io: Io): Promise<number> {
  const say = (s: string) => io.stdout(s.endsWith('\n') ? s : s + '\n')
  const warn = (s: string) => io.stderr(`sacli: ${s}\n`)
  let hub: Hub | Conn | null = null
  try {
    // The command words come first; options may be anywhere.
    const words = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && /^--(profile|key|hub|timeout|id|as-of|set|add|remove|call|param|act|to|block|session|rows|file|limit|column|project|columns|data|can|days|save-as|connector|secret|values-file|prefix|kind|dialect|description|auth|by|tables|bridge|page|image|wait|lines|table|sheet|batch)$/.test(argv[i - 1])))
    const [cmd, sub] = words
    const specific: ParseArgsConfig['options'] = cmd === 'session'
      ? { id: { type: 'string' }, 'as-of': { type: 'string' }, set: { type: 'string', multiple: true }, add: { type: 'string', multiple: true }, remove: { type: 'string', multiple: true },
          call: { type: 'string' }, param: { type: 'string', multiple: true }, act: { type: 'string' }, to: { type: 'string' }, block: { type: 'string' } }
      : cmd === 'warehouse' ? { table: { type: 'string' }, sheet: { type: 'string' }, tables: { type: 'string' }, replace: { type: 'boolean' }, append: { type: 'boolean' }, batch: { type: 'string' }, rows: { type: 'string' }, file: { type: 'string' }, limit: { type: 'string' }, column: { type: 'string', multiple: true }, project: { type: 'string' }, columns: { type: 'string' }, write: { type: 'boolean' }, q: { type: 'string' }, sort: { type: 'string' }, desc: { type: 'boolean' }, page: { type: 'string' }, size: { type: 'string' }, sql: { type: 'string' } }
      : cmd === 'ask' ? { session: { type: 'string' }, channel: { type: 'string' }, graph: { type: 'string' } } : cmd === 'use' ? { here: { type: 'boolean' } } : cmd === 'call' || cmd === 'api' ? { data: { type: 'string' } } : cmd === 'projects' ? { deleted: { type: 'boolean' } }
      : cmd === 'keys' ? { project: { type: 'string' }, can: { type: 'string' }, days: { type: 'string' }, never: { type: 'boolean' }, 'save-as': { type: 'string' } }
      : cmd === 'datasources' ? { project: { type: 'string' }, connector: { type: 'string' }, set: { type: 'string', multiple: true }, secret: { type: 'string', multiple: true }, 'values-file': { type: 'string' }, prefix: { type: 'string' }, kind: { type: 'string' }, dialect: { type: 'string' }, description: { type: 'string' }, auth: { type: 'string' }, bridge: { type: 'string' } }
      : cmd === 'engine' ? { project: { type: 'string' }, native: { type: 'boolean' }, image: { type: 'string' }, wait: { type: 'string' }, follow: { type: 'boolean', short: 'f' }, lines: { type: 'string' } }
      : cmd === 'storage' ? { project: { type: 'string' }, by: { type: 'string' }, kind: { type: 'string' }, page: { type: 'string' }, everything: { type: 'boolean' } }
      : cmd === 'dsi' ? { 'as-of': { type: 'string' }, by: { type: 'string' }, tables: { type: 'string' }, fresh: { type: 'boolean' }, watch: { type: 'boolean' } } : cmd === 'graph' || cmd === 'map' || cmd === 'agent' ? { reason: { type: 'string' } } : {}
    let parsed
    try { parsed = parseArgs({ args: argv, options: { ...GLOBAL, ...specific }, allowPositionals: true, strict: true }) }
    catch (e: any) { throw new CliError(`${e.message.replace(/^Unknown option/, 'unknown option')} — see sacli ${cmd ?? ''} --help`.replace(/\s+—/, ' —'), 2) }
    const o = parsed.values as Record<string, any>
    const pos = parsed.positionals

    if (o.version) { say(VERSION); return 0 }
    if (cmd === '__daemon') { await serveDaemon(io.env); return -1 }
    if (!cmd || o.help) { say(HELP[cmd ?? 'main'] ?? HELP.main); return cmd && !HELP[cmd] ? 2 : 0 }
    if (!HELP[cmd] && cmd !== '__daemon') throw new CliError(`there is no command "${cmd}" — see sacli --help`, 2)

    const timeoutMs = o.timeout ? Number(o.timeout) * 1000 : 120_000
    if (!(timeoutMs > 0)) throw new CliError('--timeout is a number of seconds', 2)
    const creds = readCredentials(io.env)
    const folder = folderProfile(io.cwd ?? process.cwd())
    const profileName = o.profile ?? io.env.SACLI_PROFILE ?? folder?.profile ?? creds.default ?? 'default'
    const saved = creds.profiles[profileName]
    const hubUrl = o.hub ?? io.env.SACLI_HUB ?? saved?.hub ?? DEFAULT_HUB
    const out = (human: string, data: unknown) => say(o.json ? JSON.stringify(data, null, 2) : human)

    if (cmd === 'profiles') {
      const names = Object.keys(creds.profiles)
      if (!names.length) { out('no saved profiles — run sacli login', []); return 0 }
      const rows = names.map((n) => ({ profile: n, project: projectOfKey(creds.profiles[n].key) ?? `organisation ${orgOfKey(creds.profiles[n].key)}`, hub: creds.profiles[n].hub, inUse: n === profileName, isDefault: n === creds.default }))
      out(table(['', 'profile', 'project', 'hub'], rows.map((r) => [r.inUse ? '*' : '', r.profile + (r.isDefault ? ' (default)' : ''), r.project, r.hub])) + (folder ? `\n(this folder uses "${folder.profile}" — ${folder.file})` : ''), rows)
      return 0
    }
    if (cmd === 'use') {
      const name = pos[1]
      if (!name) throw new CliError('which profile? sacli use <profile>', 2)
      if (!creds.profiles[name]) throw new CliError(`there is no profile "${name}" — see sacli profiles`, 2)
      if (o.here) { const f = join(io.cwd ?? process.cwd(), '.sacli.json'); writeFileSync(f, JSON.stringify({ profile: name }, null, 2) + '\n'); out(`this folder now uses "${name}" (${f})`, { profile: name, file: f }); return 0 }
      creds.default = name
      writeCredentials(creds, io.env)
      out(`"${name}" is now the default`, { default: name })
      return 0
    }
    if (cmd === 'logout') {
      if (!saved) { warn(`no saved key in profile "${profileName}"`); return 1 }
      delete creds.profiles[profileName]
      if (creds.default === profileName) delete creds.default
      writeCredentials(creds, io.env)
      out(`forgot the key in profile "${profileName}"`, { ok: true, profile: profileName })
      return 0
    }

    let key: string | undefined = o.key ?? io.env.SACLI_KEY
    if (cmd === 'login' && !key) {
      if (!io.stdin) throw new CliError('give the key with --key, $SACLI_KEY or on stdin', 2)
      if (io.isTTY) io.stderr('Paste the agent key, then press Enter: ')
      key = (await io.stdin()).trim()
    }
    key ??= saved?.key
    if (!key) throw new CliError(`no agent key — run 'sacli login' (profile "${profileName}"), or pass --key or $SACLI_KEY`, 3)
    const org = orgOfKey(key)
    if (!projectOfKey(key) && !org) throw new CliError('that is not an agent key (sak_<project>_<secret>, or sak_org_<org>_<secret>) — make one in the admin console', 3)
    // The explorer's structured reads: sacli warehouse explore <rows|values|profile|spread> <table> [--column c] [--q text] [--sort c] [--desc] [--page n] [--size n]
    const exploreReq = (args: string[]) => {
      const [op, table] = args
      if (!['rows', 'values', 'profile', 'spread'].includes(String(op)) || (!table && !o.sql)) throw new CliError('sacli warehouse explore <rows|values|profile|spread> <table | --sql "<query>"> [--column c] [--q text] [--sort c] [--desc] [--page n] [--size n]', 2)
      return { t: 'warehouse:explore', op, ...(o.sql ? { query: { sql: String(o.sql) } } : { table }), ...(o.column ? { column: String(Array.isArray(o.column) ? o.column[0] : o.column) } : {}), q: o.q ? String(o.q) : '', where: [], ...(o.sort ? { sort: String(o.sort), dir: o.desc ? 'desc' : 'asc' } : {}), page: o.page ? Number(o.page) : 1, size: o.size ? Number(o.size) : 50 }
    }
    const rowsGiven = async (): Promise<unknown[]> => {
      let text = o.rows as string | undefined
      if (!text && o.file) { try { text = readFileSync(String(o.file), 'utf8') } catch (e: any) { throw new CliError(`cannot read ${o.file}: ${e.message}`, 2) } }
      if (!text && io.stdin) text = await io.stdin()
      let rows: unknown
      try { rows = JSON.parse(String(text ?? '')) } catch { throw new CliError('rows are a JSON list of objects (--rows, --file, or stdin)', 2) }
      if (!Array.isArray(rows) || !rows.length) throw new CliError('rows are a JSON list of objects, at least one', 2)
      return rows
    }
    const showTables = (tables: any[]) => tables.length ? tables.map((t) => `${t.name}${t.writable ? '  (this project may append)' : ''}\n${table(['column', 'type', ''], (t.columns ?? []).map((c: any) => [c.name, c.type, c.required ? 'required' : '']))}`).join('\n\n') : 'no tables you may see'
    const showResult = (r: any) => r.rows?.length ? table(r.columns ?? Object.keys(r.rows[0]), r.rows.map((x: any) => (r.columns ?? Object.keys(x)).map((c: string) => x[c] === null || x[c] === undefined ? '' : String(x[c])))) + (r.truncated ? '\n(more rows: narrow the query or raise --limit)' : '') : 'no rows'

    // ── The platform's REST API with this key: the same routes, checks and audit as the console's ──
    const httpBase = hubUrl.replace(/^ws/, 'http')
    const rest = async (method: string, path: string, body?: unknown): Promise<any> => {
      let r: Response
      try { r = await fetch(`${httpBase}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) }) }
      catch (e: any) { throw new CliError(`the hub could not be reached: ${e.message}`, 4) }
      const text = await r.text()
      let b: any; try { b = JSON.parse(text) } catch { b = { error: text.trim() } }
      if (!r.ok) throw new CliError(b?.error ?? b?.reason ?? `the hub answered ${r.status}`, r.status === 401 ? 3 : 1)
      return b
    }
    if (cmd === 'api') {
      const method = String(pos[1] ?? '').toUpperCase(), path = pos[2]
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !path?.startsWith('/')) throw new CliError(HELP.api, 2)
      let data: unknown
      if (o.data !== undefined) { try { data = JSON.parse(String(o.data)) } catch { throw new CliError('--data is JSON', 2) } }
      const r = await rest(method, path, data); say(JSON.stringify(r, null, 2)); return 0
    }
    if (cmd === 'projects') {
      if (!org) throw new CliError('projects are made and removed with an organisation key (sak_org_…) holding org.projects', 2)
      if (!sub || sub === 'list') {
        const r = await rest('GET', `/api/projects${o.deleted ? '?deleted=1' : ''}`)
        const list = Array.isArray(r) ? r : (r.projects ?? [])
        out(list.length ? table(['id', 'name', 'created'], list.map((p: any) => [p.id, p.name ?? '', p.created_at ? new Date(Number(p.created_at) < 1e12 ? Number(p.created_at) * 1000 : p.created_at).toISOString().slice(0, 10) : ''])) : 'no projects', list)
        return 0
      }
      const arg = pos[2]
      if (!arg) throw new CliError(HELP.projects, 2)
      if (sub === 'create') { const r = await rest('POST', '/api/projects', { name: pos.slice(2).join(' '), provider: 'external' }); out(`made project ${r.id}`, { id: r.id, provider: r.provider }); return 0 }
      if (sub === 'delete') { const r = await rest('DELETE', '/api/projects', { id: arg }); out(`removed project ${arg} (restorable: sacli projects restore ${arg})`, r); return 0 }
      if (sub === 'restore') { const r = await rest('PUT', '/api/projects', { id: arg }); out(`restored project ${arg}`, r); return 0 }
      if (sub === 'rename') { const name = pos.slice(3).join(' ').trim(); if (!name) throw new CliError('sacli projects rename <id> <name>', 2); const r = await rest('PATCH', '/api/projects', { id: arg, name }); out(`renamed project ${arg} to "${r.name ?? name}"`, r); return 0 }
      throw new CliError(HELP.projects, 2)
    }
    if (cmd === 'engine') {
      const pid = String(o.project ?? projectOfKey(key) ?? '')
      if (!pid) throw new CliError('which project? --project <id> (an organisation key works on any of its projects)', 2)
      const repo = io.script ? resolve(dirname(realpathSync(io.script)), '../..') : null
      return await engineCommand(sub, pid, o, realDeps({ rest, say: out, note: (s) => io.stderr(`${s}\n`), env: io.env, repo: repo && existsSync(join(repo, 'Dockerfile')) ? repo : null }))
    }
    if (cmd === 'storage') {
      const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
      const pid = String(o.project ?? projectOfKey(key) ?? '')
      if (!pid) {
        if (sub && sub !== 'usage') throw new CliError('which project? --project <id>', 2)
        const r = await rest('GET', '/api/storage')
        out(`${mb(r.bytes)} in ${r.objects} objects\n` + table(['project', 'name', 'objects', 'size'], r.projects.map((p: any) => [p.project, p.name ?? '', String(p.objects), mb(p.bytes)]))
          + (r.people?.length ? '\n\n' + table(['by', 'objects', 'size', 'in'], r.people.map((x: any) => [x.by, String(x.objects), mb(x.bytes), x.projects.map((p: any) => `${p.name ?? p.project.slice(0, 8)} ${mb(p.bytes)}`).join(', ')])) : ''), r)
        return 0
      }
      const base = `/api/projects/${pid}/storage`
      if (!sub || sub === 'usage') {
        const r = await rest('GET', base)
        out([`${mb(r.bytes)} in ${r.objects} objects`, table(['kind', 'objects', 'size'], r.byKind.map((k: any) => [k.kind, String(k.objects), mb(Number(k.bytes))])),
          r.byPerson.length ? table(['by', 'objects', 'size'], r.byPerson.map((k: any) => [k.by, String(k.objects), mb(Number(k.bytes))])) : ''].filter(Boolean).join('\n\n'), r)
        return 0
      }
      if (sub === 'list') {
        const q = new URLSearchParams({ list: '1', ...(o.by ? { by: String(o.by) } : {}), ...(o.kind ? { kind: String(o.kind) } : {}), ...(o.page ? { page: String(o.page) } : {}) })
        const r = await rest('GET', `${base}?${q}`)
        out(r.list.length ? table(['key', 'kind', 'size', 'by', 'at', 'in use'], r.list.map((x: any) => [x.key, x.kind, mb(Number(x.bytes)), x.by ?? '', String(x.at).slice(0, 19), x.inUse ?? ''])) + (r.listed > r.list.length ? `\n(${r.list.length} of ${r.listed} — --page)` : '') : 'nothing', r)
        return 0
      }
      if (sub === 'delete') {
        const keys = pos.slice(2)
        if (!keys.length && !o.everything) throw new CliError(HELP.storage, 2)
        const r = await rest('DELETE', base, o.everything ? { everything: true, ...(o.by ? { by: String(o.by) } : {}) } : { keys })
        out(`removed ${r.removed}${r.refused.length ? `; kept ${r.refused.length}:\n` + r.refused.map((x: any) => `  ${x.key} — ${x.why}`).join('\n') : ''}`, r)
        return 0
      }
      throw new CliError(HELP.storage, 2)
    }
    if (cmd === 'datasources') {
      const pid = String(o.project ?? projectOfKey(key) ?? '')
      if (!pid) throw new CliError('which project? --project <id> (an organisation key works on any of its projects)', 2)
      const base = `/api/projects/${pid}/connections`
      const all = async () => ((await rest('GET', base)).connections ?? []) as any[]
      const named = async (name: string) => { const c = (await all()).find((x) => x.name === name || x.id === name); if (!c) throw new CliError(`there is no data source ${name} — sacli datasources list`, 1); return c }
      // The values a connector asks for, from --set / --secret / --values-file; a free-form source ("code") takes them as
      // its settings and secrets maps, any other is matched to its declared fields.
      const values = async (connectorId: string): Promise<Record<string, unknown>> => {
        const fileOr = (v: string) => (v.startsWith('@') ? readFileSync(resolve(io.cwd ?? process.cwd(), v.slice(1)), 'utf8') : v)
        const pairs = (list: string[] | undefined, flag: string) => (list ?? []).map((x) => { const i = x.indexOf('='); if (i < 1) throw new CliError(`--${flag} ${x.split('=')[0]}: write <field>=<value>`, 2); return [x.slice(0, i), fileOr(x.slice(i + 1))] as [string, string] })
        const sets = pairs(o.set, 'set'), secrets = pairs(o.secret, 'secret')
        const fromFile: [string, string][] = o['values-file'] ? readFileSync(resolve(io.cwd ?? process.cwd(), String(o['values-file'])), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
          .map((l) => { const i = l.indexOf('='); let k = l.slice(0, i).trim(); if (o.prefix && k.startsWith(String(o.prefix))) k = k.slice(String(o.prefix).length); return [k, fileOr(l.slice(i + 1).trim().replace(/^["']|["']$/g, ''))] as [string, string] }) : []
        if (connectorId === 'code') return { settings: Object.fromEntries(sets), secrets: Object.fromEntries([...fromFile, ...secrets]) }
        const connectors = ((await rest('GET', `/api/projects/${pid}/connectors`)).connectors ?? []) as any[]
        const c = connectors.find((x) => x.id === connectorId)
        if (!c) throw new CliError(`there is no connector ${connectorId}`, 2)
        const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, '')
        const out: Record<string, unknown> = {}
        for (const [k, v] of [...fromFile, ...sets, ...secrets]) {
          const f = (c.fields ?? []).find((x: any) => norm(x.name) === norm(k))
          if (!f) throw new CliError(`${c.title} has no field ${k} (its fields: ${(c.fields ?? []).map((x: any) => x.name).join(', ')})`, 2)
          out[f.name] = v
        }
        return out
      }
      const sendBridge = async (id: string, file: string) => {
        let code: string
        try { code = readFileSync(resolve(io.cwd ?? process.cwd(), file), 'utf8') } catch (e: any) { throw new CliError(`cannot read ${file}: ${e.message}`, 2) }
        return await rest('PUT', `${base}/${id}/bridge`, { code }) as { bridge: string; changed: boolean }
      }
      const about = { ...(o.kind ? { kind: o.kind } : {}), ...(o.dialect ? { dialect: o.dialect } : {}), ...(o.description ? { description: o.description } : {}), ...(o.auth ? { auth: o.auth } : {}) }
      const show = (c: any) => [`${c.name}  (${c.id})`, `connector    ${c.connector}${c.kind ? ` · ${c.kind}` : ''}${c.dialect ? ` · ${c.dialect}` : ''}`, `reached by   ${c.auth === 'per-user' ? "each person's own key" : 'one shared key'}`,
        `runnable     ${c.runnable ? 'yes' : 'no'}`, ...(c.description ? [`description  ${c.description}`] : []), `settings     ${JSON.stringify(c.settings)}`].join('\n')
      if (!sub || sub === 'list') { const list = await all(); out(list.length ? table(['name', 'connector', 'kind', 'dialect', 'auth', 'runnable'], list.map((c) => [c.name, c.connector, c.kind ?? '', c.dialect ?? '', c.auth ?? 'shared', c.runnable ? 'yes' : 'no'])) : 'no data sources', list); return 0 }
      const name = pos[2]
      if (!name) throw new CliError(HELP.datasources, 2)
      if (sub === 'show') { const c = await named(name); out(show(c), c); return 0 }
      if (sub === 'create') {
        if (!o.connector) throw new CliError('which connector? --connector <id> (sacli api GET /api/projects/<id>/connectors)', 2)
        const r = await rest('POST', base, { connector: o.connector, name, values: await values(String(o.connector)), ...about })
        const b = o.bridge ? await sendBridge(r.connection.id, String(o.bridge)) : null
        out(`made data source ${name} (${r.connection.id})${b ? ` with its bridge ${b.bridge.slice(0, 12)}` : ''}`, { ...r.connection, ...(b ? { bridge: b.bridge } : {}) }); return 0
      }
      if (sub === 'update') {
        const c = await named(name)
        const r = await rest('PATCH', `${base}/${c.id}`, { values: await values(c.connector), ...about })
        const b = o.bridge ? await sendBridge(c.id, String(o.bridge)) : null
        out(`updated ${name}${b ? (b.changed ? ` and its bridge (${b.bridge.slice(0, 12)})` : ' (its bridge unchanged)') : ''}`, r.connection); return 0
      }
      if (sub === 'bridge') { const c = await named(name); if (!pos[3]) throw new CliError(HELP.datasources, 2); const b = await sendBridge(c.id, pos[3]); out(b.changed ? `${name} runs bridge ${b.bridge.slice(0, 12)} now` : `${name} already runs that bridge`, b); return 0 }
      if (sub === 'remove') { const c = await named(name); await rest('DELETE', `${base}/${c.id}`); out(`removed ${name}`, { removed: c.id }); return 0 }
      if (sub === 'my-key') { const c = await named(name); await rest('PUT', `${base}/${c.id}/my-key`, { values: await values(c.connector) }); out(`your key for ${name} is kept, sealed`, { saved: true }); return 0 }
      throw new CliError(HELP.datasources, 2)
    }
    if (cmd === 'keys') {
      const base = o.project ? `/api/projects/${o.project}/agent-keys` : org ? '/api/keys' : `/api/projects/${projectOfKey(key)}/agent-keys`
      if (!sub || sub === 'list') {
        const keys = ((await rest('GET', base)).keys ?? []) as any[]
        out(keys.length ? table(['id', 'name', 'may', 'for', 'made by key', 'state'], keys.map((k) => [k.id, k.name, (k.capabilities ?? []).join(','), k.created_by, k.made_by_key ?? '', k.revoked_at ? 'revoked' : k.expires_at ? `until ${k.expires_at.slice(0, 10)}` : 'no expiry'])) : 'no keys', keys)
        return 0
      }
      if (sub === 'create') {
        const name = pos.slice(2).join(' ').trim()
        const capabilities = String(o.can ?? '').split(',').map((c) => c.trim()).filter(Boolean)
        if (!name || !capabilities.length) throw new CliError(HELP.keys, 2)
        if (o['save-as'] && creds.profiles[o['save-as']]) throw new CliError(`there is a profile "${o['save-as']}" already — sacli logout --profile ${o['save-as']} first`, 2)
        const days = o.never ? null : Number(o.days ?? 90)
        if (days !== null && !(days > 0)) throw new CliError('--days is a number of days', 2)
        const r = await rest('POST', base, { name, capabilities, expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString() })
        if (o['save-as']) {
          creds.profiles[o['save-as']] = { key: r.key, hub: hubUrl, savedAt: new Date().toISOString() }
          const file = writeCredentials(creds, io.env)
          out(`made key ${r.record.id} (${r.record.capabilities.join(', ')}) and saved it as profile "${o['save-as']}" in ${file}`, { record: r.record, profile: o['save-as'] })
        } else out(`made key ${r.record.id} (${r.record.capabilities.join(', ')}) — copy it now, it is not shown again:
${r.key}`, r)
        return 0
      }
      if (sub === 'revoke') { const id = pos[2]; if (!id) throw new CliError(HELP.keys, 2); const r = await rest('DELETE', `${base}/${encodeURIComponent(id)}`); out(`revoked ${id} — and every key it made`, r); return 0 }
      throw new CliError(HELP.keys, 2)
    }

    // ── An organisation key: the warehouse over plain HTTP (no project, no socket) ──
    if (org) {
      const call = async (body: Record<string, unknown>) => {
        let r: Response
        try { r = await fetch(`${hubUrl.replace(/^ws/, 'http')}/api/org-agent`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }) }
        catch (e: any) { throw new CliError(`the hub could not be reached: ${e.message}`, 4) }
        const b: any = await r.json().catch(() => ({}))
        if (!r.ok) throw new CliError(b.error ?? `the hub answered ${r.status}`, r.status === 401 ? 3 : 1)
        return b
      }
      if (cmd === 'login') {
        await rest('GET', '/api/me')
        creds.profiles[profileName] = { key, hub: hubUrl, savedAt: new Date().toISOString() }
        creds.default ??= profileName
        const file = writeCredentials(creds, io.env)
        out(`logged in to organisation ${org} as profile "${profileName}" (saved in ${file})`, { ok: true, profile: profileName, org, file })
        return 0
      }
      if (cmd === 'whoami') { const me = await rest('GET', '/api/me'); out(`key           ${maskKey(key)}\norganisation  ${org}\nholds         ${(me.capabilities ?? []).join(', ')}\nhub           ${hubUrl}\nprofile       ${o.key || io.env.SACLI_KEY ? '(from --key / $SACLI_KEY)' : profileName}`, { key: maskKey(key), org, capabilities: me.capabilities, hub: hubUrl, profile: profileName }); return 0 }
      if (cmd !== 'warehouse') throw new CliError(`an organisation key works with sacli projects, keys, api and warehouse (and login, whoami) — ${cmd} needs a project's key (sacli keys create … --project <id> --save-as <profile>)`, 2)
      const table_ = pos[2]
      const need = (what: string) => { if (!table_) throw new CliError(`which table? sacli warehouse ${sub} <table>${what}`, 2); return table_ }
      const project = () => { if (!o.project) throw new CliError(`which project? --project <id>`, 2); return String(o.project) }
      if (sub === 'tables') { const r = await call({ t: 'warehouse:tables' }); out(r.configured === false ? 'the warehouse is not set up' : showTables(r.tables ?? []), r); return 0 }
      if (sub === 'query') { const sql = pos.slice(2).join(' ').trim(); if (!sql) throw new CliError('which SQL? sacli warehouse query "<sql>"', 2); const r = await call({ t: 'warehouse:query', sql, limit: o.limit ? Number(o.limit) : undefined }); out(showResult(r), r); return 0 }
      if (sub === 'explore') { const r = await call(exploreReq(pos.slice(2))); out(JSON.stringify(r, null, 2), r); return 0 }
      if (sub === 'append') { const t = need(' --rows …'); const r = await call({ t: 'warehouse:append', table: t, rows: await rowsGiven() }); out(`appended ${r.rows} rows to ${t} (snapshot ${r.snapshot})`, r); return 0 }
      if (sub === 'create') {
        const t = need(' --column <name>:<type> …')
        const columns = ((o.column ?? []) as string[]).map((c) => { const m = /^([a-z_][a-z0-9_]*):([a-z]+)(!?)$/.exec(c); if (!m) throw new CliError(`--column ${c}: write <name>:<type>, with ! when required`, 2); return { name: m[1], type: m[2], ...(m[3] ? { required: true } : {}) } })
        if (!columns.length) throw new CliError('a table needs columns: --column <name>:<type> …', 2)
        const r = await call({ t: 'warehouse:create', name: t, columns }); out(`made ${t} (${columns.map((c) => `${c.name} ${c.type}`).join(', ')})`, r); return 0
      }
      if (sub === 'load') {
        const f = pos[2]
        if (!f) throw new CliError('which file? sacli warehouse load <file.duckdb | file.csv | file.xlsx>', 2)
        const done = await loadFile(f, { table: o.table, sheet: o.sheet, tables: o.tables ? String(o.tables).split(',').map((x) => x.trim()).filter(Boolean) : undefined, replace: !!o.replace, append: !!o.append, project: o.project ? String(o.project) : undefined, batchRows: o.batch ? Number(o.batch) : undefined },
          call, (s) => io.stderr(`${s}\n`))
        const total = done.reduce((n, x) => n + x.rows, 0), secs = done.reduce((n, x) => n + x.seconds, 0)
        out([table(['table', 'from', 'rows', 'columns', 'seconds', 'rows/s', 'granted to'], done.map((x) => [x.table, x.from, x.rows.toLocaleString(), String(x.columns.length), x.seconds.toFixed(1), Math.round(x.rows / Math.max(x.seconds, 0.001)).toLocaleString(), x.granted ?? ''])),
          ...done.flatMap((x) => x.columns.filter((c) => c.was).length ? [`${x.table}: renamed ${x.columns.filter((c) => c.was).map((c) => `${c.was} → ${c.name}`).join(', ')}`] : []),
          `${total.toLocaleString()} rows in ${secs.toFixed(1)} s`].join('\n'), done)
        return 0
      }
      if (sub === 'grants') { const r = await call({ t: 'warehouse:grants', project: project() }); out(Object.keys(r.grant ?? {}).length ? table(['table', 'columns', 'write'], Object.entries(r.grant).map(([t, c]: [string, any]) => [t, c === null ? 'all' : c.join(', '), (r.writable ?? []).includes(t) ? 'yes' : ''])) : 'this project was granted nothing', r); return 0 }
      if (sub === 'grant') { const t = need(' --project <id>'); const columns = o.columns ? String(o.columns).split(',').map((c) => c.trim()).filter(Boolean) : null; const r = await call({ t: 'warehouse:grant', project: project(), table: t, columns, write: !!o.write }); if (r.error) throw new CliError(r.error); out(`project ${o.project} may read ${columns ? columns.join(', ') + ' of ' : ''}${t}${o.write ? ' and append to it' : ''}`, r); return 0 }
      if (sub === 'revoke') { const t = need(' --project <id>'); const r = await call({ t: 'warehouse:revoke', project: project(), table: t }); out(`project ${o.project} may no longer read ${t}`, r); return 0 }
      throw new CliError(`there is no 'warehouse ${sub ?? ''}' — tables, query, explore, load, append, create, grants, grant or revoke`, 2)
    }

    if (cmd === 'status') {
      const st = await daemonStatus(key, hubUrl, io.env)
      out(st ? `connected: ${st.connected ? 'yes' : 'not yet'}${st.connectedAt ? ` (since ${st.connectedAt})` : ''}\ncloses in ${Math.round(st.idleLeftMs / 60000)} min without a command\npid ${st.pid}` : 'no background connection', st ?? { running: false })
      return 0
    }
    if (cmd === 'disconnect') {
      const was = await stopDaemon(key, hubUrl, io.env)
      out(was ? 'disconnected' : 'there was no background connection', { disconnected: was })
      return 0
    }
    const direct = cmd === 'login' || o['no-daemon'] || io.env.SACLI_NO_DAEMON === '1' || !io.script
    hub = direct ? await connect({ key, hub: hubUrl, timeoutMs: Math.min(timeoutMs, 30_000), log: (s) => { if (!o.json) warn(s) } })
      : await viaDaemon({ key, hub: hubUrl, env: io.env, script: io.script!, timeoutMs })

    if (cmd === 'login') {
      creds.profiles[profileName] = { key, hub: hubUrl, savedAt: new Date().toISOString() }
      creds.default ??= profileName
      const file = writeCredentials(creds, io.env)
      out(`logged in to ${hub.project.name ?? hub.project.id} as profile "${profileName}" (saved in ${file})`, { ok: true, profile: profileName, project: hub.project, file })
      return 0
    }
    if (cmd === 'whoami') {
      out(`key      ${maskKey(key)}\nproject  ${hub.project.name ?? ''} (${hub.project.id})\nhub      ${hubUrl}\nprofile  ${o.key || io.env.SACLI_KEY ? '(from --key / $SACLI_KEY)' : profileName}\nconfig   ${configPath(io.env)}`,
        { key: maskKey(key), project: hub.project, hub: hubUrl, profile: profileName })
      return 0
    }
    const ask = async (payload: Record<string, unknown>) => {
      const r = await hub!.request(payload, { timeoutMs })
      if (r.t === 'session:refused') throw new CliError(r.reason ?? 'refused')
      return r
    }
    if (cmd === 'app') {
      if (pos[1] !== 'publish' || !pos[2]) throw new CliError('sacli app publish <app folder>', 2)
      const root = resolve(io.cwd ?? process.cwd(), pos[2])
      const owner = folderProject(root), keyProject = projectOfKey(key ?? '')
      if (owner && keyProject && owner.project !== keyProject) throw new CliError(`${pos[2]} belongs to project ${owner.project} (${owner.file}); this key is project ${keyProject}'s — use that project's key`, 1)
      const files: Record<string, string> = {}
      const walk = (dir: string, rel: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (['node_modules', 'dist', 'runs'].includes(e.name) || e.name.startsWith('.')) continue
          const r = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(join(dir, e.name), r)
          else if (/^(server|web)\//.test(r)) {
            // Text as it is; anything else (an image, a font) as base64 behind a marker, so it arrives intact.
            const bytes = readFileSync(join(dir, e.name)), text = bytes.toString('utf8')
            files[r] = Buffer.from(text, 'utf8').equals(bytes) ? text : `base64:${bytes.toString('base64')}`
          }
        }
      }
      for (const side of ['server', 'web']) { try { walk(join(root, side), side) } catch { /* a side it does not have */ } }
      if (!files['server/index.mjs']) throw new CliError(`${pos[2]} has no server/index.mjs`, 1)
      const r = await hub.request({ t: 'app:publish', files }, { timeoutMs })
      if (r.t !== 'app:published') throw new CliError(String(r.reason ?? r.error ?? r.t), 1)
      out(r.changed ? `published ${String(r.hash).slice(0, 12)} (${Object.keys(files).length} files) — the engine downloads it` : `unchanged (${String(r.hash).slice(0, 12)})`, r)
      return 0
    }
    // ── A program folder built, and a knowledge file imported: one way each, for `program build`, `graph import` and
    //    `agent push` alike.
    const checkOwner = (path: string, shown: string) => {
      const owner = folderProject(path), keyProject = projectOfKey(key ?? '')
      if (owner && keyProject && owner.project !== keyProject) throw new CliError(`${shown} belongs to project ${owner.project} (${owner.file}); this key is project ${keyProject}'s — use that project's key`, 1)
    }
    const buildFolder = async (root: string, shown: string) => {
      checkOwner(root, shown)
      const files: Record<string, string> = {}
      const walk = (dir: string, rel: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
          const r = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(join(dir, e.name), r)
          else if (/^(manifest\.json|doc\.md|(server|web)\/.+)$/.test(r)) files[r] = readFileSync(join(dir, e.name), 'utf8')
        }
      }
      try { walk(root, '') } catch (e: any) { throw new CliError(`${shown} could not be read: ${e?.message ?? e}`, 1) }
      if (!files['manifest.json']) throw new CliError(`${shown} has no manifest.json`, 1)
      const r = await hub!.request({ t: 'program:build', files }, { timeoutMs })
      if (r.t !== 'program:built') throw new CliError(`${shown}: ${String(r.reason ?? r.error ?? r.t)}`, 1)
      return r
    }
    const importKnowledge = async (file: string, shown: string) => {
      checkOwner(file, shown)
      let mod: any
      try { mod = await import(pathToFileURL(file).href) } catch (e: any) { throw new CliError(`${shown} could not be read: ${e?.message ?? e}`, 1) }
      const dir = dirname(file)
      // Each file a domain lists, by the name import reads it with: a domain's own beside it, a shared one by its path.
      const files: Record<string, string> = {}
      for (const d of (mod.domains ?? []) as { name: string; files?: string[] }[]) for (const f of d.files ?? []) {
        const at = f.includes('/') ? join(dir, f) : join(dir, d.name.replace(/\s+/g, '-').toLowerCase(), f)
        try { files[`${d.name}|${f}`] = readFileSync(at, 'utf8') } catch { throw new CliError(`domain "${d.name}" lists ${f}, which is not at ${at}`, 1) }
      }
      const r = await hub!.request({ t: 'graph:import', domains: mod.domains ?? [], settings: mod.settings ?? [], files, ...(o.reason ? { reason: o.reason } : {}) }, { timeoutMs })
      if (r.t !== 'graph:reply') throw new CliError(`${shown}: ${String(r.reason ?? r.error ?? r.t)}`, 1)
      return (r.imported ?? []) as { name: string; kind: string; hash: string; changed: boolean }[]
    }
    const builtLine = (r: any) => `${r.name} ${r.version ?? ''} → ${String(r.hash).slice(0, 12)}${r.added ? '' : ' (already kept)'}`
    if (cmd === 'program') {
      if (pos[1] !== 'build' || !pos[2]) throw new CliError('sacli program build <folder>', 2)
      const r = await buildFolder(resolve(io.cwd ?? process.cwd(), pos[2]), pos[2])
      out(builtLine(r), r)
      return 0
    }
    if (cmd === 'agent') {
      if (sub === 'init' && pos[2]) {
        const made = initAgent(resolve(io.cwd ?? process.cwd(), pos[2]), pos[2].split('/').filter(Boolean).at(-1)!)
        out(`${made.dir}\n  agent.json · knowledge/index.mts · programs/${made.name}/\nthen: sacli agent push ${pos[2]}`, made)
        return 0
      }
      if (sub === 'push' && pos[2]) {
        const dir = resolve(io.cwd ?? process.cwd(), pos[2])
        let spec: any
        try { spec = JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')) } catch (e: any) { throw new CliError(`${pos[2]}/agent.json could not be read: ${e?.message ?? e}`, 1) }
        const { name, ...body } = spec ?? {}
        if (typeof name !== 'string' || !name) throw new CliError(`${pos[2]}/agent.json names the agent ("name")`, 1)
        const lines: string[] = []
        // 1. Its domain (and any concepts it names), 2. each of its programs, 3. the agent itself — in that order, since
        //    the agent names both.
        if (existsSync(join(dir, 'knowledge', 'index.mts'))) {
          const rows = await importKnowledge(join(dir, 'knowledge', 'index.mts'), `${pos[2]}/knowledge/index.mts`)
          lines.push(`knowledge: ${rows.filter((x) => x.changed).length} of ${rows.length} changed`)
        }
        const progDir = join(dir, 'programs')
        // Libraries first: a program is built with the libraries it uses, so they must be built before it.
        const kindOf = (p: string) => { try { return JSON.parse(readFileSync(join(progDir, p, 'manifest.json'), 'utf8')).kind === 'library' ? 0 : 1 } catch { return 1 } }
        const progs = existsSync(progDir) ? readdirSync(progDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => kindOf(a) - kindOf(b) || a.localeCompare(b)) : []
        for (const p of progs) lines.push(`program ${builtLine(await buildFolder(join(progDir, p), `${pos[2]}/programs/${p}`))}`)
        const r = await hub!.request({ t: 'graph:agent', name, body, reason: o.reason ?? `pushed from ${pos[2]}` }, { timeoutMs })
        if (r.t !== 'graph:reply') throw new CliError(`the agent "${name}": ${String(r.reason ?? r.t)}`, 1)
        lines.push(`agent ${name} ${r.changed ? 'written' : 'unchanged'}`)
        out(lines.join('\n'), { agent: name, changed: r.changed })
        return 0
      }
      throw new CliError(HELP.agent, 2)
    }
    if (cmd === 'map') {
      if (!sub || sub === 'show') {
        const r = await hub.request({ t: 'graph:show', name: 'map' }, { timeoutMs })
        if (r.t !== 'graph:reply') { if (/no "map"/.test(String(r.reason))) { out('this project has no map yet — sacli map set <map.json>', { sections: [] }); return 0 } throw new CliError(String(r.reason ?? r.t), 1) }
        const sections = (r.node?.body?.sections ?? []) as { label: string; items: { agent: string; slug?: string; label?: string }[] }[]
        out(sections.map((x) => `${x.label}\n${x.items.map((i) => `  /${(i.slug ?? i.agent).padEnd(24)} ${i.agent}${i.label ? `  (${i.label})` : ''}`).join('\n')}`).join('\n\n'), r.node?.body)
        return 0
      }
      if (sub === 'set' && pos[2]) {
        let body: unknown
        try { body = JSON.parse(readFileSync(resolve(io.cwd ?? process.cwd(), pos[2]), 'utf8')) } catch (e: any) { throw new CliError(`${pos[2]} could not be read: ${e?.message ?? e}`, 1) }
        const r = await hub.request({ t: 'graph:map', body, reason: o.reason ?? 'the project\'s map' }, { timeoutMs })
        if (r.t !== 'graph:reply') throw new CliError(String(r.reason ?? r.t), 1)
        out(r.changed ? `the map is written (${String(r.hash).slice(0, 12)})` : 'the map is unchanged', r)
        return 0
      }
      throw new CliError(HELP.map, 2)
    }
    if (cmd === 'graph') {
      if (pos[1] !== 'import' || !pos[2]) throw new CliError('sacli graph import <knowledge/index.mts>', 2)
      const rows = await importKnowledge(resolve(io.cwd ?? process.cwd(), pos[2]), pos[2])
      out(rows.map((x) => `${x.changed ? 'changed  ' : 'unchanged'} ${x.kind.padEnd(7)} ${x.name}`).join('\n') + `\n${rows.filter((x) => x.changed).length} of ${rows.length} changed`, { imported: rows })
      return 0
    }
    if (cmd === 'dsi') {
      const req = async (payload: Record<string, unknown>) => { const r = await hub!.request(payload, { timeoutMs }); if (/refused/.test(String(r.t))) throw new CliError(r.reason ?? 'refused'); return r }
      const path = (p: string | undefined, need: 2 | 3) => { const parts = String(p ?? '').split('.'); if (parts.length < need - 1 || !parts[0] || (need === 3 && !parts[1])) throw new CliError(HELP.dsi, 2); return { source: parts[0], table: parts.slice(1, 2)[0], field: parts.slice(2).join('.') || undefined } }
      const jobLine = (j: any) => !j ? 'no build has run' : `${j.state === 'running' ? `running: ${j.stage ?? ''}${j.doing ? ` — ${j.doing}` : ''}` : `last build ${j.state}${j.detail ? ` — ${j.detail}` : ''}`}${j.counts?.tables ? ` · ${j.counts.tables.done ?? 0}/${j.counts.tables.total ?? 0} tables${j.counts.tables.failed ? `, ${j.counts.tables.failed} not read` : ''} · ${j.counts.fields ?? 0} fields` : ''}`
      if (!sub || sub === 'stats') {
        const r = await req({ t: 'dsi:stats' })
        out(table(['source', 'tables', 'fields', 'disabled', 'gone', 'last build'], (r.sources ?? []).map((s: any) => { const p = (s.phases ?? []).find((x: any) => x.phase === 1)
          return [s.source, String(s.tables), String(s.fields), `${s.tablesDisabled} t · ${s.fieldsDisabled} f`, String(s.tablesGone), p ? `${p.finishedAt ? 'finished' : 'unfinished'} ${p.done}/${p.planned}${p.failed ? `, ${p.failed} not read` : ''}` : 'never'] })) + (r.running ? `\n${jobLine(r.running)}` : ''), r)
        return 0
      }
      if (sub === 'show') {
        const { source, table: t } = path(pos[2], 2)
        const r = await req({ t: 'dsi:show', source, ...(t ? { table: t } : {}), ...(o['as-of'] ? { asOf: o['as-of'] } : {}) })
        const items = r.items ?? []
        const state = (i: any) => (i.gone ? 'gone' : i.enabled ? '' : 'disabled')
        const desc = (i: any) => i.descHuman || i.descSource || i.descAi || ''
        out(t ? table(['field', 'type', 'key', 'state', 'description'], items.filter((i: any) => i.field).map((i: any) => [i.field, i.type ?? '', i.key ? 'key' : '', state(i), desc(i)]))
          : table(['table', 'fields', 'rows', 'state'], items.filter((i: any) => !i.field).map((i: any) => [i.table, String(items.filter((x: any) => x.table === i.table && x.field && !x.gone).length), i.rows == null ? '' : String(i.rows), state(i)])), items)
        return 0
      }
      if (sub === 'describe') {
        const p = path(pos[2], 3), text = pos.slice(3).join(' ')
        if (o.by !== 'human' && o.by !== 'ai') throw new CliError('say who wrote it: --by human or --by ai', 2)
        const r = await req({ t: 'dsi:describe', ...p, text, by: o.by }); out(`described ${pos[2]} (as ${o.by === 'human' ? "a person's" : "an AI's"})`, r.item); return 0
      }
      if (sub === 'enable' || sub === 'disable') { const r = await req({ t: 'dsi:enable', ...path(pos[2], 3), enabled: sub === 'enable' }); out(`${sub}d ${pos[2]}`, r.item); return 0 }
      if (sub === 'build') {
        const sources = pos.slice(2)
        const tables = o.tables ? { [sources[0] ?? '']: String(o.tables).split(',').map((x) => x.trim()).filter(Boolean) } : undefined
        if (tables && sources.length !== 1) throw new CliError('--tables reads tables of one source: sacli dsi build <source> --tables a,b', 2)
        const r = await req({ t: 'dsi:build', ...(sources.length && !tables ? { sources } : {}), ...(tables ? { tables } : {}), ...(o.fresh ? { fresh: true } : {}) })
        out(r.asked ? 'asked the engine to build — sacli dsi status --watch' : `a build is already running — ${jobLine(r.running)}`, r); return 0
      }
      if (sub === 'status') {
        for (;;) {
          const r = await req({ t: 'job:list', kind: 'dsi.build' })
          const j = (r.jobs ?? [])[0]
          out(jobLine(j), j ?? null)
          if (!o.watch || !j || j.state !== 'running') return 0
          await new Promise((res) => setTimeout(res, 3000))
        }
      }
      if (sub === 'snapshot') { const { reqId: _r, ...doc } = await req({ t: 'dsi:snapshot' }); say(JSON.stringify(doc, null, 2)); return 0 }
      throw new CliError(HELP.dsi, 2)
    }
    if (cmd === 'call') {
      const t = pos[1]
      if (!t || !/^[a-z][\w-]*:[\w:-]+$/.test(t)) throw new CliError('which message? sacli call <message> [--data \'<json>\']', 2)
      let data: Record<string, unknown> = {}
      if (o.data) { try { data = JSON.parse(o.data) } catch { throw new CliError('--data is JSON', 2) } }
      const r = await hub.request({ ...data, t }, { timeoutMs })
      const { reqId: _r, ...rest } = r
      say(JSON.stringify(rest, null, 2))
      return /refused|error/.test(String(r.t)) ? 1 : 0
    }
    if (cmd === 'activity') {
      const r = await hub.request({ t: 'activity:list' }, { timeoutMs })
      const rows = (r.activities ?? []) as any[]
      out(rows.length ? table(['state', 'what', 'detail', 'updated'], rows.map((a) => [a.state, a.title, a.progress ?? a.detail ?? '', String(a.updated_at).slice(0, 19).replace('T', ' ')])) : 'nothing running or recent', rows)
      return 0
    }
    if (cmd === 'agents') {
      const r = await ask({ t: 'session:agents' })
      out(r.agents.length ? table(['id', 'name', 'scope'], r.agents.map((a: any) => [a.id, a.name, a.scope])) : 'this project has no agents yet', r.agents)
      return 0
    }
    if (cmd === 'session') {
      if (sub === 'open') {
        const agent = pos[2]
        if (!agent) throw new CliError('which agent? sacli session open <agent>', 2)
        const id = o.id ?? `ses-${crypto.randomUUID()}`
        const r = await ask({ t: 'session:open', session: id, agent })
        out(sessionView(r), r)
        return 0
      }
      const session = pos[2]
      if (!session) throw new CliError(`which session? sacli session ${sub ?? '<open|get|intent|goto>'} <session>`, 2)
      if (sub === 'get') { const r = await ask({ t: 'session:get', session, ...(o['as-of'] ? { asOf: o['as-of'] } : {}) }); out(sessionView(r), r); return 0 }
      if (sub === 'goto') {
        const block = pos[3]
        if (!block) throw new CliError('which block? sacli session goto <session> <block>', 2)
        const r = await ask({ t: 'session:goto', session, block }); out(sessionView(r), r); return 0
      }
      if (sub === 'intent') {
        const ops = [
          ...(o.set ?? []).map((x: string) => { const [path, v] = pair(x, 'set'); return { op: 'set', path, value: v } }),
          ...(o.add ?? []).map((x: string) => { const [path, v] = pair(x, 'add'); return { op: 'add', path, value: v } }),
          ...(o.remove ?? []).map((x: string) => x.includes('=') ? (([path, v]) => ({ op: 'remove', path, value: v }))(pair(x, 'remove')) : { op: 'remove', path: x }),
        ]
        const call = dotted(o.call, 'call'), act = dotted(o.act, 'act')
        const params = Object.fromEntries((o.param ?? []).map((x: string) => pair(x, 'param')))
        if (!ops.length && !call && !act) throw new CliError('an intent needs --set/--add/--remove, --call or --act', 2)
        if (o.to && o.to !== 'current' && o.to !== 'new') throw new CliError('--to is current or new', 2)
        const r = await ask({ t: 'session:intent', session, ...(ops.length ? { ops } : {}), ...(call ? { call: { package: call[0], fn: call[1], ...(Object.keys(params).length ? { params } : {}) } } : {}),
          ...(act ? { action: { package: act[0], id: act[1] } } : {}), to: o.to ?? 'current', ...(o.block ? { block: o.block } : {}) })
        out(sessionView(r), r)
        return 0
      }
      throw new CliError(`there is no 'session ${sub ?? ''}' — open, get, intent or goto`, 2)
    }
    if (cmd === 'warehouse') {
      const wh = async (payload: Record<string, unknown>) => { const r = await hub!.request(payload, { timeoutMs }); if (r.t === 'warehouse:refused' || r.t === 'error') throw new CliError(r.reason ?? 'refused'); return r }
      if (sub === 'tables') { const r = await wh({ t: 'warehouse:tables' }); out(r.configured === false ? 'the warehouse is not set up' : showTables(r.tables ?? []), r); return 0 }
      if (sub === 'query') { const sql = pos.slice(2).join(' ').trim(); if (!sql) throw new CliError('which SQL? sacli warehouse query "<sql>"', 2); const r = await wh({ t: 'warehouse:query', sql, limit: o.limit ? Number(o.limit) : undefined }); out(showResult(r), r); return 0 }
      if (sub === 'explore') { const r = await wh(exploreReq(pos.slice(2))); out(JSON.stringify(r, null, 2), r); return 0 }
      if (sub === 'append') { const t = pos[2]; if (!t) throw new CliError('which table? sacli warehouse append <table> --rows …', 2); const r = await wh({ t: 'warehouse:append', table: t, rows: await rowsGiven() }); out(`appended ${r.rows} rows to ${t} (snapshot ${r.snapshot})`, r); return 0 }
      if (['create', 'load', 'grants', 'grant', 'revoke'].includes(String(sub))) throw new CliError(`warehouse ${sub} is the organisation's: use an organisation key (sak_org_…), made in the admin console's Warehouse`, 2)
      throw new CliError(`there is no 'warehouse ${sub ?? ''}' — tables, query or append (create and grant with an organisation key)`, 2)
    }
    if (cmd === 'ask') {
      const question = pos.slice(1).join(' ').trim()
      if (!question) throw new CliError('what is the question? sacli ask "<question>"', 2)
      const sessionId = o.session ?? `ask-${crypto.randomUUID()}`
      const qid = `q-${crypto.randomUUID()}`
      // The answer comes as analyst:answer for this question; narration says what is happening meanwhile.
      const payload = { t: 'analyse', question, projectId: hub.project.id, sessionId, questionId: qid, ...(o.channel ? { channel: String(o.channel) } : {}), ...(o.graph ? { graph: String(o.graph) } : {}) }
      const onEvent = (m: any) => { if (m.t === 'narration' && !o.json && m.text) warn(String(m.text)) }
      let m: any
      if ('on' in hub) {
        const h = hub as Hub
        m = await new Promise<any>((resolve, reject) => {
          const timer = setTimeout(() => reject(new CliError(`no answer in ${Math.round(timeoutMs / 1000)}s`, 4)), timeoutMs)
          const off = h.on((x) => { if (x.qid === qid) { if (x.t === 'analyst:answer') { off(); clearTimeout(timer); resolve(x) } else onEvent(x) } })
          h.request(payload, { timeoutMs }).catch((e) => { if (!/no reply/.test(e.message)) { off(); clearTimeout(timer); reject(e) } })
        })
      } else m = await hub.request(payload, { timeoutMs, until: { t: 'analyst:answer', qid }, onEvent })
      out(`${card(m.answer)}\n\n(session ${sessionId}${m.answer?.graph ? ` · knowledge at ${m.answer.graph}` : ''})`, { session: sessionId, qid, answer: m.answer })
      return 0
    }
    throw new CliError(`there is no command "${cmd}"`, 2)
  } catch (e: any) {
    if (e instanceof CliError) { warn(e.message); return e.code }
    warn(`unexpected error: ${e?.stack ?? e}`)
    return 1
  } finally {
    if (hub && 'on' in hub) hub.close()
  }
}

export const readStdin = () => new Promise<string>((resolve) => {
  let data = ''
  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (l) => { data += l + '\n'; if (process.stdin.isTTY) rl.close() })
  rl.on('close', () => resolve(data))
})
