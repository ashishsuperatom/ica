// sacli engine — where a project's engine runs, started, watched and stopped from here: in Docker (the default), or with
// --native as two PM2 processes beside the repo (the project's datasource manager and its engine). Either way the engine
// connects OUT to the project's hub; nothing listens for it.
//
// Docker follows compose's conventions: one container per project (sa-engine-<project>), its data on a named volume of
// the same name (/app/data, which survives the container), restarted unless stopped. Starting again changes nothing — or,
// when the image changed, makes the container again on the same volume. PM2 uses the repo's ecosystem.config.cjs: the
// project's home (~/.superatom/<project>/.env) is what it reads.
//
// What the engine needs to connect — the project, its engine key, the hub — comes from the platform
// (GET /api/projects/<id>/engine-credentials, which needs project.manage). status, stop and logs find where the engine
// runs themselves.

import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { CliError } from './config.ts'

/** Where engine releases come from (docs/deploying-the-engine.md): built by GitHub Actions, never on the box. */
export const REGISTRY_IMAGE = 'registry.superatom.ai/superatom-engine'
/** A project's containers on a machine are found by their labels (superatom.project, superatom.role), whatever they are
 *  named: superatom-<project name> (the engine) and superatom-<project name>-updater, as the installer names them now, or
 *  sa-engine-<project> / sa-engine-updater-<project>, as earlier installs did. */
export function containersOf(exec: (args: string[]) => Ran, pid: string): { engine: string | null; updater: string | null } {
  const r = exec(['ps', '-a', '--filter', `label=superatom.project=${pid}`, '--format', '{{.Names}}|{{.Label "superatom.role"}}'])
  const rows = r.code ? [] : r.out.trim().split('\n').filter(Boolean).map((l) => { const [name, role] = l.split('|'); return { name: name!, role: role || (/updater/.test(name!) ? 'updater' : 'engine') } })
  return { engine: rows.find((x) => x.role === 'engine')?.name ?? null, updater: rows.find((x) => x.role === 'updater')?.name ?? null }
}

export interface EngineCredentials { project: string; name: string | null; engineKey: string; hub: string; platform: string }
export interface Ran { code: number; out: string; err: string }
export interface EngineDeps {
  /** The key in use: the installer sets the engine up with it, once (never kept). */
  key: string
  rest: (method: string, path: string, body?: unknown) => Promise<any>
  /** Runs a program; `show` streams its output to this terminal instead of capturing it. */
  exec: (cmd: string, args: string[], o?: { show?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }) => Ran
  say: (human: string, data: unknown) => void
  note: (s: string) => void
  env: NodeJS.ProcessEnv
  /** The repo sacli came from (--native runs from it), when it has one. */
  repo: string | null
  /** Where projects' homes are: $SUPERATOM_HOME or ~/.superatom. */
  homes: string
  sleep: (ms: number) => Promise<void>
}

/** The environment the engine runs with inside its container (the layout the Fly machines use too). */
export function dockerEnv(c: EngineCredentials): Record<string, string> {
  return {
    ICA_PROJECT: c.project, ICA_KEY: c.engineKey, ICA_HUB: c.hub, SUPERATOM_PLATFORM: c.platform,
    ...(c.name ? { PROJECT_NAME: slug(c.name) } : {}),
    SUPERATOM_HOME: '/app/data', DATASOURCE_URL: 'http://localhost:4000',
    DATASOURCE_DATA_DIR: '/app/data/datasources', DATASOURCES_DIR: '/app/data/datasources',
  }
}

/** A name fit for a process: lower case, words joined by dashes. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)

/** A .env file as an object (comments and blank lines left out). */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (m && !line.trim().startsWith('#')) out[m[1]!] = m[2]!
  }
  return out
}

/** The project homes here, each with its .env. */
export function homesHere(homes: string): { pid: string; dir: string; env: Record<string, string> }[] {
  let names: string[] = []
  try { names = readdirSync(homes) } catch { return [] }
  return names.filter((n) => /^[0-9a-f-]{36}$/.test(n)).map((pid) => ({ pid, dir: join(homes, pid), env: readEnvFile(join(homes, pid, '.env')) }))
}

