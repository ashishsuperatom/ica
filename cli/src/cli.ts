// sacli — the Superatom CLI. An agent (Codex, Claude, any coding agent) or a person works with Superatom through a key:
// an organisation's (sak_org_<org>_…) or a project's (sak_<project>_…), made by a person or by a key above it. A key
// holds capabilities — the names roles use — never more than its maker holds now; everything it does is checked by the
// platform the same way as for a person, and recorded in the audit history.

import { browserSignIn, emailOf } from './browser-login.ts'
import { hostname } from 'node:os'
import { parseArgs, type ParseArgsConfig } from 'node:util'
import { createInterface } from 'node:readline'
import { CliError, DEFAULT_HUB, maskKey, orgOfKey, projectOfKey, readCredentials, writeCredentials, configPath, folderProfile, folderProject, type Context } from './config.ts'
import { readFileSync, writeFileSync, readdirSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, type Hub } from './hub.ts'
import { viaDaemon, stopDaemon, daemonStatus, serveDaemon, type Conn } from './daemon.ts'
import { card, sessionView, table } from './render.ts'
import { engineCommand, realDeps } from './engine.ts'
import { loadFile } from './load.ts'
import { initAgent } from './agent-template.ts'
import { upgrade, noticeIfNewer, installedVersion, getUrl } from './upgrade.ts'
import { writeClone, cloneAt, pullInto, localChanges, markPublished, type ProjectSnapshot } from './clone.ts'
import { devPlan, envNameOf } from './dev.ts'
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = pkg.version

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
  workloads        everything the engine runs (the engine, each connection, each agent): how each stands, what happened
                   to it, what can be done to it (show, act, inspect, events)
  warehouse        the organisation's warehouse: tables, query, append — and, with an organisation key, create and grant
  publish          inside a clone: what it changes made live in one go — shown first, done on a yes
  program build    build a program from its source folder: the build and its source are kept by the platform
  program publish  make a program's build the one people and agents use (by name: its newest build)
  graph export     write the project's knowledge (its graph — the only source) into a folder, to edit
  graph import     import an edited copy (index.mts) into the graph's draft, on the platform
  clone            the project as one folder: agents, programs and libraries (their source), knowledge, the map, and
                   the platform's types and docs — what everyone sees, never data
  pull             bring a clone up to what is published (refused over local changes unless --force)
  dev              develop in a clone: what you change is built on the engine and seen only by you (list, stop, delete)
  agent            an agent as one folder — its domain, its programs, its STATE: init a new one, push it to the platform
  map              the project's map — the sections and places people see, each place an agent: show, set
  call             send any message the platform takes, with its fields as JSON (prints the reply as JSON)
  status           the background connection: up, since when, how long until it closes
  disconnect       close the background connection now (--all: every profile's)
  upgrade          move to the latest sacli, or a given version: sacli upgrade [<version>]

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
  login: `sacli login --browser [--project <name|id>] [--profile <name>]
sacli login [--key <key>] [--profile <name>] [--hub <url>]

--browser: sign in as yourself in the browser (allow sacli there) and get a key of your own for a project you are in —
it acts as you, never holds more than your role there, and expires in 90 days. The usual way for a person. The profile
is named after the project unless --profile says (never one holding another project's key).

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
  engine: `sacli engine <start|status|stop|logs|profile|versions|switch> [--project <id>]

  sacli engine start [--native] [--image <ref>] [--wait <s>]
  sacli engine start --fly [--region <code>]   on Fly, made and kept by the platform — where it allows the organisation machines there
                     runs the project's engine in Docker — container and volume sa-engine-<project>, restarted unless
                     stopped — from registry.superatom.ai: the release chosen for the project, else the newest dev; run
                     by digest, never built here. Beside it the Engine Updater (sa-engine-updater-<project>), which
                     switches the engine when another version is chosen. Again: nothing changes, or, when the image changed, the
                     container is made again on the same volume. Needs project.manage.
                     --native runs it under PM2 instead, from the project's home (~/.superatom/<project>/.env).
                     Waits until the hub has the engine (default 180 s).
  sacli engine status          where it runs on this machine, and whether the hub has it
  sacli engine profile         which harness, account and model each of the engine's agents runs (set: sacli engine
                     profile set <agent> <harness> <provider> <model> [--thinking <level>] — needs project.manage)
  sacli engine versions        which engine version the project runs, the versions there are, and the last switch
                     step by step
  sacli engine switch <tag>    switch the project's engine to a version (dev-<date>-<commit>, dev, prod): the box's
                     Engine Updater pulls it and swaps within a minute, going back if the new one does not come up. The
                     same as the admin console's Engine version page. Both need project.manage.
  sacli engine stop            stops it (the data stays: the volume, or the home)
  sacli engine stop --fly      takes it off Fly (its machine removed; the app and its volume — the data — kept)
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
  workloads: `sacli workloads                              everything the engine runs, how each stands (unknown when no engine is connected)
sacli workloads show <kind>/<id>              one: its state, what it runs, its last error, what happened to it, what can be done
sacli workloads act <kind>/<id> <action>      do something to it (restart, test, clear-cache, refresh-index …) — said, then done, recorded
sacli workloads inspect <kind>/<id> <aspect>  look into it (a connection's cache or index, an agent's session, the engine's health)
sacli workloads events [--kind <kind>] [--limit <n>]   what happened, newest first, across everything
Kinds: engine (self), connection (<name>), agent (composer, narrator, analyst, connector, grounding, runner). [--project <id>]`,
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
  program: `sacli program build <folder>
sacli program publish <name | hash>

build: a program's source — manifest.json, doc.md, server/…, web/… — built by the project's engine and kept by the
platform, the build with the source it came from, as a draft. Needs project.ask.
publish: that build becomes the one people and agents use (by name: the program's newest build). Its builder may publish
it; anyone else needs project.publish.`,
  agent: `sacli agent init <folder>            a new agent's folder from the template, named for its last part
  sacli agent push <folder | agents/<name>.json> [--reason '<why>']   its programs built, the agent written (in a
                                        clone: agents/<name>.json, its programs from programs/; else the agent's folder
                                        with its own knowledge/)

An agent is one folder: agent.json (its title, domain, programs, the agent that answers in words, tools, look, where its
STATE starts and its starting points), knowledge/index.mts (its domain — the concepts it answers from) and
programs/<name>/ (each program: manifest.json, doc.md, server/, web/). A click changes STATE through an Intent; a
question in words is answered from the domain and the programs' docs, and may change STATE the same way.
Needs project.ask; importing the domain and writing a global agent need someone who may publish.`,
  map: `sacli map [show]                      the project's map: its sections, and each place's address and agent
  sacli map set <map.json> [--reason '<why>']   write it into the draft (someone who may publish); people see it once
                                        the draft is published: sacli graph publish '<what changed>'

The map is what people see to find their way: { "sections": [{ "label", "items": [{ "agent", "slug"?, "label"?,
"icon"? }] }] }. Every place is an agent of the project; its slug (else the agent's name) is its address, /<slug>, and
is never one of the app's own (about, agents, activity, connections, profile, settings, a, c, s, w, u, dashboard,
admin, api, ws, assets, auth). An agent not on the map is found by search and on the All agents page.`,
  graph: `sacli graph export <folder> [--graph draft|<version>] [--force]
sacli graph import <folder>/index.mts [--reason '<why>']
sacli graph draft                     what is in the draft and not yet published
sacli graph publish '<what changed>'  publish the draft as the next version: what people and agents use from now on

The project's composition graph is the only source of its knowledge (the platform holds it; engines download it).
export writes it — domains, concepts, files, settings; the draft unless a version is named — into <folder> as a
working copy: index.mts and the domains' files. Edit it, check it (composition-graph check <folder>/index.mts),
import it to the draft, try it (sacli ask --graph draft "…"), publish. What is unchanged records nothing. Both need
project.publish.`,
  call: `sacli call <message> [--data '<json>']    e.g. sacli call graph:agent --data '{"name":"trips","body":{…}}'`,
  activity: `sacli activity         what is running for this key (program builds, session runs) and what ran in the last day`,
  status: `sacli status        whether the background connection for this key is up, and for how long`,
  clone: `sacli clone [<folder>]

The project as it is published — what everyone sees — written as one folder: superatom.json, AGENTS.md (how to work
here, the project's agents, programs and libraries), map.json, knowledge/, agents/<name>.json, programs/<name>/ (every
program and library, from the source each was built from), platform/ (the platform's types and docs: @superatom/ui,
@superatom/program, the program contract, a template), package.json and tsconfig — \`pnpm install && pnpm typecheck\`
checks every program. Never data: programs run on the project's engine. Needs project.publish.`,
  publish: `sacli publish '<what changed>' [--yes] [--with-draft]

Inside a clone: what it changes, made live in one go. It shows first exactly what it will do — the programs it builds and
publishes (libraries first), the knowledge it imports, the agents and the map it writes, and the knowledge version it
publishes, with any changes others already made in the draft that would go live with it — and does it only on a yes
(--yes: without asking, for scripts). A draft already holding changes this publish did not make is refused —
--with-draft publishes them too, knowingly. Your clone then counts as up to date. Needs project.publish.`,
  dev: `sacli dev [--env <name>] [--once] [--yes]  attach to your environment (made the first time, on a yes — --yes for scripts;
                                         named after the folder) and
                                         build what this clone changes — on the engine, seen only by you; watch and
                                         rebuild on every save; Ctrl-C detaches (the environment stays, to resume)
sacli dev list [--project <name>] [--all] your environments: in a clone, this project's (and a count of the rest);
                                         elsewhere one row per project; --project one project's; --all everyone's
                                         in the profile's project (for who runs it)
sacli dev stop | delete [<name>] [--project <name>] [--yes]
                                         detach (kept, to resume) / delete one — gone with its builds, asked first;
                                         --project: one in another project of this organisation

list, stop and delete work anywhere the profile reaches the project; only building needs a clone.

Only you see an environment, in sacli and in your browser; everyone else sees what is published. Left an hour without
sacli it is detached. Needs project.develop. docs/dev-mode.md.`,
  pull: `sacli pull [--force]

Inside a clone: brings it up to what is published now, platform/ too. Refused when files were changed here since the
clone (or the last pull) — they would be lost — unless --force.`,
  disconnect: `sacli disconnect [--all]    closes the background connection for this key — with --all, every saved profile's (the next command opens a new one)`,
  upgrade: `sacli upgrade [<version|channel>]

Moves this sacli to the latest version (or the one named), from get.superatom.site: downloaded, checked against the
release's sha256, and made the one in use. The previous version stays, so 'sacli upgrade <version>' goes back.
Background connections are closed, so the next command runs the new version. Works for a sacli put in place by
  curl -fsSL https://get.superatom.site/sacli/install.sh | sh
Once a day, on a terminal, sacli says when a newer version is out ($SACLI_NO_UPDATE_CHECK=1 turns that off).`,
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
  let spinning: { stop: () => void } | null = null
  // A line said while the spinner turns clears it first (the spinner draws itself again under it).
  const clearSpin = () => { if (spinning) process.stderr.write('\r\x1b[2K') }
  const warn = (s: string) => { clearSpin(); io.stderr(`sacli: ${s}\n`) }
  // Progress while a command works (builds, steps) — beside the result, never in it: stdout holds only the result.
  const note = (s: string) => { clearSpin(); io.stderr(s.endsWith('\n') ? s : s + '\n') }
  let jsonMode = false
  // A command at work, to a person at a terminal: at once, one line that updates in place — a spinner, what it is doing
  // and its current step — replaced when it ends by what it did and how long it took. On stderr, so the result stays clean.
  // An agent (no terminal) gets none of it: only the result.
  const begin = (what: string) => {
    const t0 = Date.now(), live = !!process.stderr.isTTY && !jsonMode
    if (!live) return { step: (_s: string) => {}, done: (_s?: string) => {} }
    const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    let i = 0, last = ''
    // Never wider than the terminal: a line that wraps cannot be drawn again in place.
    const draw = () => { const line = `${frames[i++ % frames.length]} ${what}${last ? ` — ${last}` : ''}`, w = Math.max(20, (process.stderr.columns || 80) - 1); process.stderr.write(`\r\x1b[2K${line.length > w ? line.slice(0, w - 1) + '…' : line}`) }
    draw()
    const timer = setInterval(draw, 100)
    const stop = () => { clearInterval(timer); process.stderr.write('\r\x1b[2K'); spinning = null }
    spinning = { stop }
    return {
      step: (s: string) => { last = s.replace(/…$/, ''); draw() },
      done: (s = 'done') => { stop(); note(`✓ ${s} in ${((Date.now() - t0) / 1000).toFixed(1)} s`) },
    }
  }

  let hub: Hub | Conn | null = null
  // Under every command that used a key: whose key, which organisation and project — for the person and for an agent.
  let footer: (() => void) | null = null
  // The project the key is for, by name when known — what a person recognises ("Procurement (2da77432…)").
  let projectLabel = ''
  try {
    // The command words come first; options may be anywhere.
    const words = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && /^--(profile|key|hub|timeout|id|as-of|set|add|remove|call|param|act|to|block|session|rows|file|limit|column|project|columns|data|can|days|save-as|connector|secret|values-file|prefix|kind|dialect|description|auth|by|tables|bridge|page|image|wait|lines|table|sheet|batch|env|thinking)$/.test(argv[i - 1])))
    const [cmd, sub] = words
    const specific: ParseArgsConfig['options'] = cmd === 'session'
      ? { id: { type: 'string' }, 'as-of': { type: 'string' }, set: { type: 'string', multiple: true }, add: { type: 'string', multiple: true }, remove: { type: 'string', multiple: true },
          call: { type: 'string' }, param: { type: 'string', multiple: true }, act: { type: 'string' }, to: { type: 'string' }, block: { type: 'string' } }
      : cmd === 'warehouse' ? { table: { type: 'string' }, sheet: { type: 'string' }, tables: { type: 'string' }, replace: { type: 'boolean' }, append: { type: 'boolean' }, batch: { type: 'string' }, rows: { type: 'string' }, file: { type: 'string' }, limit: { type: 'string' }, column: { type: 'string', multiple: true }, project: { type: 'string' }, columns: { type: 'string' }, write: { type: 'boolean' }, q: { type: 'string' }, sort: { type: 'string' }, desc: { type: 'boolean' }, page: { type: 'string' }, size: { type: 'string' }, sql: { type: 'string' } }
      : cmd === 'ask' ? { session: { type: 'string' }, channel: { type: 'string' }, graph: { type: 'string' } } : cmd === 'use' ? { here: { type: 'boolean' } } : cmd === 'call' || cmd === 'api' ? { data: { type: 'string' } } : cmd === 'projects' ? { deleted: { type: 'boolean' } }
      : cmd === 'login' ? { browser: { type: 'boolean' }, project: { type: 'string' } } : cmd === 'keys' ? { project: { type: 'string' }, can: { type: 'string' }, days: { type: 'string' }, never: { type: 'boolean' }, 'save-as': { type: 'string' } }
      : cmd === 'datasources' ? { project: { type: 'string' }, connector: { type: 'string' }, set: { type: 'string', multiple: true }, secret: { type: 'string', multiple: true }, 'values-file': { type: 'string' }, prefix: { type: 'string' }, kind: { type: 'string' }, dialect: { type: 'string' }, description: { type: 'string' }, auth: { type: 'string' }, bridge: { type: 'string' } }
      : cmd === 'engine' ? { project: { type: 'string' }, thinking: { type: 'string' }, native: { type: 'boolean' }, image: { type: 'string' }, fly: { type: 'boolean' }, region: { type: 'string' }, wait: { type: 'string' }, follow: { type: 'boolean', short: 'f' }, lines: { type: 'string' } }
      : cmd === 'workloads' ? { project: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'string' } }
      : cmd === 'storage' ? { project: { type: 'string' }, by: { type: 'string' }, kind: { type: 'string' }, page: { type: 'string' }, everything: { type: 'boolean' } }
      : cmd === 'dsi' ? { 'as-of': { type: 'string' }, by: { type: 'string' }, tables: { type: 'string' }, fresh: { type: 'boolean' }, watch: { type: 'boolean' } } : cmd === 'graph' ? { reason: { type: 'string' }, graph: { type: 'string' }, force: { type: 'boolean' } } : cmd === 'map' || cmd === 'agent' ? { reason: { type: 'string' } } : cmd === 'disconnect' ? { all: { type: 'boolean' } } : cmd === 'pull' ? { force: { type: 'boolean' } } : cmd === 'dev' ? { env: { type: 'string' }, all: { type: 'boolean' }, once: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, project: { type: 'string' } } : cmd === 'publish' ? { yes: { type: 'boolean', short: 'y' }, 'with-draft': { type: 'boolean' } } : {}
    let parsed
    try { parsed = parseArgs({ args: argv, options: { ...GLOBAL, ...specific }, allowPositionals: true, strict: true }) }
    catch (e: any) { throw new CliError(`${e.message.replace(/^Unknown option/, 'unknown option')} — see sacli ${cmd ?? ''} --help`.replace(/\s+—/, ' —'), 2) }
    const o = parsed.values as Record<string, any>
    jsonMode = !!o.json
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
    usedProfile = profileName
    const saved = creds.profiles[profileName]
    const hubUrl = o.hub ?? io.env.SACLI_HUB ?? saved?.hub ?? DEFAULT_HUB
    const out = (human: string, data: unknown) => say(o.json ? JSON.stringify(data, null, 2) : human)

    if (cmd === 'profiles') {
      const names = Object.keys(creds.profiles)
      if (!names.length) { out('no saved profiles — run sacli login', []); return 0 }
      // By NAME where the profile has seen its project (its context, kept by every command): a profile named after one
      // project and holding another's key is then plain to see, not hidden behind an id.
      const rows = names.map((n) => {
        const c = creds.profiles[n], ctx = (c as any).context, pid = projectOfKey(c.key)
        const project = pid ? (ctx?.project?.name ? `${ctx.project.name} (${pid.slice(0, 8)}…)` : pid) : `organisation ${ctx?.org?.name ?? orgOfKey(c.key)}`
        return { profile: n, project, organisation: pid ? ctx?.org?.name ?? '' : '', hub: c.hub, inUse: n === profileName, isDefault: n === creds.default }
      })
      out(table(['', 'profile', 'project', 'organisation'], rows.map((r) => [r.inUse ? '*' : '', r.profile + (r.isDefault ? ' (default)' : ''), r.project, r.organisation])) + (folder ? `\n(this folder uses "${folder.profile}" — ${folder.file})` : ''), rows)
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
    // Every saved profile's background connection, closed — after an upgrade, so none keeps running the old version.
    const stopAll = async () => { let n = 0; for (const p of Object.values(creds.profiles)) if (await stopDaemon(p.key, p.hub ?? DEFAULT_HUB, io.env).catch(() => false)) n++; return n }
    if (cmd === 'disconnect' && o.all) { const n = await stopAll(); out(`closed ${n} background connection${n === 1 ? '' : 's'}`, { disconnected: n }); return 0 }
    if (cmd === 'upgrade') {
      const ub = begin(pos[1] ? `Moving sacli to ${pos[1]}` : 'Looking for a newer sacli')
      const r = await upgrade(io.env, io.script, VERSION, pos[1]).finally(() => ub.done('checked'))
      await stopAll()
      out(r.changed ? `sacli ${r.from} → ${r.to}` : `sacli ${r.to} is the one in use already`, r)
      return 0
    }
    // Only an installed sacli is told of a newer one: only it can upgrade itself.
    if (io.isTTY && !o.json && installedVersion(io.env, io.script)) await noticeIfNewer(io.env, VERSION, warn)
    if (cmd === 'logout') {
      if (!saved) { warn(`no saved key in profile "${profileName}"`); return 1 }
      delete creds.profiles[profileName]
      if (creds.default === profileName) delete creds.default
      writeCredentials(creds, io.env)
      out(`forgot the key in profile "${profileName}"`, { ok: true, profile: profileName })
      return 0
    }

    // SIGNING IN THROUGH THE BROWSER: the person signs in as themselves, allows sacli, and gets a key of their own for
    // a project they are in — acting as them, never holding more than their role there, expiring in 90 days.
    if (cmd === 'login' && o.browser) {
      const httpBase = hubUrl.replace(/^ws/, 'http')
      let token: string
      try { token = await browserSignIn({ httpBase, say: (s) => io.stderr(s + '\n') }) } catch (e: any) { throw new CliError(e.message, 3) }
      const auth = { authorization: `Bearer ${token}` }
      const orgs = await (await fetch(`${httpBase}/api/me/projects`, { headers: auth })).json().catch(() => []) as { org: { name: string }; projects: { id: string; name: string; subdomain?: string }[] }[]
      const all = (Array.isArray(orgs) ? orgs : []).flatMap((g) => g.projects.map((p) => ({ ...p, org: g.org.name })))
      if (!all.length) throw new CliError(`${emailOf(token) || 'you'} — in no project yet: ask a project's administrator to add you`, 1)
      const want = o.project ? String(o.project).toLowerCase() : ''
      let p = want ? all.find((x) => x.id === want || x.name.toLowerCase() === want || x.subdomain === want) : all.length === 1 ? all[0] : undefined
      if (!p && !want && io.isTTY) {
        io.stderr(all.map((x, n) => `  ${n + 1}. ${x.name}  (${x.org})`).join('\n') + '\n')
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        const n = await new Promise<string>((done) => { rl.question('Which project (number)? ', done); rl.once('close', () => done('')) })
        rl.close()
        p = all[Number(n.trim()) - 1]
      }
      if (!p) throw new CliError(`which project? --project <name or id> — yours: ${all.map((x) => x.name).join(', ')}`, 2)
      // The profile: the one named, else one named after the project — never one that holds another project's key.
      const target = o.profile ? String(o.profile) : (p.subdomain || p.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'default'
      const there = creds.profiles[target]
      if (there?.key && projectOfKey(there.key) !== p.id && !o.profile) throw new CliError(`profile "${target}" holds another project's key — name one for this: sacli login --browser --project ${JSON.stringify(p.name)} --profile <name>`, 2)
      const r = await fetch(`${httpBase}/api/projects/${p.id}/my-key`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ name: `sacli on ${hostname()}` }) })
      const made = await r.json().catch(() => ({})) as { key?: string; error?: string }
      if (!r.ok || !made.key) throw new CliError(`no key was made: ${made.error ?? r.status}`, 1)
      creds.profiles[target] = { key: made.key, hub: hubUrl, savedAt: new Date().toISOString() }
      creds.default ??= target
      const file = writeCredentials(creds, io.env)
      out(`signed in as ${emailOf(token) || 'you'} — ${p.name}, profile "${target}" (a key of your own, expiring in 90 days; saved in ${file})`
        + (creds.default !== target ? `\nYour default profile is "${creds.default}": use this one with --profile ${target}, or make it the default with sacli use ${target}` : ''), { ok: true, profile: target, project: p.id, file })
      return 0
    }
    let key: string | undefined = o.key ?? io.env.SACLI_KEY
    if (cmd === 'login' && !key) {
      if (!io.stdin) throw new CliError('give the key with --key, $SACLI_KEY or on stdin', 2)
      if (io.isTTY) io.stderr('Paste the agent key, then press Enter: ')
      key = (await io.stdin()).trim()
    }
    key ??= saved?.key
    if (key && cmd !== 'login') {
      const k = key, savedOnes = !o.key && !io.env.SACLI_KEY ? saved : undefined
      let ctx = savedOnes?.context && Date.now() - Date.parse(savedOnes.context.at) < 86_400_000 ? savedOnes.context : undefined
      const label = () => { const p = ctx?.project; projectLabel = p?.name ? `"${p.name}" (${String(p.id).slice(0, 8)}…)` : `project ${String(projectOfKey(k) ?? '').slice(0, 8)}…` }
      footer = () => {
        const show = { profile: savedOnes ? profileName : (o.key ? '--key' : '$SACLI_KEY'), email: ctx?.email ?? null, organisation: ctx?.org ?? null, project: ctx?.project ?? (projectOfKey(k) ? { id: projectOfKey(k), name: null } : null) }
        if (o.json) { io.stderr(JSON.stringify({ context: show }) + '\n'); return }
        const line = ['— profile ' + show.profile, show.project ? `${show.project.name ?? 'project'} (${String(show.project.id).slice(0, 8)}…)` : null,
          show.organisation ? `organisation ${show.organisation.name ?? String(show.organisation.id).slice(0, 8) + '…'}` : null, show.email ? `as ${show.email}` : null].filter(Boolean).join(' · ')
        io.stderr((process.stderr.isTTY ? `\x1b[2m${line}\x1b[0m` : line) + '\n')
      }
      if (!ctx) {
        try {
          const r = await fetch(`${hubUrl.replace(/^ws/, 'http')}/api/me/context`, { headers: { authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(5000) })
          if (r.ok) {
            const c = await r.json() as Omit<Context, 'at'>
            ctx = { ...c, at: new Date().toISOString() }
            if (savedOnes) { creds.profiles[profileName] = { ...savedOnes, context: ctx }; writeCredentials(creds, io.env) }
          }
        } catch { /* said without it: the profile and the key's project */ }
      }
      label()
    }
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
      return await engineCommand(sub, pid, { ...o, ...(sub === 'switch' && pos[2] ? { tag: String(pos[2]) } : {}), args: pos.slice(2).map(String) }, realDeps({ key: key!, rest, say: out, note: (s) => io.stderr(`${s}\n`), env: io.env, repo: repo && existsSync(join(repo, 'Dockerfile')) ? repo : null }))
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
    if (cmd === 'workloads') {
      const pid = String(o.project ?? projectOfKey(key) ?? '')
      if (!pid) throw new CliError('which project? --project <id> (an organisation key works on any of its projects)', 2)
      const base = `/api/projects/${pid}/workloads`
      const when = (ms: number) => { if (!ms) return '—'; const m = Math.round((Date.now() - ms) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` }
      const target = (s?: string) => { const m = /^([a-z]+)\/(.+)$/.exec(String(s ?? '')); if (!m) throw new CliError('which workload? <kind>/<id> — e.g. connection/F5NETSUITE, agent/composer, engine/self (sacli workloads lists them)', 2); return { kind: m[1], id: m[2], path: `${base}/${m[1]}/${encodeURIComponent(m[2])}` } }
      const state = (w: any) => w.state === 'unknown' ? `unknown (last: ${w.reported})` : w.state
      if (!sub || sub === 'list') {
        const r = await rest('GET', base)
        out((r.online ? '' : 'no engine is connected — what each last said is shown as unknown\n') + table(['workload', 'state', 'runs', 'since', 'note'], r.workloads.map((w: any) => [`${w.kind}/${w.id}`, state(w), w.version ?? '—', when(w.since),
          [w.error?.what, w.taken === false && w.reportedAt ? 'changed — not yet taken' : '', w.newer ? `newer version ${w.newer} (act … update)` : '', w.restarts ? `${w.restarts} restart${w.restarts === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')])), r)
        return 0
      }
      if (sub === 'show') {
        const t = target(pos[2]); const r = await rest('GET', t.path); const w = r.workload
        out([`${t.kind}/${t.id}  ${state(w)}${w.since ? ` since ${new Date(w.since).toISOString().slice(0, 16).replace('T', ' ')}` : ''}`,
          `runs         ${w.version ?? '—'}${w.taken === false && w.reportedAt ? '  (changed — not yet taken)' : ''}${w.newer ? `  (its connector has a newer version, ${w.newer}: workloads act ${t.kind}/${t.id} update)` : ''}`,
          ...(w.error ? [`error        ${w.error.what}${w.error.detail ? `\n             ${w.error.detail}` : ''}`] : []),
          ...(w.restarts ? [`restarts     ${w.restarts}`] : []),
          ...(w.health ? [`health       ${Object.entries(w.health).map(([k, v]) => `${k} ${v}`).join(' · ')}`] : []),
          `can do       ${Object.keys(r.actions ?? {}).join(', ') || '—'}`, `can look at  ${Object.keys(r.aspects ?? {}).join(', ') || '—'}`,
          'happened', ...(r.events ?? []).slice(0, 15).map((e: any) => `  ${new Date(e.at).toISOString().slice(5, 16).replace('T', ' ')}  ${e.what}${e.by ? `  (${e.by})` : ''}`)].join('\n'), r)
        return 0
      }
      if (sub === 'act') {
        const t = target(pos[2]); const action = String(pos[3] ?? '')
        if (!action) throw new CliError('which action? sacli workloads act <kind>/<id> <action> — sacli workloads show <kind>/<id> lists them', 2)
        const r = await rest('POST', `${t.path}/act`, { action })
        if (r?.error) throw new CliError(r.error, 1)
        out(`${t.kind}/${t.id}: ${action} — ${r.note ?? 'done'}`, r); return 0
      }
      if (sub === 'inspect') {
        const t = target(pos[2]); const aspect = String(pos[3] ?? '')
        if (!aspect) throw new CliError('which aspect? sacli workloads inspect <kind>/<id> <aspect> — sacli workloads show <kind>/<id> lists them', 2)
        const r = await rest('GET', `${t.path}/inspect/${encodeURIComponent(aspect)}`)
        if (r?.error) throw new CliError(r.error, 1)
        out(JSON.stringify(r.data, null, 2), r); return 0
      }
      if (sub === 'events') {
        const q = new URLSearchParams({ ...(o.kind ? { kind: String(o.kind) } : {}), ...(o.limit ? { limit: String(o.limit) } : {}) })
        const r = await rest('GET', `${base}/events${q.size ? `?${q}` : ''}`)
        out(table(['when', 'workload', 'what', 'by'], (r.events ?? []).map((e: any) => [new Date(e.at).toISOString().slice(5, 16).replace('T', ' '), `${e.kind}/${e.id}`, e.what, e.by ?? ''])), r); return 0
      }
      throw new CliError(HELP.workloads, 2)
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
        `runnable     ${c.runnable ? 'yes' : 'no'}${c.state && c.state !== 'ready' ? ` (${c.state})` : ''}`, ...(c.note ? [`note         ${c.note}`] : []), ...(c.description ? [`description  ${c.description}`] : []), `settings     ${JSON.stringify(c.settings)}`].join('\n')
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
    // ── A program folder built, and a knowledge file imported: one way each, for `program build`, `graph import` and
    //    `agent push` alike.
    const checkOwner = (path: string, shown: string) => {
      const owner = folderProject(path), keyProject = projectOfKey(key ?? '')
      if (owner && keyProject && owner.project !== keyProject) throw new CliError(`${shown} belongs to project ${owner.project} (${owner.file}); this key is project ${keyProject}'s — use that project's key`, 1)
    }
    const buildFolder = async (root: string, shown: string, env?: string) => {
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
      const r = await hub!.request({ t: 'program:build', files, ...(env ? { env } : {}) }, { timeoutMs })
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
      // Concepts written on their own (an export writes every concept so, by name).
      const concepts = Array.isArray(mod.concepts) ? mod.concepts : Object.values(mod.concepts ?? {})
      const r = await hub!.request({ t: 'graph:import', domains: mod.domains ?? [], settings: mod.settings ?? [], concepts, files, ...(o.reason ? { reason: o.reason } : {}) }, { timeoutMs })
      if (r.t !== 'graph:reply') throw new CliError(`${shown}: ${String(r.reason ?? r.error ?? r.t)}`, 1)
      return (r.imported ?? []) as { name: string; kind: string; hash: string; changed: boolean }[]
    }
    const builtLine = (r: any) => `${r.name} ${r.version ?? ''} → ${String(r.hash).slice(0, 12)}${r.added ? '' : ' (already kept)'}`
    if (cmd === 'program') {
      // PUBLISH: people and agents use the newest published build of a program from then on. By name: its newest build.
      if (pos[1] === 'publish' && pos[2]) {
        const want = String(pos[2])
        const l = await hub!.request({ t: 'program:list', ...(/^[0-9a-f]{8,64}$/.test(want) ? {} : { name: want }) }, { timeoutMs })
        if (l.t !== 'program:list') throw new CliError(String(l.reason ?? l.t), 1)
        const all = (l.programs ?? []) as { hash: string; name: string; version: number; published_at?: string | null }[]
        const pick = /^[0-9a-f]{8,64}$/.test(want) ? all.find((x) => x.hash.startsWith(want)) : [...all].sort((a, b) => b.version - a.version)[0]
        if (!pick) throw new CliError(`there is no program ${want}`, 1)
        if (pick.published_at) { out(`${pick.name} v${pick.version} (${pick.hash.slice(0, 12)}) is published already`, pick); return 0 }
        const r = await hub!.request({ t: 'program:publish', hash: pick.hash }, { timeoutMs })
        if (r.t !== 'program:published') throw new CliError(String(r.reason ?? r.t), 1)
        out(`published ${pick.name} v${pick.version} (${pick.hash.slice(0, 12)}): people and agents use it from now on`, r.program)
        return 0
      }
      if (pos[1] !== 'build' || !pos[2]) throw new CliError('sacli program build <folder> | sacli program publish <name | hash>', 2)
      const b = begin(`Building ${pos[2]} on the project's engine`)
      const r = await buildFolder(resolve(io.cwd ?? process.cwd(), pos[2]), pos[2])
      b.done('built')
      out(builtLine(r), r)
      return 0
    }
    if (cmd === 'dev') {
      // Seeing, detaching and deleting environments needs only the project (the profile); building needs a clone.
      const here = cloneAt(io.cwd ?? process.cwd())
      const ask = async (msg: Record<string, unknown>) => { const r = await hub!.request(msg, { timeoutMs }); if (r.t === 'dev:refused') throw new CliError(String(r.reason), 1); return r }
      // Your environments, from your own index across this organisation's projects (each project reports its part).
      const mine = async () => ((await rest('GET', '/api/me/dev-envs')).envs ?? []) as { project: string; project_name: string; id: string; name: string; status: string; names: string[]; last_used: string }[]
      const ago = (t: string) => { const m = Math.round((Date.now() - Date.parse(t)) / 60_000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` }
      const projectOf = (all: Awaited<ReturnType<typeof mine>>, want: string) => all.find((e) => e.project === want || e.project_name.toLowerCase() === want.toLowerCase())?.project
      if (sub === 'list') {
        // Everyone's in this project (who runs it): asked of the project itself.
        if (o.all) {
          const r = await ask({ t: 'dev:list', all: true })
          out(r.envs.length ? table(['name', 'owner', 'status', 'changes', 'last used'], r.envs.map((e: any) => [e.name, e.owner, e.status, e.names.join(', ') || '—', ago(e.last_used)])) : 'no environments', r.envs)
          return 0
        }
        const all = await mine()
        const one = o.project ? projectOf(all, String(o.project)) ?? String(o.project) : here?.record.project
        if (one) {
          // One project in full (this clone's, or the one named) — and only a count of the rest.
          const these = all.filter((e) => e.project === one), rest_ = all.filter((e) => e.project !== one)
          const others = new Set(rest_.map((e) => e.project)).size
          out((these.length ? table(['name', 'status', 'changes', 'last used'], these.map((e) => [e.name, e.status === 'attached' ? 'attached — you see it' : e.status, e.names.join(', ') || '—', ago(e.last_used)])) : `no environments in ${here && !o.project ? 'this project' : String(o.project)}`)
            + (rest_.length ? `\n\nYou also have ${rest_.length} environment${rest_.length === 1 ? '' : 's'} in ${others} other project${others === 1 ? '' : 's'} — sacli dev list (outside a clone) or --project <name>` : ''), these)
          return 0
        }
        // Everywhere: one row per project, most recent first — never every environment at once.
        const byProject = [...new Set(all.map((e) => e.project))].map((p) => { const es = all.filter((e) => e.project === p); return { project: p, name: es[0].project_name || p.slice(0, 8), count: es.length, attached: es.find((e) => e.status === 'attached')?.name ?? null, last: es.map((e) => e.last_used).sort().at(-1)! } }).sort((a, b) => b.last.localeCompare(a.last))
        const shown = byProject.slice(0, 20)
        out(shown.length ? table(['project', 'environments', 'attached', 'last used'], shown.map((p) => [p.name, String(p.count), p.attached ?? '—', ago(p.last)])) + (byProject.length > 20 ? `\n… and ${byProject.length - 20} more projects` : '') + '\n\nsacli dev list --project <name> shows one project\'s' : 'no environments', byProject)
        return 0
      }
      if ((sub === 'delete' || sub === 'stop') && !o.env && !pos[2] && !here) throw new CliError(`which environment? sacli dev ${sub} <name> (sacli dev list shows them)`, 2)
      // Deleting one in another project (named with --project): through your own index, by that project.
      if (sub === 'delete' && o.project && (!here || projectOf(await mine(), String(o.project)) !== here.record.project)) {
        const all = await mine(), p = projectOf(all, String(o.project))
        const e = all.find((x) => x.project === p && x.name === String(o.env ?? pos[2] ?? ''))
        if (!p || !e) throw new CliError(`you have no environment ${String(o.env ?? pos[2] ?? '')} in ${String(o.project)} (sacli dev list --project ${String(o.project)})`, 1)
        if (!o.yes) {
          if (!io.isTTY) throw new CliError('nothing deleted: confirm with --yes (there is no terminal to ask in)', 2)
          const rl = createInterface({ input: process.stdin, output: process.stderr })
          const answer = await new Promise<string>((done) => { rl.once('close', () => done('')); rl.question(`Delete environment "${e.name}" in ${e.project_name || p} and its builds? It cannot be undone. [y/N] `, (x) => { done(x); rl.close() }) })
          if (!/^y(es)?$/i.test(answer.trim())) { out('nothing deleted', { deleted: null }); return 0 }
        }
        await rest('DELETE', `/api/me/dev-envs/${p}/${e.id}`)
        out(`deleted ${e.name} in ${e.project_name || p} — its builds are removed from the engine`, { deleted: e.id, project: p }); return 0
      }
      if (!sub && !here) throw new CliError('sacli dev builds what a clone changes (superatom.json here or above) — sacli clone first; sacli dev list, stop <name> and delete <name> work anywhere', 2)
      const envName = String(o.env ?? pos[2] ?? envNameOf(here!.dir))
      const found = (await ask({ t: 'dev:list' })).envs.find((e: any) => e.name === envName)
      if (sub === 'delete') {
        if (!found) throw new CliError(`there is no environment ${envName}`, 1)
        // Deleting cannot be undone: the environment and its builds go (stop keeps it). Asked first; --yes for scripts.
        if (!o.yes) {
          if (!io.isTTY) throw new CliError(`nothing deleted: confirm with --yes (there is no terminal to ask in)`, 2)
          const rl = createInterface({ input: process.stdin, output: process.stderr })
          const answer = await new Promise<string>((done) => { rl.once('close', () => done('')); rl.question(`Delete environment "${envName}" and its builds? It cannot be undone — your clone's files stay. [y/N] `, (x) => { done(x); rl.close() }) })
          if (!/^y(es)?$/i.test(answer.trim())) { out('nothing deleted', { deleted: null }); return 0 }
        }
        await ask({ t: 'dev:delete', env: found.id }); out(`deleted ${envName} — its builds are removed from the engine`, { deleted: found.id }); return 0
      }
      if (sub === 'stop') { if (!found) { out(`there is no environment ${envName} — nothing to detach`, { detached: null }); return 0 } await ask({ t: 'dev:detach', env: found.id }); out(`detached ${envName} — you see what is published again`, { detached: found.id }); return 0 }
      if (sub) throw new CliError(HELP.dev, 2)
      // Nothing can be built or seen without the project's engine: said before anything is made (an engine on Fly asleep
      // wakes on its own — that one is fine).
      const st = await rest('GET', `/api/projects/${here!.record.project}/status`).catch(() => null) as any
      if (st && st.provider !== 'fly' && !(st.connections ?? []).some((c: any) => c.type === 'code-engine'))
        throw new CliError(`${projectLabel || 'this project'}'s engine is not connected — nothing can be built or seen in an environment. Start it (sacli engine start, where it runs) or develop in a project whose engine runs`, 1)
      // A new environment is made only on a yes: it is seen as shown here, its name and project, before anything is made.
      if (!found && !o.yes) {
        const project = projectLabel || `project ${here!.record.project.slice(0, 8)}…`
        if (!io.isTTY) throw new CliError(`no environment "${envName}" yet — start one with --yes (there is no terminal to ask in)`, 2)
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        const answer = await new Promise<string>((done) => { rl.once('close', () => done('')); rl.question(`Start a development environment "${envName}" on ${project}? Only you will see it. [y/N] `, (x) => { done(x); rl.close() }) })
        if (!/^y(es)?$/i.test(answer.trim())) { out('nothing started', { started: false }); return 0 }
      }
      const env = found ?? (await ask({ t: 'dev:create', name: envName })).env
      note(`environment ${envName} on ${projectLabel || here!.record.project.slice(0, 8) + '…'} — only you see it; everyone else sees what is published`)
      // Attached first (a build goes only into an environment one is attached to), then what the folder changes.
      await ask({ t: 'dev:attach', env: env.id, overrides: {} })
      const builds: Record<string, string> = {}
      const sync = async () => {
        const plan = devPlan(here!.dir, here!.record)
        for (const p of plan.programs) {
          const t0 = Date.now()
          try { const r = await buildFolder(join(here!.dir, 'programs', p), `programs/${p}`, env.id); builds[p] = r.hash; note(`  ${p.padEnd(24)} built on the engine in ${((Date.now() - t0) / 1000).toFixed(1)} s ✓`) }
          catch (e: any) { warn(`${p}: ${e.message}`) }
        }
        for (const p of Object.keys(builds)) if (!plan.programs.includes(p)) delete builds[p]   // changed back: published again
        await ask({ t: 'dev:attach', env: env.id, overrides: { programs: builds, agents: plan.agents, ...(plan.map !== undefined ? { map: plan.map } : {}) } })
        const n = Object.keys(builds).length + Object.keys(plan.agents).length + (plan.map !== undefined ? 1 : 0)
        note(n ? `  live for you: ${[...Object.keys(builds), ...Object.keys(plan.agents).map((a) => `agent ${a}`), ...(plan.map !== undefined ? ['map'] : [])].join(', ')}` : '  nothing changed yet — edit programs/, agents/ or map.json')
      }
      await sync()
      if (o.once) { await ask({ t: 'dev:detach', env: env.id }); return 0 }
      note('  watching programs/, agents/, map.json · Ctrl-C ends it (the environment stays, to resume)')
      const { watch } = await import('node:fs')
      let timer: ReturnType<typeof setTimeout> | null = null, running = false, again = false
      const kick = () => { if (timer) clearTimeout(timer); timer = setTimeout(async () => { if (running) { again = true; return } running = true; try { await sync() } catch (e: any) { warn(e.message) } running = false; if (again) { again = false; kick() } }, 300) }
      const watcher = watch(here!.dir, { recursive: true }, (_e, f) => { const rel = String(f ?? ''); if (/^(programs\/|agents\/|map\.json)/.test(rel) && !/node_modules/.test(rel)) kick() })
      const ping = setInterval(() => { void ask({ t: 'dev:ping', env: env.id }).catch(() => {}) }, 5 * 60_000)
      await new Promise<void>((done) => process.once('SIGINT', () => done()))
      watcher.close(); clearInterval(ping)
      await ask({ t: 'dev:detach', env: env.id }).catch(() => {})
      note(`\ndetached ${envName} — you see what is published again; sacli dev resumes it`)
      return 0
    }
    // PUBLISH: what a clone changes, made live in one go — shown first, done only on a yes. Programs (libraries first)
    // built and published; knowledge imported, agents and the map written into the draft; then the draft published as
    // the next knowledge version — which carries whatever else the draft already holds, so that is shown too.
    if (cmd === 'publish') {
      const here = cloneAt(io.cwd ?? process.cwd())
      if (!here) throw new CliError('sacli publish works inside a clone (superatom.json here or above) — sacli clone first', 2)
      const message = pos.slice(1).join(' ').trim()
      if (!message) throw new CliError("say what it changes, for the history: sacli publish '<what changed>'", 2)
      const plan = devPlan(here.dir, here.record)
      const ch = localChanges(here.dir, here.record)
      const knowledge = [...ch.edited, ...ch.added, ...ch.removed].some((f) => f.startsWith('knowledge/'))
      const isLib = (p: string) => { try { return JSON.parse(readFileSync(join(here.dir, 'programs', p, 'manifest.json'), 'utf8')).kind === 'library' } catch { return false } }
      const v = await hub.request({ t: 'graph:versions' }, { timeoutMs })
      if (v.t !== 'graph:reply') throw new CliError(String(v.reason ?? v.t), 1)
      const pending = (v.since ?? []) as { name: string; kind: string; by: string; reason?: string; removed?: boolean }[]
      const writes = knowledge || Object.keys(plan.agents).length > 0 || plan.map !== undefined
      if (!plan.programs.length && !writes && !pending.length) { out('nothing to publish: this clone has no changes against what is published', { nothing: true }); return 0 }
      const lines = [`sacli publish — project ${here.record.project}: "${message}"`, '']
      for (const p of plan.programs) lines.push(`  build and publish   programs/${p}${isLib(p) ? '  (a library)' : ''}`)
      if (knowledge) lines.push('  import              knowledge/index.mts (into the draft)')
      for (const a of Object.keys(plan.agents)) lines.push(`  write               agent ${a} (into the draft)`)
      if (plan.map !== undefined) lines.push('  write               the map (into the draft)')
      if (writes || pending.length) {
        lines.push(`  then publish        the draft as the next knowledge version (published now: ${v.published ?? 'none'})`)
        if (pending.length) lines.push(`                      — it already holds ${pending.length} change${pending.length === 1 ? '' : 's'} made before this, which go live with it:`, ...pending.slice(0, 20).map((c) => `                        ${c.removed ? 'removed ' : ''}${c.kind} ${c.name} — ${c.by}${c.reason ? `: ${c.reason}` : ''}`), ...(pending.length > 20 ? [`                        … and ${pending.length - 20} more`] : []))
      }
      if (ch.removed.some((f) => /^(programs|agents)\//.test(f))) lines.push('', `  not done: removing ${ch.removed.filter((f) => /^(programs|agents)\//.test(f)).join(', ')} (a program or agent is retired from the console)`)
      note(lines.join('\n'))
      // Never someone else's work by accident: a draft already holding changes this publish did not make is refused,
      // unless they are to go live with it knowingly.
      if (pending.length && !o['with-draft']) throw new CliError(`nothing published: the draft already holds ${pending.length} change${pending.length === 1 ? '' : 's'} made before this (listed above). Publish them on purpose with --with-draft, or ask who made them to publish or drop them first`, 1)
      if (!o.yes) {
        if (!io.isTTY) throw new CliError('nothing published: confirm with --yes (there is no terminal to ask in)', 2)
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        // An input that ends without an answer is a no.
        const answer = await new Promise<string>((done) => { rl.once('close', () => done('')); rl.question('\nPublish all of this? [y/N] ', (a) => { done(a); rl.close() }) })
        if (!/^y(es)?$/i.test(answer.trim())) { out('nothing published', { published: false }); return 0 }
      }
      const programs: Record<string, { hash: string; version: number }> = {}
      const did: string[] = []   // what was done, said once at the end (a person also saw it go by)
      const pb = begin('Publishing')
      for (const p of plan.programs) {
        pb.step(`building and publishing ${p}…`)
        const b = await buildFolder(join(here.dir, 'programs', p), `programs/${p}`)
        const r = await hub.request({ t: 'program:publish', hash: b.hash }, { timeoutMs })
        if (r.t !== 'program:published') throw new CliError(`programs/${p} was built (${String(b.hash).slice(0, 12)}) but not published: ${String(r.reason ?? r.t)}`, 1)
        programs[p] = { hash: b.hash, version: Number(b.version ?? 1) }
        did.push(`${p} published (${String(b.hash).slice(0, 12)})`)
      }
      if (knowledge) { pb.step('importing knowledge…'); const rows = await importKnowledge(join(here.dir, 'knowledge', 'index.mts'), 'knowledge/index.mts'); did.push(`knowledge imported: ${rows.filter((x) => x.changed).length} changed`) }
      for (const [name, body] of Object.entries(plan.agents)) {
        const r = await hub.request({ t: 'graph:agent', name, body, reason: message }, { timeoutMs })
        if (r.t !== 'graph:reply') throw new CliError(`the agent "${name}": ${String(r.reason ?? r.t)}`, 1)
        did.push(`agent ${name} written`)
      }
      if (plan.map !== undefined) {
        const r = await hub.request({ t: 'graph:map', body: plan.map, reason: message }, { timeoutMs })
        if (r.t !== 'graph:reply') throw new CliError(`the map: ${String(r.reason ?? r.t)}`, 1)
        did.push('map written')
      }
      let version: string | null = null
      if (writes || pending.length) {
        pb.step('publishing the knowledge version…')
        const r = await hub.request({ t: 'graph:version', message }, { timeoutMs })
        if (r.t !== 'graph:reply') throw new CliError(`everything is in the draft, but it was not published: ${String(r.reason ?? r.t)} — sacli graph publish '${message}'`, 1)
        version = r.version?.name ?? null
      }
      markPublished(here.dir, here.record, programs)
      pb.done('published')
      out([...did.map((d) => `  ✓ ${d}`), `published${version ? ` — knowledge ${version}` : ''}: people and agents use it from now on`].join('\n'), { programs, version, did })
      return 0
    }
    if (cmd === 'clone' || cmd === 'pull') {
      const snapshot = async (step: (s: string) => void): Promise<ProjectSnapshot> => {
        // The published version by its name (before any is published, the graph as it is).
        step('reading the published knowledge, agents and map…')
        const v = await hub!.request({ t: 'graph:versions' }, { timeoutMs })
        if (v.t !== 'graph:reply') throw new CliError(String(v.reason ?? v.t), 1)
        const g = await hub!.request({ t: 'graph:export', graph: v.published ?? 'draft' }, { timeoutMs })
        if (g.t !== 'graph:reply') throw new CliError(String(g.reason ?? g.t), 1)
        const listed = await hub!.request({ t: 'program:list', published: true }, { timeoutMs })
        if (listed.t !== 'program:list') throw new CliError(String(listed.reason ?? listed.t), 1)
        const newest = new Map<string, any>()
        for (const p of listed.programs ?? []) { const n = newest.get(p.name); if (!n || p.uploaded_at > n.uploaded_at) newest.set(p.name, p) }
        const programs: ProjectSnapshot['programs'] = []
        const queue = [...newest.values()], total = queue.length
        step(`reading ${total} program${total === 1 ? '' : 's'}' sources…`)
        await Promise.all(Array.from({ length: 4 }, async () => { for (let p; (p = queue.shift());) {
          const s = await hub!.request({ t: 'program:source', hash: p.hash }, { timeoutMs })
          if (s.t !== 'program:source') throw new CliError(`the program "${p.name}": ${String(s.reason ?? s.t)}`, 1)
          let kind: 'program' | 'library' = 'program'; try { if (JSON.parse(s.files?.['manifest.json'] ?? '{}').kind === 'library') kind = 'library' } catch { /* a program */ }
          programs.push({ name: p.name, hash: p.hash, version: Number(p.version), kind, files: s.files ?? null })
          step(`reading ${total} program${total === 1 ? '' : 's'}' sources (${programs.length} of ${total})`)
        } }))
        programs.sort((a, b) => a.name.localeCompare(b.name))
        step('fetching the platform\'s types and docs (platform/)…')
        const sdkRes = await fetch(`${getUrl(io.env)}/sdk/latest/sdk.json`, { signal: AbortSignal.timeout(30_000) }).catch(() => null)
        const sdk = sdkRes?.ok ? await sdkRes.json() as { version: string; files: Record<string, string> } : null
        if (!sdk) warn('the platform SDK (platform/) is not published yet — the project is cloned without it')
        return { project: projectOfKey(key!) ?? '', graph: String(g.graph), knowledge: { source: String(g.source), files: g.files ?? {} }, agents: g.agents ?? [], map: g.map ?? null, programs, sdk }
      }
      if (cmd === 'clone') {
        const dir = resolve(io.cwd ?? process.cwd(), pos[1] ?? `superatom-${(projectOfKey(key!) ?? 'project').slice(0, 8)}`)
        const b = begin(`Cloning into ${pos[1] ?? relative(io.cwd ?? process.cwd(), dir)}`)
        const s = await snapshot(b.step)
        b.step('writing the files…')
        const r = writeClone(dir, s, hubUrl)
        b.done('cloned')
        out([`${dir}`, `  the published version (${s.graph}): ${s.agents.length} agents, ${s.programs.filter((p) => p.kind === 'program').length} programs, ${s.programs.filter((p) => p.kind === 'library').length} libraries${s.sdk ? `, platform SDK ${s.sdk.version}` : ''}`,
          ...s.programs.filter((p) => !p.files).map((p) => `  ${p.name}: built before sources were kept — compiled only, not written`),
          'read AGENTS.md · pnpm install && pnpm typecheck'].join('\n'), r)
        return 0
      }
      const here = cloneAt(io.cwd ?? process.cwd())
      if (!here) throw new CliError('this folder is not a clone (no superatom.json here or above) — sacli clone first', 2)
      if (here.record.project !== projectOfKey(key!)) throw new CliError(`this clone is project ${here.record.project}, the key in use is for ${projectOfKey(key!)} — use that project's profile`, 2)
      const b = begin('Bringing this clone up to the published version')
      const snap = await snapshot(b.step)
      b.step('comparing with your files…')
      const { record, changed } = pullInto(here.dir, here.record, snap, !!o.force)
      b.done('pulled')
      out(changed.length ? `${changed.length} file${changed.length === 1 ? '' : 's'} brought up to the published version (${record.graph}):\n${changed.slice(0, 20).map((c) => `  ${c}`).join('\n')}${changed.length > 20 ? '\n  …' : ''}` : `up to date with the published version (${record.graph})`, { changed, graph: record.graph })
      return 0
    }
    if (cmd === 'agent') {
      if (sub === 'init' && pos[2]) {
        const made = initAgent(resolve(io.cwd ?? process.cwd(), pos[2]), pos[2].split('/').filter(Boolean).at(-1)!)
        out(`${made.dir}\n  agent.json · knowledge/index.mts · programs/${made.name}/\nthen: sacli agent push ${pos[2]}`, made)
        return 0
      }
      if (sub === 'push' && pos[2]) {
        // An agent's own folder (agent.json, knowledge/, programs/), or — in a clone — agents/<name>.json, whose programs
        // (and the libraries they use) are the clone's programs/<name>/.
        const given = resolve(io.cwd ?? process.cwd(), pos[2])
        const inClone = given.endsWith('.json')
        const dir = inClone ? dirname(dirname(given)) : given
        const specFile = inClone ? given : join(dir, 'agent.json')
        let spec: any
        try { spec = JSON.parse(readFileSync(specFile, 'utf8')) } catch (e: any) { throw new CliError(`${pos[2]}${inClone ? '' : '/agent.json'} could not be read: ${e?.message ?? e}`, 1) }
        const { name, ...body } = spec ?? {}
        if (typeof name !== 'string' || !name) throw new CliError(`${pos[2]}${inClone ? '' : '/agent.json'} names the agent ("name")`, 1)
        const lines: string[] = []
        // 1. Its domain (and any concepts it names), 2. each of its programs, 3. the agent itself — in that order, since
        //    the agent names both. (A clone's knowledge is the whole project's: `sacli graph import knowledge/index.mts`.)
        if (!inClone && existsSync(join(dir, 'knowledge', 'index.mts'))) {
          const rows = await importKnowledge(join(dir, 'knowledge', 'index.mts'), `${pos[2]}/knowledge/index.mts`)
          lines.push(`knowledge: ${rows.filter((x) => x.changed).length} of ${rows.length} changed`)
        }
        const progDir = join(dir, 'programs')
        // Libraries first: a program is built with the libraries it uses, so they must be built before it.
        const manifestOf = (p: string) => { try { return JSON.parse(readFileSync(join(progDir, p, 'manifest.json'), 'utf8')) } catch { return {} } }
        const kindOf = (p: string) => manifestOf(p).kind === 'library' ? 0 : 1
        const named = (): string[] => {
          const out = new Set<string>(), todo = [...((body.programs as string[] | undefined) ?? [])]
          for (let p; (p = todo.shift());) { if (out.has(p) || !existsSync(join(progDir, p))) continue; out.add(p); for (const u of manifestOf(p).uses ?? []) if (typeof u === 'string') todo.push(u.split('@')[0]) }
          return [...out]
        }
        const progs = (inClone ? named() : existsSync(progDir) ? readdirSync(progDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []).sort((a, b) => kindOf(a) - kindOf(b) || a.localeCompare(b))
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
        out(r.changed ? `the map is written into the draft (${String(r.hash).slice(0, 12)}) — people see it once it is published: sacli graph publish '<what changed>'` : 'the map is unchanged', r)
        return 0
      }
      throw new CliError(HELP.map, 2)
    }
    if (cmd === 'graph') {
      // Every change goes into the draft; people and agents use the published version until the draft is published.
      if (pos[1] === 'draft') {
        const r = await hub.request({ t: 'graph:versions' }, { timeoutMs })
        if (r.t !== 'graph:reply') throw new CliError(String(r.reason ?? r.t), 1)
        const since = (r.since ?? []) as { name: string; kind: string; by: string; reason?: string; removed?: boolean }[]
        out(since.length ? `${since.length} change${since.length === 1 ? '' : 's'} not yet published (published: ${r.published ?? 'none'}):\n${since.map((c) => `  ${c.removed ? 'removed ' : ''}${c.kind} ${c.name}  — ${c.by}${c.reason ? `: ${c.reason}` : ''}`).join('\n')}` : `nothing in the draft — ${r.published ?? 'nothing'} is what is used`, { published: r.published ?? null, since })
        return 0
      }
      if (pos[1] === 'publish') {
        const message = pos.slice(2).join(' ').trim()
        if (!message) throw new CliError("say what changed: sacli graph publish '<what changed>'", 2)
        const r = await hub.request({ t: 'graph:version', message }, { timeoutMs })
        if (r.t !== 'graph:reply') throw new CliError(String(r.reason ?? r.t), 1)
        out(`published ${r.version?.name ?? 'the draft'}: people and agents use it from now on`, r.version)
        return 0
      }
      if (pos[1] === 'export' && pos[2]) {
        // The graph is the only source: written out as a working copy to edit, check and import again.
        const dir = resolve(io.cwd ?? process.cwd(), pos[2])
        const index = join(dir, 'index.mts')
        if (existsSync(index) && !o.force) throw new CliError(`${index} is there already — export to an empty folder, or --force to write over it`, 1)
        const r = await hub.request({ t: 'graph:export', ...(o.graph ? { graph: String(o.graph) } : {}) }, { timeoutMs })
        if (r.t !== 'graph:reply') throw new CliError(String(r.reason ?? r.t), 1)
        mkdirSync(dir, { recursive: true })
        writeFileSync(index, String(r.source))
        for (const [name, text] of Object.entries((r.files ?? {}) as Record<string, string>)) { const f = join(dir, name); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text) }
        const c = r.counts ?? {}
        out(`the knowledge at ${r.graph} → ${index}
${c.domains} domains · ${c.concepts} concepts · ${c.settings} settings · ${c.files} files
edit it, then: composition-graph check ${join(pos[2], 'index.mts')} · sacli graph import ${join(pos[2], 'index.mts')} · sacli ask --graph draft "…" · publish`, { graph: r.graph, index, counts: c })
        return 0
      }
      if (pos[1] !== 'import' || !pos[2]) throw new CliError(HELP.graph, 2)
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
    if (e instanceof CliError) {
      // A refusal for what the key holds: which profile (so which project and key) it was — the usual cause is another one.
      warn(/does not hold/.test(e.message) && usedProfile ? `${e.message} — with profile "${usedProfile}" (sacli profiles lists yours; --profile <name> or sacli use <name> picks another)` : e.message)
      return e.code
    }
    warn(`unexpected error: ${e?.stack ?? e}`)
    return 1
  } finally {
    ;(spinning as { stop: () => void } | null)?.stop()   // ended mid-way (a refusal, an error): the line goes
    if (hub && 'on' in hub) hub.close()
    try { footer?.() } catch { /* never fails a command */ }
  }
}

/** The profile the running command uses — said when a refusal is about what its key holds. */
let usedProfile = ''

export const readStdin = () => new Promise<string>((resolve) => {
  let data = ''
  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (l) => { data += l + '\n'; if (process.stdin.isTTY) rl.close() })
  rl.on('close', () => resolve(data))
})
