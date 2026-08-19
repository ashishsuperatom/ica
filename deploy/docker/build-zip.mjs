// Build a portable Docker deploy zip (see deploy/docker/README.md).
//   node deploy/docker/build-zip.mjs
// Stages the Dockerfile + the workspace SOURCE (under vm/, matching the Dockerfile's COPY paths) + the
// docker-compose deploy files, EXCLUDING node_modules / state / DBs / secrets, then zips into dist/.
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))          // deploy/docker
const REPO = join(HERE, '..', '..')                          // repo root
const VM = join(REPO, 'vm')
const OUT = join(REPO, 'dist')
const STAGE = join(OUT, 'superatom-engine-docker')

const EXCLUDE_DIRS = new Set(['node_modules', '.state', '.data', '.agent-workspace', '.ica-workspace', '.datasources', 'dist', 'out', '.git'])
const isSecretOrDb = (n) => /\.(sqlite|sqlite-wal|sqlite-shm|pem)$/.test(n) || n === '.env' || n === '.DS_Store'
const filter = (src) => { const b = basename(src); return !EXCLUDE_DIRS.has(b) && !isSecretOrDb(b) }

async function main() {
  await rm(STAGE, { recursive: true, force: true })
  await mkdir(join(STAGE, 'vm', 'apps', 'datasources'), { recursive: true })
  await mkdir(join(STAGE, 'vm', 'docker'), { recursive: true })

  // 1. the Dockerfile (+ .dockerignore) at the build-context root
  await cp(join(REPO, 'Dockerfile'), join(STAGE, 'Dockerfile'))
  if (existsSync(join(REPO, '.dockerignore'))) await cp(join(REPO, '.dockerignore'), join(STAGE, '.dockerignore'))
  // 2. the compose + deploy files at the root
  for (const f of ['docker-compose.yml', 'deploy.sh', '.env.example', 'README.md']) await cp(join(HERE, f), join(STAGE, f))
  // 3. the workspace SOURCE under vm/ (the Dockerfile COPYs vm/package.json, vm/packages/, vm/apps/, vm/docker/start.sh)
  for (const f of ['package.json', 'pnpm-workspace.yaml', '.npmrc', 'pnpm-lock.yaml']) await cp(join(VM, f), join(STAGE, 'vm', f))
  await cp(join(VM, 'packages'), join(STAGE, 'vm', 'packages'), { recursive: true, filter })
  await cp(join(VM, 'apps', 'engine'), join(STAGE, 'vm', 'apps', 'engine'), { recursive: true, filter })
  await cp(join(VM, 'apps', 'datasources', 'manager'), join(STAGE, 'vm', 'apps', 'datasources', 'manager'), { recursive: true, filter })
  await cp(join(VM, 'docker', 'start.sh'), join(STAGE, 'vm', 'docker', 'start.sh'))

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const zip = join(OUT, `superatom-engine-docker-${stamp}.zip`)
  execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: STAGE })
  await rm(STAGE, { recursive: true, force: true })
  const sizeMb = execFileSync('du', ['-m', zip]).toString().split('\t')[0]
  console.log(`Built ${zip}  (~${sizeMb} MB)`)
  console.log('Deploy: copy to a Linux host with Docker, unzip, fill .env, ./deploy.sh')
}
main().catch((e) => { console.error(e); process.exit(1) })
