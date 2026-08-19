// Build a portable zip to deploy the engine on an Ubuntu host (see deploy/linux/README.md).
//   node deploy/linux/build-zip.mjs
// It stages the workspace SOURCE (the pnpm-workspace members + root config) plus the deploy scripts,
// EXCLUDING node_modules, generated state, DBs, and any secret (.env / .pem), then zips it into dist/.
// Nothing secret or project-specific goes in — the target fills .env and connects its own data source.
import { cp, mkdir, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))          // deploy/linux
const REPO = join(HERE, '..', '..')                          // repo root
const VM = join(REPO, 'vm')                                  // the monorepo
const OUT = join(REPO, 'dist')
const STAGE = join(OUT, 'superatom-engine-linux')

// Never copy these — dependency trees, generated state, DBs, VCS, or secrets.
const EXCLUDE_DIRS = new Set(['node_modules', '.state', '.data', '.agent-workspace', '.ica-workspace', '.datasources', 'dist', 'out', '.git'])
const isSecretOrDb = (n) => /\.(sqlite|sqlite-wal|sqlite-shm|pem)$/.test(n) || n === '.env' || n === '.DS_Store'
const filter = (src) => {
  const b = basename(src)
  return !EXCLUDE_DIRS.has(b) && !isSecretOrDb(b)
}

async function main() {
  await rm(STAGE, { recursive: true, force: true })
  await mkdir(STAGE, { recursive: true })

  // 1. root workspace config (needed by pnpm install)
  for (const f of ['package.json', 'pnpm-workspace.yaml', '.npmrc', 'pnpm-lock.yaml']) {
    await cp(join(VM, f), join(STAGE, f))
  }
  // 2. the pnpm-workspace MEMBERS (packages/*, apps/engine, apps/datasources/manager)
  await cp(join(VM, 'packages'), join(STAGE, 'packages'), { recursive: true, filter })
  await mkdir(join(STAGE, 'apps', 'datasources'), { recursive: true })
  await cp(join(VM, 'apps', 'engine'), join(STAGE, 'apps', 'engine'), { recursive: true, filter })
  await cp(join(VM, 'apps', 'datasources', 'manager'), join(STAGE, 'apps', 'datasources', 'manager'), { recursive: true, filter })
  // 3. the deploy scripts, at the zip root
  for (const f of ['setup.sh', 'run.sh', '.env.example', 'README.md']) {
    await cp(join(HERE, f), join(STAGE, f))
  }

  // 4. zip it (system `zip` — no npm dependency). Stamp with a wall-clock time.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const zip = join(OUT, `superatom-engine-linux-${stamp}.zip`)
  execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: STAGE })
  await rm(STAGE, { recursive: true, force: true })

  const sizeMb = (execFileSync('du', ['-m', zip]).toString().split('\t')[0])
  console.log(`Built ${zip}  (~${sizeMb} MB)`)
  console.log('Deploy: copy to an Ubuntu host, unzip, ./setup.sh, fill .env, claude login, ./run.sh')
}
main().catch((e) => { console.error(e); process.exit(1) })
