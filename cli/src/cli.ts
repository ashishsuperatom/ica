// sacli — the Superatom CLI. An agent (Codex, Claude, any coding agent) or a person works with a Superatom project
// through an agent API key that the project's admin made. Everything it does goes through the project's hub, is limited
// by the key's scopes, and is recorded in the project's audit history.

import { parseArgs, type ParseArgsConfig } from 'node:util'
import { createInterface } from 'node:readline'
import { CliError, DEFAULT_HUB, maskKey, orgOfKey, projectOfKey, readCredentials, writeCredentials, configPath, folderProfile, folderProject } from './config.ts'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect, type Hub } from './hub.ts'
import { viaDaemon, stopDaemon, daemonStatus, serveDaemon, type Conn } from './daemon.ts'
import { card, sessionView, table } from './render.ts'

export const VERSION = '0.1.0'

export interface Io { stdout: (s: string) => void; stderr: (s: string) => void; env: NodeJS.ProcessEnv; stdin?: () => Promise<string>; isTTY?: boolean
  /** This program's own file, to start the background connection with; without it every command connects directly. */
  script?: string
  cwd?: string }

const HELP: Record<string, string> = {
  main: `sacli — the Superatom CLI

Usage: sacli <command> [options]

Commands:
  login            save an agent API key (from --key, $SACLI_KEY or stdin) as a profile
  projects         the saved profiles — one project each — and which is in use
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

A key belongs to one project (sak_<project>_…) or one organisation (sak_org_<org>_…, for the warehouse), and a
profile holds one key: each profile is one project or organisation. The profile in use is
--profile, else $SACLI_PROFILE, else the nearest .sacli.json in this folder or above, else the default.
Commands share one background connection per project, kept for an hour after the last command.

Exit codes: 0 done · 1 refused or failed · 2 bad usage · 3 the key was refused · 4 network or timeout
Run 'sacli <command> --help' for a command's options.`,
  login: `sacli login [--key <key>] [--profile <name>] [--hub <url>]

Saves an agent API key, after checking the hub accepts it. The key is read from --key, $SACLI_KEY, or stdin
(so it never has to appear in your shell history):  printf %s "$KEY" | sacli login
Keys are made by the project's admin. Saved in ${'$'}SACLI_CONFIG or ~/.config/superatom/credentials.json (mode 600).`,
  logout: `sacli logout [--profile <name>]      forgets the saved key`,
  whoami: `sacli whoami [--profile <name>]      the key in use (masked), its project, and whether the hub accepts it`,
  agents: `sacli agents                        the project's agents (needs the sessions scope)`,
  session: `sacli session <open|get|intent|goto> …

  sacli session open <agent> [--id <session>]
  sacli session get <session> [--as-of <iso time>]
  sacli session intent <session> [--set <path>=<json>]… [--add <path>=<json>]… [--remove <path>[=<json>]]…
                                 [--call <package>.<fn>] [--param <name>=<json>]… [--act <package>.<action>]
                                 [--to current|new] [--block <block>]
  sacli session goto <session> <block>

An intent to "current" (the default) replaces the current block's answer; "new" opens a block. An intent from an
earlier block (--block) branches the session into a new thread. Values are JSON; a bare word is a string.`,
  projects: `sacli projects      the saved profiles, their projects, and which one is in use here`,
  use: `sacli use <profile> [--here]   make <profile> the default, or (--here) write .sacli.json so this folder uses it`,
  app: `sacli app publish <app folder>

The project's own application — server/ (what the engine runs) and the dashboard's web/ source — kept by the platform as
a new version (unchanged source: nothing new); the engine downloads it and reloads. No node_modules or builds travel.
Needs a key with the app scope.`,
  program: `sacli program build <folder>

A program's source — manifest.json, doc.md, server/…, web/… — built by the project's engine and kept by the platform,
the build with the source it came from. Needs a key with the programs scope.`,
  graph: `sacli graph import <knowledge/index.mts> [--reason '<why>']

The project's written knowledge — its domains, their concepts and files, its settings — imported into the project's
composition graph, which the platform holds (engines download it). What is unchanged records nothing. Needs a key that
may publish (scope publish).`,
  call: `sacli call <message> [--data '<json>']    e.g. sacli call graph:agent --data '{"name":"trips","body":{…}}'`,
  activity: `sacli activity         what is running for this key (program builds, session runs) and what ran in the last day`,
  status: `sacli status        whether the background connection for this key is up, and for how long`,
  disconnect: `sacli disconnect    closes the background connection for this key (the next command opens a new one)`,
  ask: `sacli ask <question> [--session <id>] [--channel <name>]   asks in words; prints the answer (needs the ask scope); --channel answers as that chat (teams) reads it`,
  warehouse: `sacli warehouse <tables|query|append|create|grants|grant|revoke> …

  sacli warehouse tables                               the tables you may see, and their columns
  sacli warehouse query "<sql>" [--limit <n>]          SQL over them (read-only; a project key reads its grant only)
  sacli warehouse append <table> [--rows '<json>' | --file <rows.json>]   rows (a JSON list; stdin when neither)
With an organisation key (sak_org_…) made by someone who may manage the warehouse:
  sacli warehouse explore <rows|values|profile|spread> <table | --sql "<query>"> [--column c] [--q text] [--sort c --desc] [--page n --size n]
  sacli warehouse create <table> --column <name>:<type>[!] …   types: string long int double float boolean date
                                                              timestamp timestamptz; a ! makes the column required
  sacli warehouse grants --project <id>                what a project may read and write
  sacli warehouse grant <table> --project <id> [--columns a,b] [--write]   let a project read (all or some columns)
                                                              — and, with --write, append (all columns)
  sacli warehouse revoke <table> --project <id>

A project key needs the warehouse scope to read and warehouse-write to append, and appends only to tables the
organisation granted the project to write. An organisation key holds what its maker holds of its scopes
(warehouse.query, warehouse.write, warehouse.manage).`,
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
    const words = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && /^--(profile|key|hub|timeout|id|as-of|set|add|remove|call|param|act|to|block|session|rows|file|limit|column|project|columns|data)$/.test(argv[i - 1])))
    const [cmd, sub] = words
    const specific: ParseArgsConfig['options'] = cmd === 'session'
      ? { id: { type: 'string' }, 'as-of': { type: 'string' }, set: { type: 'string', multiple: true }, add: { type: 'string', multiple: true }, remove: { type: 'string', multiple: true },
          call: { type: 'string' }, param: { type: 'string', multiple: true }, act: { type: 'string' }, to: { type: 'string' }, block: { type: 'string' } }
      : cmd === 'warehouse' ? { rows: { type: 'string' }, file: { type: 'string' }, limit: { type: 'string' }, column: { type: 'string', multiple: true }, project: { type: 'string' }, columns: { type: 'string' }, write: { type: 'boolean' }, q: { type: 'string' }, sort: { type: 'string' }, desc: { type: 'boolean' }, page: { type: 'string' }, size: { type: 'string' }, sql: { type: 'string' } }
      : cmd === 'ask' ? { session: { type: 'string' }, channel: { type: 'string' } } : cmd === 'use' ? { here: { type: 'boolean' } } : cmd === 'call' ? { data: { type: 'string' } } : cmd === 'graph' ? { reason: { type: 'string' } } : {}
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

    if (cmd === 'projects') {
      const names = Object.keys(creds.profiles)
      if (!names.length) { out('no saved profiles — run sacli login', []); return 0 }
      const rows = names.map((n) => ({ profile: n, project: projectOfKey(creds.profiles[n].key) ?? `organisation ${orgOfKey(creds.profiles[n].key)}`, hub: creds.profiles[n].hub, inUse: n === profileName, isDefault: n === creds.default }))
      out(table(['', 'profile', 'project', 'hub'], rows.map((r) => [r.inUse ? '*' : '', r.profile + (r.isDefault ? ' (default)' : ''), r.project, r.hub])) + (folder ? `\n(this folder uses "${folder.profile}" — ${folder.file})` : ''), rows)
      return 0
    }
    if (cmd === 'use') {
      const name = pos[1]
      if (!name) throw new CliError('which profile? sacli use <profile>', 2)
      if (!creds.profiles[name]) throw new CliError(`there is no profile "${name}" — see sacli projects`, 2)
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
        await call({ t: 'warehouse:tables' })
        creds.profiles[profileName] = { key, hub: hubUrl, savedAt: new Date().toISOString() }
        creds.default ??= profileName
        const file = writeCredentials(creds, io.env)
        out(`logged in to organisation ${org} as profile "${profileName}" (saved in ${file})`, { ok: true, profile: profileName, org, file })
        return 0
      }
      if (cmd === 'whoami') { await call({ t: 'warehouse:tables' }); out(`key           ${maskKey(key)}\norganisation  ${org}\nhub           ${hubUrl}\nprofile       ${o.key || io.env.SACLI_KEY ? '(from --key / $SACLI_KEY)' : profileName}`, { key: maskKey(key), org, hub: hubUrl, profile: profileName }); return 0 }
      if (cmd !== 'warehouse') throw new CliError(`an organisation key works with sacli warehouse (and login, whoami) — ${cmd} needs a project's key`, 2)
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
      if (sub === 'grants') { const r = await call({ t: 'warehouse:grants', project: project() }); out(Object.keys(r.grant ?? {}).length ? table(['table', 'columns', 'write'], Object.entries(r.grant).map(([t, c]: [string, any]) => [t, c === null ? 'all' : c.join(', '), (r.writable ?? []).includes(t) ? 'yes' : ''])) : 'this project was granted nothing', r); return 0 }
      if (sub === 'grant') { const t = need(' --project <id>'); const columns = o.columns ? String(o.columns).split(',').map((c) => c.trim()).filter(Boolean) : null; const r = await call({ t: 'warehouse:grant', project: project(), table: t, columns, write: !!o.write }); if (r.error) throw new CliError(r.error); out(`project ${o.project} may read ${columns ? columns.join(', ') + ' of ' : ''}${t}${o.write ? ' and append to it' : ''}`, r); return 0 }
      if (sub === 'revoke') { const t = need(' --project <id>'); const r = await call({ t: 'warehouse:revoke', project: project(), table: t }); out(`project ${o.project} may no longer read ${t}`, r); return 0 }
      throw new CliError(`there is no 'warehouse ${sub ?? ''}' — tables, query, explore, append, create, grants, grant or revoke`, 2)
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
    if (cmd === 'program') {
      if (pos[1] !== 'build' || !pos[2]) throw new CliError('sacli program build <folder>', 2)
      const root = resolve(io.cwd ?? process.cwd(), pos[2])
      const owner = folderProject(root), keyProject = projectOfKey(key ?? '')
      if (owner && keyProject && owner.project !== keyProject) throw new CliError(`${pos[2]} belongs to project ${owner.project} (${owner.file}); this key is project ${keyProject}'s — use that project's key`, 1)
      const files: Record<string, string> = {}
      const walk = (dir: string, rel: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue
          const r = rel ? `${rel}/${e.name}` : e.name
          if (e.isDirectory()) walk(join(dir, e.name), r)
          else if (/^(manifest\.json|doc\.md|(server|web)\/.+)$/.test(r)) files[r] = readFileSync(join(dir, e.name), 'utf8')
        }
      }
      try { walk(root, '') } catch (e: any) { throw new CliError(`${pos[2]} could not be read: ${e?.message ?? e}`, 1) }
      if (!files['manifest.json']) throw new CliError(`${pos[2]} has no manifest.json`, 1)
      const r = await hub.request({ t: 'program:build', files }, { timeoutMs })
      if (r.t !== 'program:built') throw new CliError(String(r.reason ?? r.error ?? r.t), 1)
      out(`${r.name} ${r.version ?? ''} → ${String(r.hash).slice(0, 12)}${r.added ? '' : ' (already kept)'}`, r)
      return 0
    }
    if (cmd === 'graph') {
      if (pos[1] !== 'import' || !pos[2]) throw new CliError('sacli graph import <knowledge/index.mts>', 2)
      const file = resolve(io.cwd ?? process.cwd(), pos[2])
      const owner = folderProject(file), keyProject = projectOfKey(key ?? '')
      if (owner && keyProject && owner.project !== keyProject) throw new CliError(`${pos[2]} belongs to project ${owner.project} (${owner.file}); this key is project ${keyProject}'s — use that project's key`, 1)
      let mod: any
      try { mod = await import(pathToFileURL(file).href) } catch (e: any) { throw new CliError(`${pos[2]} could not be read: ${e?.message ?? e}`, 1) }
      const dir = dirname(file)
      // Each file a domain lists, by the name import reads it with: a domain's own beside it, a shared one by its path.
      const files: Record<string, string> = {}
      for (const d of (mod.domains ?? []) as { name: string; files?: string[] }[]) for (const f of d.files ?? []) {
        const at = f.includes('/') ? join(dir, f) : join(dir, d.name.replace(/\s+/g, '-').toLowerCase(), f)
        try { files[`${d.name}|${f}`] = readFileSync(at, 'utf8') } catch { throw new CliError(`domain "${d.name}" lists ${f}, which is not at ${at}`, 1) }
      }
      const r = await hub.request({ t: 'graph:import', domains: mod.domains ?? [], settings: mod.settings ?? [], files, ...(o.reason ? { reason: o.reason } : {}) }, { timeoutMs })
      if (r.t !== 'graph:reply') throw new CliError(String(r.reason ?? r.error ?? r.t), 1)
      const rows = (r.imported ?? []) as { name: string; kind: string; hash: string; changed: boolean }[]
      out(rows.map((x) => `${x.changed ? 'changed  ' : 'unchanged'} ${x.kind.padEnd(7)} ${x.name}`).join('\n') + `\n${rows.filter((x) => x.changed).length} of ${rows.length} changed`, r)
      return 0
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
      if (['create', 'grants', 'grant', 'revoke'].includes(String(sub))) throw new CliError(`warehouse ${sub} is the organisation's: use an organisation key (sak_org_…), made in the admin console's Warehouse`, 2)
      throw new CliError(`there is no 'warehouse ${sub ?? ''}' — tables, query or append (create and grant with an organisation key)`, 2)
    }
    if (cmd === 'ask') {
      const question = pos.slice(1).join(' ').trim()
      if (!question) throw new CliError('what is the question? sacli ask "<question>"', 2)
      const sessionId = o.session ?? `ask-${crypto.randomUUID()}`
      const qid = `q-${crypto.randomUUID()}`
      // The answer comes as analyst:answer for this question; narration says what is happening meanwhile.
      const payload = { t: 'analyse', question, projectId: hub.project.id, sessionId, questionId: qid, ...(o.channel ? { channel: String(o.channel) } : {}) }
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
      out(`${card(m.answer)}\n\n(session ${sessionId})`, { session: sessionId, qid, answer: m.answer })
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
