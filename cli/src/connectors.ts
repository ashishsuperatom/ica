// sacli connectors — a connector of one's own, built on the laptop with the platform's one build tool
// (connectors/src/bundle.ts: the same source and drivers make the same bytes and hash as anywhere) and published to the
// organisation's registry from a project (docs/connectors-plan.md R3: no approval gate unless the organisation asks).
// esbuild comes from the connector's own folder (its devDependencies, as `init` writes them).

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { bundleConnector, type Built } from '../../connectors/src/bundle.ts'
import { CliError } from './config.ts'

/** Build the connector in `dir` — its esbuild, from its own folder. */
export async function buildConnector(dir: string): Promise<Built & { ok: true }> {
  const at = resolve(dir)
  if (!existsSync(join(at, 'manifest.json'))) throw new CliError(`${dir} is not a connector's folder (no manifest.json) — sacli connectors init <id> makes one`, 2)
  let esbuild: any
  try { esbuild = await import(pathToFileURL(createRequire(join(at, 'package.json')).resolve('esbuild')).href) }
  catch { throw new CliError(`esbuild is not installed in ${dir} — it is in its devDependencies: run pnpm install (or npm install) there`, 2) }
  const b = await bundleConnector(at, { esbuild: esbuild.build ? esbuild : esbuild.default })
  if (!b.ok) throw new CliError(`${basename(at)} did not build:\n${b.problems.map((p) => `  ✗ ${p}`).join('\n')}`, 1)
  return b
}

/** A new connector's folder: an API connector skeleton (plain JavaScript, no dependency) to change. */
export function initConnector(id: string, dir = id): string {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new CliError('a connector\'s id is lower-case letters, digits and dashes', 2)
  const at = resolve(dir)
  if (existsSync(join(at, 'manifest.json'))) throw new CliError(`${dir} has a connector already`, 2)
  mkdirSync(at, { recursive: true })
  writeFileSync(join(at, 'manifest.json'), JSON.stringify({
    id, title: id, icon: 'lucide:plug', kind: 'api', dialect: 'api',
    description: 'What it reaches, in one line.',
    levels: ['project'], identity: ['shared', 'person-key'],
    fields: [
      { name: 'baseUrl', label: 'Base URL', type: 'url', required: true, placeholder: 'https://api.example.com/v1' },
      { name: 'token', label: 'Token', type: 'secret', required: true, help: 'Sent as a bearer token.' },
    ],
  }, null, 2) + '\n')
  writeFileSync(join(at, 'bridge.mjs'), `// The ${id} connector — one kind of connector, run on the engine, one process per connection. createBridge is given the
// connection's settings and secrets (a person's own, for a per-user connection) and answers:
//   ready()               it has what it needs to be tried
//   test()                signed in, a trivial read — say what it reached
//   introspect()          what it offers: its entities as tables (name, columns), and its actions
//   query(text)           a read: JSON naming an entity — {"entity": "orders", "filters": {...}, "limit": 50}
//   act(name, input)      an action (a change runs only when a person confirmed it)
//   close()
export function createBridge({ settings = {}, secrets = {} } = {}) {
  const base = String(settings.baseUrl ?? '').replace(/\\/+$/, '')
  const get = async (path) => {
    const r = await fetch(\`\${base}\${path}\`, { headers: { authorization: \`Bearer \${secrets.token}\`, accept: 'application/json' }, signal: AbortSignal.timeout(60_000) })
    if (!r.ok) throw new Error(r.status === 401 ? 'the token was refused' : \`it answered \${r.status}\`)
    return r.json()
  }
  const entities = [{ name: 'items', columns: [{ name: 'id', type: 'string' }, { name: 'name', type: 'string' }] }]
  return {
    id: '${id}', kind: 'api', dialect: 'api',
    description: 'A query is JSON: {"entity": "items", "limit": n}.',
    ready: () => !!(base && secrets.token),
    test: async () => { await get('/items?limit=1'); return 'it answered' },
    introspect: async () => ({ kind: 'api', dialect: 'api', tables: entities, actions: [] }),
    query: async (text) => {
      const q = JSON.parse(String(text))
      if (q.entity !== 'items') throw new Error(\`there is nothing called "\${q.entity}" to read\`)
      const data = await get(\`/items?limit=\${Math.min(Number(q.limit) || 100, 5000)}\`)
      return Array.isArray(data) ? data : data.items ?? []
    },
    close: () => {},
  }
}
`)
  writeFileSync(join(at, 'package.json'), JSON.stringify({ name: `connector-${id}`, private: true, type: 'module', description: `The ${id} connector: built by sacli connectors build, published by sacli connectors publish.`, dependencies: {}, devDependencies: { esbuild: '^0.25.0' } }, null, 2) + '\n')
  return at
}