/** A native home's .env for this project: what was there kept, the connection's values set now, a process name no other
 *  home uses, and a datasource port no other home uses (the one it had, if it had one). */
export function localEnv(c: EngineCredentials, homes: { pid: string; env: Record<string, string> }[], port: number): Record<string, string> {
  const mine = homes.find((h) => h.pid === c.project)?.env ?? {}
  const others = homes.filter((h) => h.pid !== c.project)
  let name = mine.PROJECT_NAME || slug(c.name ?? '') || c.project.slice(0, 8)
  if (others.some((h) => h.env.PROJECT_NAME === name)) name = `${name}-${c.project.slice(0, 8)}`
  return { ...mine, ICA_PROJECT: c.project, ICA_KEY: c.engineKey, ICA_HUB: c.hub, SUPERATOM_PLATFORM: c.platform, PROJECT_NAME: name,
    DATASOURCE_PORT: String(port), DATASOURCE_URL: `http://localhost:${port}` }
}

const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const s = createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true)))
  s.listen(port, '127.0.0.1')
})

/** The port this home keeps, else the first after every other home's that nothing listens on. */
async function portFor(pid: string, homes: { pid: string; env: Record<string, string> }[]): Promise<number> {
  const had = Number(homes.find((h) => h.pid === pid)?.env.DATASOURCE_PORT)
  if (had > 0) return had
  const taken = new Set(homes.map((h) => Number(h.env.DATASOURCE_PORT)).filter((n) => n > 0))
  for (let p = Math.max(4020, ...taken) + 1; p < 4200; p++) if (!taken.has(p) && await portFree(p)) return p
  throw new CliError('no free port for the datasource manager between 4021 and 4200', 1)
}

/** The engine's own environment never carries the session it was started from (a Claude Code session's variables make
 *  the agents' own sessions keep no transcript). */
export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE'))
}

type Where = { at: 'docker'; name: string; state: string; startedAt: string; image: string; ref: string } | { at: 'native'; name: string; state: string; startedAt: string } | { at: 'none' }

