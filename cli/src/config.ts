// Where sacli keeps its credentials: one file, readable only by its owner, a profile per key.
//   $SACLI_CONFIG, else $XDG_CONFIG_HOME/superatom/credentials.json, else ~/.config/superatom/credentials.json
// An agent key in $SACLI_KEY is used as given and never written anywhere.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface Profile { key: string; hub: string; savedAt: string }
export interface Credentials { default?: string; profiles: Record<string, Profile> }

export const DEFAULT_HUB = 'wss://superatom.site'

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SACLI_CONFIG) return env.SACLI_CONFIG
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'superatom', 'credentials.json')
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  const f = configPath(env)
  if (!existsSync(f)) return { profiles: {} }
  // A credentials file others can read is a leaked key: say so, every time, until it is fixed.
  try { if ((statSync(f).mode & 0o077) !== 0) process.stderr.write(`sacli: warning: ${f} can be read by others — run: chmod 600 ${f}\n`) } catch { /* not on this platform */ }
  try { const c = JSON.parse(readFileSync(f, 'utf8')); return { default: c.default, profiles: c.profiles ?? {} } }
  catch { throw new CliError(`${f} is not valid JSON — fix or remove it, then sacli login again`, 2) }
}

export function writeCredentials(c: Credentials, env: NodeJS.ProcessEnv = process.env): string {
  const f = configPath(env)
  mkdirSync(dirname(f), { recursive: true, mode: 0o700 })
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, f)
  chmodSync(f, 0o600)
  return f
}

/** The project a key names, or null. */
export const projectOfKey = (key: string): string | null => /^sak_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/.exec(key)?.[1] ?? null
/** A key as it may be shown: its prefix and the last four characters. */
export const maskKey = (key: string) => `${key.slice(0, 47)}…${key.slice(-4)}`

export class CliError extends Error {
  constructor(message: string, public code = 1) { super(message) }
}

/** The profile a folder names: the nearest .sacli.json going up from `dir` ({ "profile": "<name>" }), or null. */
export function folderProfile(dir: string): { profile: string; file: string } | null {
  for (let d = dir; ; d = dirname(d)) {
    const f = join(d, '.sacli.json')
    if (existsSync(f)) {
      try { const c = JSON.parse(readFileSync(f, 'utf8')); if (typeof c.profile === 'string' && c.profile) return { profile: c.profile, file: f } } catch { /* ignored */ }
    }
    if (dirname(d) === d) return null
  }
}
