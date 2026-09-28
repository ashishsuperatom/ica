// Open every view as it starts — or with filters — in one process, the way the engine runs the application, and write
// each answer to app/runs/<focus>.json with a one-line verdict. A view that refuses or errors is a failure here, not a
// surprise for a person.
//
//   cd <repo>/vm/apps/engine && pnpm exec tsx <project>/app/server/run-all.mjs [focus[:dim=value,…] …]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(HERE, '..', '..')
const RUNS = join(PROJECT, 'app', 'runs')
mkdirSync(RUNS, { recursive: true })
const env = Object.fromEntries(readFileSync(join(PROJECT, '.env'), 'utf8').split('\n').map((l) => l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]]))
const { placeForRunning } = await import(`${process.cwd()}/knowledge.ts`)
const { handle } = await import('./index.mjs')
let last = null
const ctx = { project: env.ICA_PROJECT, projectDir: PROJECT, who: 'run-all', reply: (msg) => { last = msg },
  domain: (name) => placeForRunning(PROJECT, name, join(PROJECT, 'app', '.domains', name.toLowerCase().replace(/[^a-z0-9]+/g, '-')), env.DATASOURCE_URL),
  sources: async () => (await (await fetch(`${env.DATASOURCE_URL}/sources`)).json()).sources ?? [] }

await handle({ t: 'app:catalog' }, ctx)
const catalog = last
console.log(`${catalog.capabilities.length} views · problems: ${catalog.problems.length ? '\n  ' + catalog.problems.join('\n  ') : 'none'}`)
writeFileSync(join(RUNS, 'catalog.json'), JSON.stringify(catalog, null, 2))
await handle({ t: 'app:about' }, ctx)
writeFileSync(join(RUNS, 'about.json'), JSON.stringify(last, null, 2))
const asked = process.argv.slice(2)
const specs = asked.length ? asked : catalog.capabilities.map((c) => c.focus)
for (const spec of specs) {
  const [focus, filters] = spec.split(':')
  const where = (filters ?? '').split(',').filter(Boolean).map((f) => { const [dim, ...v] = f.split('='); return { dim, op: 'is', value: v.join('=').includes('|') ? v.join('=').split('|') : v.join('='), label: v.join('=') } })
  const t0 = Date.now()
  await handle({ t: 'app:start', focus, ...(where.length ? { where } : {}) }, ctx)
  const a = last, ms = Date.now() - t0
  writeFileSync(join(RUNS, `${focus}${filters ? '.' + filters.replace(/[^a-z0-9]+/gi, '-') : ''}.json`), JSON.stringify(a, null, 2))
  const kpis = a.blocks?.find((b) => b.type === 'kpis')?.items?.map((i) => `${i.label} ${typeof i.value === 'number' ? Math.round(i.value * 100) / 100 : i.value}`).join(' · ')
  const tables = a.blocks?.filter((b) => b.type === 'table').map((b) => `${b.rows.length}${b.page ? ` of ${b.page.total}` : ''}`).join(', ')
  console.log(a.t === 'app:answer'
    ? `ok    ${spec.padEnd(34)} ${String(ms).padStart(6)} ms  ${a.asked.length} runs · ${a.words || '(no filters)'} · ${kpis ?? ''} · tables ${tables || '—'}${a.notes.length ? `\n        notes: ${a.notes.join(' | ')}` : ''}`
    : `FAIL  ${spec.padEnd(34)} ${String(ms).padStart(6)} ms  ${a.t}: ${a.reason ?? a.error}`)
}
process.exit(0)
