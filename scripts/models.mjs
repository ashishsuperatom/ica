#!/usr/bin/env node
// The platform's model list (control-plane/shared/models.json): the only models agents may run. Nothing is fetched online
// — a model is in the list because it was put there, with its full description copied from a pi login on this machine
// (~/.pi/agent/models-store.json, where pi keeps what each provider serves). The list is deployed with the platform, and
// every engine receives it through its project (the hash in its hello, the list in the welcome when it differs).
//
//   pnpm models list
//   pnpm models add <provider>/<model>… [--from <models-store.json>]   copied from pi's description of each
//   pnpm models add <provider>/<model>… --plain        a provider whose own CLI runs the model (claude-code): its name only
//   pnpm models remove <provider>/<model>…

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'control-plane', 'shared', 'models.json')

/** The list's hash: of its providers, as written (sorted), so the same list is the same hash wherever it is computed. */
export function hashOf(providers) {
  const sorted = Object.fromEntries(Object.keys(providers).sort().map((p) => [p, [...providers[p]].sort((a, b) => a.id.localeCompare(b.id))]))
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex')
}
const read = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { hash: '', providers: {} })
function write(list) {
  const providers = Object.fromEntries(Object.keys(list.providers).sort().filter((p) => list.providers[p].length).map((p) => [p, [...list.providers[p]].sort((a, b) => a.id.localeCompare(b.id))]))
  writeFileSync(FILE, JSON.stringify({ note: 'The platform\'s model list — only these models run. Changed with `pnpm models add|remove`, never by hand (the hash is checked).', hash: hashOf(providers), providers }, null, 2) + '\n')
}

const [cmd, target, ...rest] = process.argv.slice(2)
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined }
const list = read()
if (cmd === 'list' || !cmd) {
  for (const [p, models] of Object.entries(list.providers)) for (const m of models) console.log(`${p}/${m.id}\t${m.api}\tcontext ${m.contextWindow ?? '?'}`)
  console.log(`hash ${list.hash || '(none)'}`)
} else if (cmd === 'add' || cmd === 'remove') {
  const targets = [target, ...rest.filter((x, i) => !x.startsWith('--') && !(i > 0 && rest[i - 1] === '--from'))].filter(Boolean)
  if (!targets.length) { console.error(`which model? pnpm models ${cmd} <provider>/<model>…`); process.exit(2) }
  const from = flag('from') ?? join(homedir(), '.pi', 'agent', 'models-store.json')
  const store = cmd === 'add' && !rest.includes('--plain') ? (existsSync(from) ? JSON.parse(readFileSync(from, 'utf8')) : null) : null
  if (cmd === 'add' && !rest.includes('--plain') && !store) { console.error(`there is no ${from} — log in with pi on this machine (pi → /login), or name a file with --from`); process.exit(1) }
  for (const t of targets) {
    const m = /^([\w.-]+)\/(.+)$/.exec(t)
    if (!m) { console.error(`${t}: write <provider>/<model>`); process.exit(2) }
    const [, provider, id] = m
    const models = (list.providers[provider] ??= [])
    if (cmd === 'remove') {
      if (!models.some((x) => x.id === id)) { console.error(`${provider}/${id} is not in the list`); process.exit(1) }
      list.providers[provider] = models.filter((x) => x.id !== id)
    } else {
      const found = store ? (store[provider]?.models ?? []).find((x) => x.id === id) : { id }
      if (!found) { console.error(`${from} has no ${provider}/${id} (it has: ${(store[provider]?.models ?? []).map((x) => x.id).join(', ') || 'nothing for ' + provider})`); process.exit(1) }
      list.providers[provider] = [...models.filter((x) => x.id !== id), found]
    }
  }
  write(list)
  console.log(`${cmd === 'add' ? 'added' : 'removed'} ${targets.join(', ')} — hash ${read().hash}`)
} else { console.error('pnpm models list | add <provider>/<model> | remove <provider>/<model>'); process.exit(2) }