export async function engineCommand(sub: string | undefined, pid: string, o: { native?: boolean; image?: string; wait?: string; follow?: boolean; lines?: string; tag?: string }, d: EngineDeps): Promise<number> {
  const docker = (args: string[], show = false) => d.exec('docker', args, { show })
  const dockerUp = () => docker(['info', '--format', '{{.ServerVersion}}']).code === 0
  const pm2 = (args: string[], show = false) => d.exec('pm2', args, { show, env: cleanEnv(d.env) })
  const found = () => (dockerUp() ? containersOf((a) => docker(a), pid) : { engine: null, updater: null })

  function where(): Where {
    const name = found().engine
    const i = name ? docker(['inspect', '--format', '{{.State.Status}}|{{.State.StartedAt}}|{{.Image}}|{{.Config.Image}}', name]) : { code: 1, out: '', err: '' }
    if (name && i.code === 0) { const [state, startedAt, image, ref] = i.out.trim().split('|'); return { at: 'docker', name, state: state!, startedAt: startedAt!, image: image!, ref: ref ?? '' } }
    const home = homesHere(d.homes).find((h) => h.pid === pid)
    if (home?.env.PROJECT_NAME) {
      const list = pm2(['jlist'])
      try {
        const p = (JSON.parse(list.out || '[]') as any[]).find((x) => x.name === `sa-engine-${home.env.PROJECT_NAME}`)
        if (p) return { at: 'native', name: home.env.PROJECT_NAME, state: p.pm2_env?.status ?? 'unknown', startedAt: p.pm2_env?.pm_uptime ? new Date(p.pm2_env.pm_uptime).toISOString() : '' }
      } catch { /* pm2 said nothing readable */ }
    }
    return { at: 'none' }
  }
  const connected = async (): Promise<boolean> => {
    const s = await d.rest('GET', `/api/projects/${pid}/status`)
    return (s.connections ?? []).some((c: any) => c.type === 'code-engine')
  }
  const waitConnected = async (): Promise<boolean> => {
    const until = Date.now() + (o.wait ? Number(o.wait) : 180) * 1000
    while (Date.now() < until) { if (await connected()) return true; await d.sleep(2000) }
    return false
  }

  if (sub === 'status' || !sub) {
    const w = where(), on = await connected()
    const runs = w.at === 'docker' ? `in Docker (container ${w.name}, ${w.state}${w.startedAt ? ` since ${w.startedAt.slice(0, 19)}` : ''})`
      : w.at === 'native' ? `here under PM2 (sa-engine-${w.name}, ${w.state}${w.startedAt ? ` since ${w.startedAt.slice(0, 19)}` : ''})` : 'nowhere on this machine'
    d.say(`project ${pid}\nruns         ${runs}\nconnected    ${on ? 'yes — the hub has its engine' : 'no — the hub has no engine for this project'}`, { project: pid, runs: w, connected: on })
    return 0
  }

  if (sub === 'logs') {
    const w = where(), lines = o.lines ?? '200'
    if (w.at === 'docker') return docker(['logs', '--tail', lines, ...(o.follow ? ['--follow'] : []), w.name], true).code
    if (w.at === 'native') return pm2(['logs', `sa-engine-${w.name}`, '--lines', lines, ...(o.follow ? [] : ['--nostream'])], true).code
    throw new CliError(`the engine of ${pid} does not run on this machine — sacli engine start`, 1)
  }

  if (sub === 'stop') {
    const w = where()
    if (w.at === 'docker') {
      // The updater first: a stopped engine stays stopped, never switched back on by a release chosen meanwhile.
      const u = found().updater; if (u) docker(['rm', '-f', u])
      const r = docker(['stop', w.name]); if (r.code) throw new CliError(`docker could not stop ${w.name}: ${r.err.trim()}`, 1)
      d.say(`stopped ${w.name} (its data stays on its volume)`, { stopped: w.name, at: 'docker' }); return 0
    }
    if (w.at === 'native') {
      for (const p of [`sa-engine-${w.name}`, `sa-datasources-${w.name}`]) pm2(['delete', p])
      d.say(`stopped sa-engine-${w.name} and sa-datasources-${w.name} (the home stays)`, { stopped: w.name, at: 'native' }); return 0
    }
    d.say(`the engine of ${pid} does not run on this machine`, { stopped: null }); return 0
  }

  // VERSIONS: which engine version the project runs and which are there. SWITCH <tag>: switch the project's engine to one
  // — the box's Engine Updater pulls it and swaps within a minute, going back if the new one does not come up.
  if (sub === 'switch' && !o.tag) throw new CliError('switch to which version? sacli engine switch <dev-<date>-<commit> | dev | prod> — sacli engine versions lists them', 2)
  if (sub === 'versions' || sub === 'switch') {
    const tag = sub === 'switch' ? o.tag : undefined
    if (tag) {
      const r = await d.rest('PUT', `/api/projects/${pid}/engine-release`, { tag }) as any
      if (r?.error) throw new CliError(r.error, 1)
      d.say(`switching to ${tag} (${String(r.desired?.digest ?? '').slice(0, 19)}) — ${r.delivered ? 'the engine has been told; its Engine Updater switches it within a minute (sacli engine versions shows each step)' : 'the engine is not connected; it switches when it comes back'}`, r)
      return 0
    }
    const r = await d.rest('GET', `/api/projects/${pid}/engine-release`) as any
    const name = (digest?: string | null) => (digest ? (r.releases ?? []).filter((x: any) => x.digest === digest).map((x: any) => x.tag).join(', ') || digest.slice(0, 19) : '—')
    const last = r.running?.last
    const sw = r.switch
    d.say([`chosen       ${name(r.desired?.digest)}${r.desired ? ` (by ${r.desired.setBy ?? '?'} ${new Date(r.desired.setAt).toISOString().slice(0, 16)})` : ' — none: a new box starts on the newest dev'}`,
      `running      ${r.online ? `${name(r.running?.digest)} (build ${String(r.running?.build ?? '?').slice(0, 8)})` : 'no engine connected'}`,
      ...(sw ? [`switch       ${sw.state} → ${sw.tag ?? String(sw.to).slice(0, 19)}, started ${sw.startedAt.slice(0, 19)}${sw.endedAt ? `, took ${Math.round((Date.parse(sw.endedAt) - Date.parse(sw.startedAt)) / 1000)}s` : ''}${sw.reason ? ` — ${sw.reason}` : ''}`,
        ...sw.steps.map((x: any) => `               ${x.at.slice(11, 19)}  ${x.step}${x.note ? ` · ${x.note}` : ''}`)] : last ? [`last switch  ${last.state} → ${last.tag ?? String(last.to).slice(0, 19)}`] : []),
      ...(r.problem ? [`problem      ${r.problem}`] : []),
      'versions', ...(r.releases ?? []).filter((x: any) => /-\d{8}-[0-9a-f]+$/.test(x.tag)).slice(0, 10).map((x: any) => {
        const ch = (r.releases ?? []).filter((y: any) => !/-\d{8}-[0-9a-f]+$/.test(y.tag) && y.digest === x.digest).map((y: any) => y.tag)
        return `  ${x.tag.padEnd(24)} ${x.at.slice(0, 16)}  ${x.digest.slice(7, 19)}${ch.length ? `  [${ch.join(', ')}]` : ''}${x.digest === r.running?.digest ? '  ← running' : ''}`
      })].join('\n'), r)
    return 0
  }

  if (sub !== 'start') throw new CliError('sacli engine <start|status|stop|logs|versions|switch> — see sacli engine --help', 2)

  const w = where()
  const want = o.native ? 'native' : 'docker'
  if (w.at !== 'none' && w.at !== want && w.state !== 'exited' && w.state !== 'stopped')
    throw new CliError(`the engine of ${pid} already runs ${w.at === 'docker' ? 'in Docker' : 'here under PM2'} — sacli engine stop first, then start it ${want === 'docker' ? 'in Docker' : 'with --native'}`, 1)
  if (w.at === 'none' && await connected())
    throw new CliError(`the hub already has an engine for ${pid}, from somewhere other than this machine — a project runs one engine; stop that one first`, 1)
  const c = await d.rest('GET', `/api/projects/${pid}/engine-credentials`) as EngineCredentials

  if (want === 'docker') {
    if (!dockerUp()) throw new CliError('Docker is not running — start Docker Desktop (or the docker daemon), or run it natively with --native (PM2)', 1)
    if (!o.image) {
      // THE INSTALLER — the same one a machine runs (get.superatom.site/engine/install.sh): from the engine's own image, it
      // asks the platform for the release chosen, pulls it by digest, and starts the engine and its updater. One way.
      d.note(`fetching the installer (${REGISTRY_IMAGE}:dev)…`)
      if (docker(['pull', '-q', `${REGISTRY_IMAGE}:dev`]).code !== 0) throw new CliError(`could not pull ${REGISTRY_IMAGE}:dev — check this machine reaches the registry (curl https://registry.superatom.ai/v2/)`, 1)
      const envf = join(mkdtempSync(join(tmpdir(), 'sa-install-')), 'env')
      writeFileSync(envf, `SUPERATOM_KEY=${d.key}\nSUPERATOM_PLATFORM=${(d.env.SACLI_PLATFORM ?? 'https://superatom.site')}\n`, { mode: 0o600 })
      try {
        const r = docker(['run', '--rm', '--env-file', envf, '--volume', '/var/run/docker.sock:/var/run/docker.sock', '--entrypoint', 'node', `${REGISTRY_IMAGE}:dev`, '/app/apps/updater/install.mjs'], true)
        if (r.code) throw new CliError('the installer did not finish — its last lines above say why', 1)
      } finally { rmSync(dirname(envf), { recursive: true, force: true }) }
      return 0
    }
    // A LOCAL IMAGE (--image, for developing the engine itself): started under the same names and labels the installer
    // uses; the updater does not follow releases for an image that is not from the registry.
    const image = o.image
    if (docker(['image', 'inspect', image]).code !== 0 && docker(['pull', image], true).code !== 0) throw new CliError(`there is no image ${image} here, and it could not be pulled`, 1)
    const base = `superatom-${slug(c.name ?? '') || pid.slice(0, 8)}`
    const was = found()
    const volume = was.engine ? docker(['inspect', '--format', '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}', was.engine]).out.trim() || `${base}-data` : `${base}-data`
    if (was.updater) docker(['rm', '-f', was.updater])
    if (was.engine) docker(['rm', '-f', was.engine])
    const env = Object.entries({ ...dockerEnv(c), SA_ENGINE_IMAGE: image }).flatMap(([k, v]) => ['--env', `${k}=${v}`])
    const r = docker(['run', '--detach', '--name', base, '--restart', 'unless-stopped', '--volume', `${volume}:/app/data`, '--label', `superatom.project=${pid}`, '--label', 'superatom.role=engine', ...env, image])
    if (r.code) throw new CliError(`docker could not start ${base}: ${r.err.trim()}`, 1)
    d.note(`started ${base} on ${image} (a local image: no updater), data on volume ${volume}; waiting for it to reach the hub…`)
  } else {
    if (!d.repo || !existsSync(join(d.repo, 'ecosystem.config.cjs'))) throw new CliError('--native runs from the repo (its ecosystem.config.cjs), and sacli is not running from one', 1)
    if (pm2(['--version']).code !== 0) throw new CliError('pm2 is not installed — pnpm add -g pm2', 1)
    const homes = homesHere(d.homes)
    const env = localEnv(c, homes, await portFor(pid, homes))
    const dir = join(d.homes, pid)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, '.env'), tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 })
    renameSync(tmp, file); chmodSync(file, 0o600)
    const only = `sa-datasources-${env.PROJECT_NAME},sa-engine-${env.PROJECT_NAME}`
    const r = d.exec('pm2', ['startOrRestart', join(d.repo, 'ecosystem.config.cjs'), '--only', only, '--update-env'], { cwd: d.repo, env: cleanEnv({ ...d.env, SUPERATOM_HOME: d.homes }) })
    if (r.code) throw new CliError(`pm2 could not start ${only}: ${(r.err || r.out).trim()}`, 1)
    d.note(`started sa-engine-${env.PROJECT_NAME} and sa-datasources-${env.PROJECT_NAME} (port ${env.DATASOURCE_PORT}) from ${file}; waiting for it to reach the hub…`)
  }

  if (!(await waitConnected())) throw new CliError(`the engine started but has not reached the hub yet — sacli engine logs`, 1)
  d.say(`the engine of ${c.name ?? pid} is connected`, { project: pid, at: want, connected: true })
  return 0
}

/** The real programs and paths. */
export function realDeps(p: Pick<EngineDeps, 'rest' | 'say' | 'note' | 'env' | 'repo' | 'key'>): EngineDeps {
  return {
    ...p,
    homes: p.env.SUPERATOM_HOME || join(homedir(), '.superatom'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exec: (cmd, args, o = {}) => {
      const opts: SpawnSyncOptions = { cwd: o.cwd, env: o.env ?? p.env, encoding: 'utf8', stdio: o.show ? 'inherit' : 'pipe', maxBuffer: 64 * 1024 * 1024 }
      const r = spawnSync(cmd, args, opts)
      if (r.error && (r.error as any).code === 'ENOENT') return { code: 127, out: '', err: `${cmd} is not installed` }
      return { code: r.status ?? 1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
    },
  }
}
