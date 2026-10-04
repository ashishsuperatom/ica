// sacli — the Superatom CLI. An agent (Codex, Claude, any coding agent) or a person works with a Superatom project
// through an agent API key that the project's admin made. Everything it does goes through the project's hub, is limited
// by the key's scopes, and is recorded in the project's audit history.

import { parseArgs, type ParseArgsConfig } from 'node:util'
import { createInterface } from 'node:readline'
import { CliError, DEFAULT_HUB, maskKey, projectOfKey, readCredentials, writeCredentials, configPath } from './config.ts'
import { connect, type Hub } from './hub.ts'
import { card, sessionView, table } from './render.ts'

export const VERSION = '0.1.0'

export interface Io { stdout: (s: string) => void; stderr: (s: string) => void; env: NodeJS.ProcessEnv; stdin?: () => Promise<string>; isTTY?: boolean }

const HELP: Record<string, string> = {
  main: `sacli — the Superatom CLI

Usage: sacli <command> [options]

Commands:
  login            save an agent API key (from --key, $SACLI_KEY or stdin)
  logout           forget a saved key
  whoami           the key in use, its project, and whether the hub accepts it
  agents           the project's agents
  session open     start a session with an agent
  session get      a session: its current thread, answers and actions
  session intent   change a session: set/add/remove, call a function, take an action
  session goto     move a session to another block
  ask              ask the project a question in words

Global options:
  --profile <name>   the saved key to use (default: the default profile)
  --key <key>        an agent key for this command only (or $SACLI_KEY)
  --hub <url>        the hub (default ${DEFAULT_HUB}, or $SACLI_HUB)
  --json             machine-readable output
  --timeout <s>      how long to wait for a reply (default 120)
  -h, --help         help for a command
  -V, --version      the version

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
  ask: `sacli ask <question> [--session <id>]   asks in words; prints the answer (needs the ask scope)`,
}

const GLOBAL: ParseArgsConfig['options'] = {
  profile: { type: 'string' }, key: { type: 'string' }, hub: { type: 'string' }, json: { type: 'boolean' },
  timeout: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'V' },
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
  let hub: Hub | null = null
  try {
    // The command words come first; options may be anywhere.
    const words = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && /^--(profile|key|hub|timeout|id|as-of|set|add|remove|call|param|act|to|block|session)$/.test(argv[i - 1])))
    const [cmd, sub] = words
    const specific: ParseArgsConfig['options'] = cmd === 'session'
      ? { id: { type: 'string' }, 'as-of': { type: 'string' }, set: { type: 'string', multiple: true }, add: { type: 'string', multiple: true }, remove: { type: 'string', multiple: true },
          call: { type: 'string' }, param: { type: 'string', multiple: true }, act: { type: 'string' }, to: { type: 'string' }, block: { type: 'string' } }
      : cmd === 'ask' ? { session: { type: 'string' } } : {}
    let parsed
    try { parsed = parseArgs({ args: argv, options: { ...GLOBAL, ...specific }, allowPositionals: true, strict: true }) }
    catch (e: any) { throw new CliError(`${e.message.replace(/^Unknown option/, 'unknown option')} — see sacli ${cmd ?? ''} --help`.replace(/\s+—/, ' —'), 2) }
    const o = parsed.values as Record<string, any>
    const pos = parsed.positionals

    if (o.version) { say(VERSION); return 0 }
    if (!cmd || o.help) { say(HELP[cmd ?? 'main'] ?? HELP.main); return cmd && !HELP[cmd] ? 2 : 0 }
    if (!HELP[cmd]) throw new CliError(`there is no command "${cmd}" — see sacli --help`, 2)

    const timeoutMs = o.timeout ? Number(o.timeout) * 1000 : 120_000
    if (!(timeoutMs > 0)) throw new CliError('--timeout is a number of seconds', 2)
    const creds = readCredentials(io.env)
    const profileName = o.profile ?? io.env.SACLI_PROFILE ?? creds.default ?? 'default'
    const saved = creds.profiles[profileName]
    const hubUrl = o.hub ?? io.env.SACLI_HUB ?? saved?.hub ?? DEFAULT_HUB
    const out = (human: string, data: unknown) => say(o.json ? JSON.stringify(data, null, 2) : human)

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
    if (!projectOfKey(key)) throw new CliError('that is not an agent key (sak_<project>_<secret>) — make one in the project\'s admin console', 3)

    hub = await connect({ key, hub: hubUrl, timeoutMs: Math.min(timeoutMs, 30_000), log: (s) => { if (!o.json) warn(s) } })

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
    if (cmd === 'ask') {
      const question = pos.slice(1).join(' ').trim()
      if (!question) throw new CliError('what is the question? sacli ask "<question>"', 2)
      const sessionId = o.session ?? `ask-${crypto.randomUUID()}`
      const qid = `q-${crypto.randomUUID()}`
      // The answer comes as analyst:answer for this question; narration says what is happening meanwhile.
      const done = new Promise<any>((resolve) => {
        const off = hub!.on((m) => {
          if (m.t === 'narration' && m.qid === qid && !o.json && m.text) warn(String(m.text))
          if (m.t === 'analyst:answer' && m.qid === qid) { off(); resolve(m) }
        })
      })
      const timer = new Promise((_, reject) => setTimeout(() => reject(new CliError(`no answer in ${Math.round(timeoutMs / 1000)}s`, 4)), timeoutMs))
      hub.request({ t: 'analyse', question, projectId: hub.project.id, sessionId, questionId: qid }, { timeoutMs }).catch((e) => { if (e instanceof CliError && !/no reply/.test(e.message)) throw e })
      const refused = new Promise((_, reject) => hub!.on((m) => { if (m.t === 'error' && (m.reqId?.startsWith('sacli-') || !m.reqId) && m.reason) reject(new CliError(m.reason)) }))
      const m: any = await Promise.race([done, timer, refused])
      out(`${card(m.answer)}\n\n(session ${sessionId})`, { session: sessionId, qid, answer: m.answer })
      return 0
    }
    throw new CliError(`there is no command "${cmd}"`, 2)
  } catch (e: any) {
    if (e instanceof CliError) { warn(e.message); return e.code }
    warn(`unexpected error: ${e?.stack ?? e}`)
    return 1
  } finally {
    hub?.close()
  }
}

export const readStdin = () => new Promise<string>((resolve) => {
  let data = ''
  const rl = createInterface({ input: process.stdin, terminal: false })
  rl.on('line', (l) => { data += l + '\n'; if (process.stdin.isTTY) rl.close() })
  rl.on('close', () => resolve(data))
})
