// sacli clone [<folder>] and sacli pull: the project as one folder — what everyone sees (the published version), and
// everything needed to change it and understand it, never data (docs/dev-mode.md):
//
//   superatom.json      the project, the hub, what was cloned (versions, and each file's hash, so pull sees local edits)
//   AGENTS.md           how to work here, for people and coding agents; this project's agents, programs and libraries
//   map.json · knowledge/ · agents/<name>.json · programs/<name>/ (every program and library, its source)
//   platform/           the platform SDK: types and docs (@superatom/ui, @superatom/program, the contract, a template)
//   package.json · tsconfig.json   so every import resolves and `pnpm typecheck` works

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { CliError } from './config.ts'

export interface ProjectSnapshot {
  project: string
  graph: string
  knowledge: { source: string; files: Record<string, string> }
  agents: { name: string; scope: string; body: Record<string, unknown> }[]
  map: unknown
  programs: { name: string; hash: string; version: number; kind: 'program' | 'library'; files: Record<string, string> | null }[]
  sdk: { version: string; files: Record<string, string> } | null
}

export interface CloneRecord {
  project: string; hub: string; graph: string; sdk: string | null; at: string
  programs: Record<string, { hash: string; version: number }>
  /** Each file this folder was written with, by its sha256: what `pull` compares with to find local edits. */
  files: Record<string, string>
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const firstLine = (doc: string | undefined) => (doc ?? '').split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''

/** Every file a snapshot writes, by its path in the folder. */
export function filesOf(s: ProjectSnapshot, hub: string): Record<string, string> {
  const out: Record<string, string> = {}
  out['knowledge/index.mts'] = s.knowledge.source
  for (const [name, text] of Object.entries(s.knowledge.files)) out[`knowledge/${name}`] = text
  for (const a of s.agents) out[`agents/${a.name}.json`] = JSON.stringify({ name: a.name, ...(a.scope !== 'global' ? { scope: a.scope } : {}), ...a.body }, null, 2) + '\n'
  if (s.map) out['map.json'] = JSON.stringify(s.map, null, 2) + '\n'
  for (const p of s.programs) for (const [rel, text] of Object.entries(p.files ?? {})) out[`programs/${p.name}/${rel}`] = text
  for (const [rel, text] of Object.entries(s.sdk?.files ?? {})) out[`platform/${rel}`] = text
  out['package.json'] = JSON.stringify({ name: `superatom-${s.project.slice(0, 8)}`, private: true, type: 'module',
    scripts: { typecheck: 'tsc --noEmit -p tsconfig.json && tsc --noEmit -p tsconfig.server.json' },
    devDependencies: { typescript: '^5.6.0', '@types/react': '^19.0.0', '@types/react-dom': '^19.0.0', '@types/node': '^22.0.0', echarts: '^5.5.0' } }, null, 2) + '\n'
  // A library's @lib/<name> is its web/ on the React side and its server/ on the Node side: one config for each.
  const libs = s.programs.filter((p) => p.kind === 'library').map((p) => p.name)
  const config = (side: 'web' | 'server') => JSON.stringify({
    compilerOptions: { target: 'ES2023', lib: side === 'web' ? ['ES2023', 'DOM', 'DOM.Iterable'] : ['ES2023'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
      ...(side === 'server' ? { types: ['node'] } : {}),
      paths: { '@superatom/ui': ['./platform/ui/src/index.d.ts'], '@superatom/program': ['./platform/program/index.d.ts'],
        ...Object.fromEntries(libs.flatMap((l) => [[`@lib/${l}`, [`./programs/${l}/${side}/index.ts`, `./programs/${l}/${side}/index.tsx`]], [`@lib/${l}/*`, [`./programs/${l}/${side}/*`]]])) } },
    include: [`programs/*/${side}/**/*.ts`, `programs/*/${side}/**/*.tsx`],
  }, null, 2) + '\n'
  out['tsconfig.json'] = config('web')
  out['tsconfig.server.json'] = config('server')
  out['AGENTS.md'] = agentsMd(s, hub)
  out['.gitignore'] = 'node_modules/\n'   // a clone is an ordinary folder: keep it in git (or anything) if you like
  return out
}

function agentsMd(s: ProjectSnapshot, hub: string): string {
  const docOf = (p: ProjectSnapshot['programs'][number]) => firstLine(p.files?.['doc.md'])
  const programs = s.programs.filter((p) => p.kind === 'program'), libs = s.programs.filter((p) => p.kind === 'library')
  return `# This Superatom project

Cloned by \`sacli clone\` from ${hub} — the project's **published** version (${s.graph}). Read \`platform/README.md\` and
\`platform/docs/program-contract.md\` before changing a program; \`platform/docs/agent.md\` for working through sacli.

## What is here

- \`agents/<name>.json\` — each agent: its domain (knowledge), the programs it runs, its tools, how it looks.
- \`programs/<name>/\` — each program's source: \`manifest.json\`, \`doc.md\`, \`server/\` (Node: its functions, data only
  through \`ctx.services.query\`), \`web/\` (React: one component per view block, built from \`@superatom/ui\`).
  A library (\`"kind": "library"\`) holds shared functions and components, imported as \`@lib/<name>\`.
- \`knowledge/index.mts\` — the project's knowledge (concepts, domains): the only place it is written.
- \`map.json\` — what people see to find their way, and which agent is the front page (\`home\`).
- \`platform/\` — the platform's types and docs, read-only, replaced by \`sacli pull\`.

## The rules

- Everyone sees what is **published**. Nothing you change here is seen by anyone until it is published.
- Data never comes here: programs run on the project's engine, next to the data, as the person asking.
- Start from what is live: \`sacli pull\` before changing anything.
- \`pnpm install && pnpm typecheck\` checks every program against the platform's types.

## Agents
${s.agents.map((a) => `- **${a.name}** — ${String((a.body as any).title ?? '')}${(a.body as any).says ? `: ${(a.body as any).says}` : ''} · programs: ${((a.body as any).programs ?? []).join(', ') || 'none'}`).join('\n') || '- none'}
${s.map && (s.map as any).home ? `\nThe front page is the agent **${(s.map as any).home}**.\n` : ''}
## Programs
${programs.map((p) => `- **${p.name}** v${p.version}${p.files ? '' : ' (built before sources were kept — compiled only, not here)'} — ${docOf(p)}`).join('\n') || '- none'}

## Libraries
${libs.map((p) => `- **@lib/${p.name}** v${p.version} — ${docOf(p)} (read \`programs/${p.name}/doc.md\`)`).join('\n') || '- none'}
`
}

/** Write a snapshot into an empty folder; returns the record kept in superatom.json. */
export function writeClone(dir: string, s: ProjectSnapshot, hub: string): CloneRecord {
  if (existsSync(dir) && readdirSync(dir).length) throw new CliError(`${dir} is not empty — clone into a new folder (or run sacli pull inside a clone)`, 1)
  return writeFiles(dir, s, hub)
}

function writeFiles(dir: string, s: ProjectSnapshot, hub: string): CloneRecord {
  const files = filesOf(s, hub)
  for (const [rel, text] of Object.entries(files)) { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text) }
  const record: CloneRecord = { project: s.project, hub, graph: s.graph, sdk: s.sdk?.version ?? null, at: new Date().toISOString(),
    programs: Object.fromEntries(s.programs.map((p) => [p.name, { hash: p.hash, version: p.version }])),
    files: Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, sha(text)])) }
  writeFileSync(join(dir, 'superatom.json'), JSON.stringify(record, null, 2) + '\n')
  return record
}

/** The clone a folder is (it or a folder above holding superatom.json). */
export function cloneAt(from: string): { dir: string; record: CloneRecord } | null {
  for (let d = from; ; d = dirname(d)) {
    const f = join(d, 'superatom.json')
    if (existsSync(f)) return { dir: d, record: JSON.parse(readFileSync(f, 'utf8')) as CloneRecord }
    if (dirname(d) === d) return null
  }
}

/** Files changed here since the clone (or the last pull): edited, added, removed. platform/ is never counted. */
export function localChanges(dir: string, record: CloneRecord): { edited: string[]; added: string[]; removed: string[] } {
  const now = new Map<string, string>()
  const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const rel = relative(dir, p); if (/^(node_modules|platform|\.git)(\/|$)/.test(rel) || rel === 'superatom.json' || rel === 'pnpm-lock.yaml') continue; if (statSync(p).isDirectory()) walk(p); else now.set(rel, sha(readFileSync(p, 'utf8'))) } }
  walk(dir)
  const was = Object.entries(record.files).filter(([rel]) => !rel.startsWith('platform/'))
  return {
    edited: was.filter(([rel, h]) => now.has(rel) && now.get(rel) !== h).map(([rel]) => rel),
    removed: was.filter(([rel]) => !now.has(rel)).map(([rel]) => rel),
    added: [...now.keys()].filter((rel) => !(rel in record.files)),
  }
}

/** Bring a clone up to what is published: refused over local changes unless `force`. */
export function pullInto(dir: string, record: CloneRecord, s: ProjectSnapshot, force = false): { record: CloneRecord; changed: string[] } {
  const local = localChanges(dir, record)
  const mine = [...local.edited, ...local.added, ...local.removed]
  if (mine.length && !force) throw new CliError(`${mine.length} local change${mine.length === 1 ? '' : 's'} would be lost: ${mine.slice(0, 6).join(', ')}${mine.length > 6 ? ', …' : ''} — keep them elsewhere first, or sacli pull --force`, 1)
  const next = filesOf(s, record.hub)
  const changed = [...new Set([...Object.keys(next), ...Object.keys(record.files)])].filter((rel) => sha(next[rel] ?? '') !== (record.files[rel] ?? sha('')))
  for (const rel of Object.keys(record.files)) if (!(rel in next)) rmSync(join(dir, rel), { force: true })
  for (const rel of local.added) if (!(rel in next) && force) rmSync(join(dir, rel), { force: true })
  return { record: writeFiles(dir, s, record.hub), changed }
}
