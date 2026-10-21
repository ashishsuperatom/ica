#!/usr/bin/env node
// The platform SDK: what a project's code is written against, for people and their coding agents — types and docs, no
// implementation. `sacli clone` writes it into <project>/platform/; it is released as the product "sdk" at
// get.superatom.site (docs/releases.md, docs/dev-mode.md).
//
//   ui/        @superatom/ui as type declarations, the design system's guide and its CSS (tokens and components)
//   program/   what a program's server side is given (ProgramContext, ProgramServices, the answer it returns)
//   docs/      the program contract (markers, blocks, intents…), the guide for AI agents
//   template/  how a project is built, as working examples (vm/packages/project-template/TEMPLATE.md)
//
//   node scripts/build-sdk.mjs <out.json> [<version>]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const [out, version = 'local'] = process.argv.slice(2)
if (!out) { console.error('usage: build-sdk.mjs <out.json> [<version>]'); process.exit(2) }
const files = {}
const walk = (dir, to, keep = () => true) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, `${to}/${n}`, keep) }
    else if (keep(n)) files[`${to}/${n}`] = readFileSync(p, 'utf8')
  }
}
const declarations = (pkg, to) => {
  const tmp = mkdtempSync(join(tmpdir(), 'sdk-'))
  const project = join(repo, pkg, 'tsconfig.json')
  const args = existsSync(project) ? ['-p', project, '--noEmit', 'false']
    : [join(repo, pkg, 'src/index.ts'), '--target', 'ES2023', '--module', 'ESNext', '--moduleResolution', 'bundler', '--allowImportingTsExtensions', '--strict', '--skipLibCheck', '--types', 'node']
  execFileSync(join(repo, 'vm/node_modules/.bin/tsc'), [...args, '--declaration', '--emitDeclarationOnly', '--outDir', tmp], { stdio: 'inherit', cwd: join(repo, 'vm') })
  walk(tmp, to, (n) => n.endsWith('.d.ts'))
}

declarations('vm/packages/ui', 'ui')
walk(join(repo, 'vm/packages/ui/src/design'), 'ui/design', (n) => n.endsWith('.css') || n.endsWith('.md'))
declarations('vm/packages/state', 'program/state')
files['program/index.d.ts'] = `// What a program is given and returns — import these as types: import type { ProgramContext } from '@superatom/program'
export type { ProgramContext, ProgramServices, FunctionResult, PackageFunction, OptionContext, OptionFunction, Option, Step } from './state/index.js'
`
files['docs/program-contract.md'] = readFileSync(join(repo, 'docs/program-contract.md'), 'utf8')
files['docs/agent.md'] = readFileSync(join(repo, 'cli/agent.md'), 'utf8')
// The template: how a project is built, as working examples (vm/packages/project-template/TEMPLATE.md).
files['template/README.md'] = readFileSync(join(repo, 'vm/packages/project-template/TEMPLATE.md'), 'utf8')
walk(join(repo, 'vm/packages/project-template/start/agent-template'), 'template/agent')
// every program and library the template has — no list to keep: what is in the template is in the SDK
const programs = join(repo, 'vm/packages/project-template/programs/src')
for (const p of readdirSync(programs)) if (statSync(join(programs, p)).isDirectory()) walk(join(programs, p), `template/programs/${p}`)
walk(join(repo, 'vm/packages/project-template/shared/knowledge/shared'), 'template/knowledge-helpers')
files['README.md'] = `# The Superatom platform SDK (${version})

What this project's code is written against — types and docs only; the platform runs everything.

- \`ui/\` — \`@superatom/ui\`, the design system: every component's types (\`ui/src/index.d.ts\`), the guide
  (\`ui/design/DESIGN-SYSTEM.md\`) and its CSS. A program's React side imports \`react\`, \`echarts\`, \`@superatom/ui\`
  (charts: \`EChart\`), its libraries (\`@lib/<name>\`) and any npm package its \`package.json\` lists (\`pnpm install\`,
  then import it as usual — sacli bundles it; \`template/programs/maps\` is an example). A program drawn as a UI of its
  own, the whole width: \`"ui": { "as": "ui" }\` in its manifest.
- \`program/\` — what a program's server side is given: \`import type { ProgramContext } from '@superatom/program'\`.
- \`docs/program-contract.md\` — what a program is and must do: its manifest, functions, the answer (markdown with
  marker lines naming blocks), intents, screens. \`docs/agent.md\` — working with the project through sacli.
- \`template/\` — how a project is built, as working examples: start with \`template/README.md\` (an agent, a program,
  the views library and the program that shows it, an npm package in a library (\`programs/maps\`), knowledge).
- One step to make it live: \`sacli agent push <folder>\` builds, writes and publishes an agent and its programs.

Refreshed by \`sacli pull\`. Never edit it: it is replaced.
`
writeFileSync(out, JSON.stringify({ format: 1, version, files }))
console.error(`sdk ${version}: ${Object.keys(files).length} files, ${(Buffer.byteLength(JSON.stringify(files)) / 1024).toFixed(0)} KB → ${relative(process.cwd(), out)}`)
