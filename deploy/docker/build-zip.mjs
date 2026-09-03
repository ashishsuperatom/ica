// Build a portable Docker deploy zip (see deploy/docker/README.md).
//   node deploy/docker/build-zip.mjs
// Stages the Dockerfile + the workspace SOURCE (under vm/, matching the Dockerfile's COPY paths) + the
// docker-compose deploy files, EXCLUDING node_modules / state / DBs / secrets, then zips into dist/.
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
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
  // 2. the compose + deploy files at the root (+ the VERSION, so the artifact carries its own version)
  for (const f of ['docker-compose.yml', 'deploy.sh', '.env.example', 'README.md']) await cp(join(HERE, f), join(STAGE, f))
  await cp(join(REPO, 'deploy', 'VERSION'), join(STAGE, 'VERSION'))
  // 3. the workspace SOURCE under vm/ (the Dockerfile COPYs vm/package.json, vm/packages/, vm/apps/, vm/docker/start.sh)
  for (const f of ['package.json', 'pnpm-workspace.yaml', '.npmrc', 'pnpm-lock.yaml']) await cp(join(VM, f), join(STAGE, 'vm', f))
  await cp(join(VM, 'packages'), join(STAGE, 'vm', 'packages'), { recursive: true, filter })
  await cp(join(VM, 'apps', 'engine'), join(STAGE, 'vm', 'apps', 'engine'), { recursive: true, filter })
  await cp(join(VM, 'apps', 'datasources', 'manager'), join(STAGE, 'vm', 'apps', 'datasources', 'manager'), { recursive: true, filter })
  await cp(join(VM, 'docker', 'start.sh'), join(STAGE, 'vm', 'docker', 'start.sh'))

  const VERSION = readFileSync(join(REPO, 'deploy', 'VERSION'), 'utf8').trim()
  const zip = join(OUT, `sa-engine-docker-${VERSION}.zip`)
  // ── NOTHING OF ONE PROJECT'S MAY SHIP ────────────────────────────────────
  // This image is the PRODUCT, and the laptop that builds it is a test bench: it has a project connected, a
  // datasource pointed at someone's live data, credentials, and a state directory full of what that project
  // has learned. None of it belongs in an artifact that goes to a customer's machine.
  //
  // Staging is already explicit — apps, packages, docker, and nothing else — so this is not fixing a leak. It
  // is making sure the next person to add a `cp` here cannot cause one without being told. A build that would
  // ship a secret should fail, not warn: a warning in a hundred lines of build output is not read.
  const offenders = []
  const scan = (dir, rel = '') => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { scan(join(dir, e.name), r); continue }
      // A project's own directory, anything holding state, and any shape a credential takes.
      if (/(^|\/)projects\//.test(r) || /(^|\/)\.state\//.test(r) || /(^|\/)\.env$/.test(r)
          || /\.(pem|key|p12|sqlite|sqlite-wal|sqlite-shm)$/.test(r) || /(^|\/)auth\.json$/.test(r)
          || /(^|\/)registry\.json$/.test(r)) offenders.push(r)
    }
  }
  scan(STAGE)
  if (offenders.length) {
    console.error('\nREFUSING TO BUILD — these belong to a project or are secrets, and must never ship:')
    for (const o of offenders.slice(0, 20)) console.error('  ' + o)
    console.error('\nThe image carries CODE. A project is connected by its .env at deploy time, and its data\n' +
                  'sources are added afterwards through the connector agent.')
    process.exit(1)
  }

  execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: STAGE })
  await rm(STAGE, { recursive: true, force: true })
  const sizeMb = execFileSync('du', ['-m', zip]).toString().split('\t')[0]
  console.log(`Built ${zip}  (~${sizeMb} MB)`)
  console.log('Deploy: copy to a Linux host with Docker, unzip, fill .env, ./deploy.sh')
}
main().catch((e) => { console.error(e); process.exit(1) })
