// sacli's own versions, from get.superatom.site (docs/releases.md). The same layout cli/install.sh makes: each version
// in <SACLI_HOME>/<version>/sacli.mjs, `current` pointing at the one in use, a launcher on the PATH running `current`.
//   upgrade [<version|channel>]   download it, check its sha256 against the release's manifest, point `current` at it
//   notice                        once a day, on a terminal, one line on stderr when a newer version is out

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CliError } from './config.ts'

export const getUrl = (env: NodeJS.ProcessEnv) => (env.SACLI_GET || 'https://get.superatom.site').replace(/\/$/, '')
export const sacliHome = (env: NodeJS.ProcessEnv) => env.SACLI_HOME || join(homedir(), '.superatom', 'sacli')

interface Manifest { product: string; version: string; files: { name: string; size: number; sha256: string }[] }

/** -1, 0, 1 — dotted numbers compared as numbers; anything else after them as text. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/), pb = b.split(/[.-]/)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '', y = pb[i] ?? ''
    if (x === y) continue
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) return Number(x) < Number(y) ? -1 : 1
    if (!x) return -1
    if (!y) return 1
    return x < y ? -1 : 1
  }
  return 0
}

async function manifestOf(env: NodeJS.ProcessEnv, ref: string, timeoutMs = 15_000): Promise<Manifest> {
  const url = `${getUrl(env)}/sacli/${encodeURIComponent(ref)}`
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).catch((e) => { throw new CliError(`cannot reach ${getUrl(env)} (${e.message}) — check the network`, 4) })
  if (r.status === 404) throw new CliError(`there is no sacli "${ref}" — the versions there are: ${getUrl(env)}/sacli`, 1)
  if (!r.ok) throw new CliError(`${url} answered ${r.status} — try again shortly`, 4)
  const m = await r.json() as Manifest
  if (!m.version || !m.files?.some((f) => f.name === 'sacli.mjs')) throw new CliError(`the release "${ref}" does not describe sacli.mjs — a broken release; name a version instead (see ${getUrl(env)}/sacli)`, 1)
  return m
}

/** Where this sacli runs from, when it is one install.sh / upgrade put in place; null when installed some other way. */
export function installedVersion(env: NodeJS.ProcessEnv, script: string | undefined): string | null {
  if (!script) return null
  const home = sacliHome(env)
  try {
    const real = realpathSync(script), base = realpathSync(home)
    const m = real.startsWith(base + '/') ? /^([^/]+)\/sacli\.mjs$/.exec(real.slice(base.length + 1)) : null
    return m ? m[1] : null
  } catch { return null }
}

export async function upgrade(env: NodeJS.ProcessEnv, script: string | undefined, current: string, ref = 'latest'): Promise<{ from: string; to: string; changed: boolean; path: string }> {
  const home = sacliHome(env)
  if (!installedVersion(env, script)) throw new CliError(`this sacli (${script ?? 'unknown'}) was not installed by the installer, so it cannot replace itself — install it with: curl -fsSL ${getUrl(env)}/sacli/install.sh | sh`, 1)
  const m = await manifestOf(env, ref)
  const dir = join(home, m.version), file = join(dir, 'sacli.mjs')
  const want = m.files.find((f) => f.name === 'sacli.mjs')!.sha256
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  if (!(existsSync(file) && sha(readFileSync(file)) === want)) {
    const r = await fetch(`${getUrl(env)}/sacli/${m.version}/sacli.mjs`, { signal: AbortSignal.timeout(120_000) }).catch((e) => { throw new CliError(`downloading sacli ${m.version} failed (${e.message}) — run again`, 4) })
    if (!r.ok) throw new CliError(`downloading sacli ${m.version} failed (${r.status}) — run again`, 4)
    const body = Buffer.from(await r.arrayBuffer())
    if (sha(body) !== want) throw new CliError(`the download of sacli ${m.version} is not what was published (sha256 differs) — run again; if it persists, something between you and ${getUrl(env)} changes files`, 1)
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${file}.tmp`, body); chmodSync(`${file}.tmp`, 0o755); renameSync(`${file}.tmp`, file)
  }
  // `current` is replaced in one step: a new link beside it, renamed over it.
  const link = join(home, 'current'), next = join(home, `current.${process.pid}`)
  rmSync(next, { force: true }); symlinkSync(m.version, next); renameSync(next, link)
  return { from: current, to: m.version, changed: m.version !== current, path: file }
}

/** Once a day, on a terminal: one line on stderr when a newer version is out. Never fails, never waits long. */
export async function noticeIfNewer(env: NodeJS.ProcessEnv, current: string, say: (s: string) => void): Promise<void> {
  if (env.SACLI_NO_UPDATE_CHECK === '1' || env.CI) return
  const f = join(sacliHome(env), 'check.json')
  try {
    let seen: { at: number; latest: string } | null = null
    try { seen = JSON.parse(readFileSync(f, 'utf8')) } catch { /* first time */ }
    if (!seen || Date.now() - seen.at > 86_400_000) {
      const latest = (await manifestOf(env, 'latest', 1_500)).version
      seen = { at: Date.now(), latest }
      mkdirSync(sacliHome(env), { recursive: true }); writeFileSync(f, JSON.stringify(seen))
      if (compareVersions(latest, current) > 0) say(`sacli ${latest} is out (this is ${current}) — sacli upgrade`)
    }
  } catch { /* offline, or no releases yet: say nothing */ }
}
