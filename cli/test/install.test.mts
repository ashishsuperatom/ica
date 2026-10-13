// Installing and upgrading sacli the way someone outside does: cli/install.sh and `sacli upgrade` against a server laid
// out as get.superatom.site serves releases (src/releases.ts) — each version's manifest and files, a `latest` channel.
// Versions are kept side by side, `current` points at the one in use, a tampered download is refused, and a sacli not
// put in place by the installer will not replace itself.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions } from '../src/upgrade.ts'

const cli = join(dirname(fileURLToPath(import.meta.url)), '..')
execFileSync('pnpm', ['build'], { cwd: cli, stdio: 'ignore' })
const bundle = readFileSync(join(cli, 'dist/sacli.mjs'))
const installer = readFileSync(join(cli, 'install.sh'))
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

// The releases: 0.1.0 and 0.2.0 (the same program; what is checked is which file is in use), latest → 0.2.0.
const files: Record<string, Buffer> = {}
let latest = '0.2.0'
let tamper = false
for (const v of ['0.1.0', '0.2.0']) {
  files[`/sacli/${v}/sacli.mjs`] = bundle
  files[`/sacli/${v}/install.sh`] = installer
  files[`/sacli/${v}`] = Buffer.from(JSON.stringify({ product: 'sacli', version: v, at: '2026-10-13T00:00:00Z', files: [{ name: 'sacli.mjs', size: bundle.length, sha256: sha(bundle) }, { name: 'install.sh', size: installer.length, sha256: sha(installer) }] }))
}
const server = createServer((req, res) => {
  const path = (req.url ?? '').replace('/sacli/latest', `/sacli/${latest}`).replace(/^\/sacli\/install\.sh$/, `/sacli/${latest}/install.sh`)
  const body = files[path]
  if (!body) { res.writeHead(404).end('no'); return }
  res.writeHead(200).end(tamper && path.endsWith('sacli.mjs') ? Buffer.concat([body, Buffer.from('\n// changed')]) : body)
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
after(() => server.close())
const GET = `http://127.0.0.1:${(server.address() as { port: number }).port}`

const root = mkdtempSync(join(tmpdir(), 'sa-install-'))
const env = { ...process.env, SACLI_GET: GET, SACLI_HOME: join(root, 'sacli'), SACLI_BIN_DIR: join(root, 'bin'), SACLI_CONFIG: join(root, 'credentials.json'), SACLI_NO_UPDATE_CHECK: '1', HOME: root }
// Run asynchronously: the release server above lives in this process and must keep answering.
function run(cmd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { env }); let stdout = '', stderr = ''
    p.stdout.on('data', (d) => { stdout += d }); p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}
const install = (...args: string[]) => run('sh', ['-c', `curl -fsSL ${GET}/sacli/install.sh | sh -s -- ${args.join(' ')}`])
const sacli = (...args: string[]) => run(join(root, 'bin/sacli'), args)

test('install.sh puts the latest version in place, a launcher on the PATH, and says what to do next', async () => {
  const r = await install()
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /sacli 0\.2\.0 installed/)
  assert.match(r.stdout, /is not on your PATH/)
  assert.match(r.stdout, /sacli login/)
  assert.equal(readlinkSync(join(root, 'sacli/current')), '0.2.0')
  const v = await sacli('--version')
  assert.equal(v.status, 0, v.stderr)
  assert.equal(v.stdout.trim(), JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')).version)
})

test('a given version installs beside the others; sacli upgrade moves to latest and back', async () => {
  assert.equal((await install('0.1.0')).status, 0)
  assert.equal(readlinkSync(join(root, 'sacli/current')), '0.1.0')
  assert.ok(existsSync(join(root, 'sacli/0.2.0/sacli.mjs')))
  const up = await sacli('upgrade')
  assert.equal(up.status, 0, up.stderr)
  assert.equal(readlinkSync(join(root, 'sacli/current')), '0.2.0')
  const back = await sacli('upgrade', '0.1.0', '--json')
  assert.equal(back.status, 0, back.stderr)
  assert.equal(JSON.parse(back.stdout).to, '0.1.0')
  assert.equal(readlinkSync(join(root, 'sacli/current')), '0.1.0')
})

test('a version that is not there, and a download that is not what was published, are refused — nothing changes', async () => {
  const none = await sacli('upgrade', '9.9.9')
  assert.equal(none.status, 1)
  assert.match(none.stderr, /there is no sacli "9\.9\.9"/)
  latest = '0.2.0'; tamper = true
  try {
    rmVersion('0.2.0')
    const bad = await sacli('upgrade')
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /sha256 differs/)
    assert.equal(readlinkSync(join(root, 'sacli/current')), '0.1.0')
    const badInstall = await install()
    assert.notEqual(badInstall.status, 0)
    assert.match(badInstall.stderr, /not what was published/)
    assert.equal(readlinkSync(join(root, 'sacli/current')), '0.1.0')
  } finally { tamper = false }
})

test('a sacli not put in place by the installer will not replace itself, and says how to install', async () => {
  const r = await run('node', [join(cli, 'dist/sacli.mjs'), 'upgrade'])
  assert.equal(r.status, 1)
  assert.match(r.stderr, /was not installed by the installer/)
  assert.match(r.stderr, /sacli\/install\.sh \| sh/)
})

test('versions compare as numbers', () => {
  assert.equal(compareVersions('0.10.0', '0.9.1'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.2.1'), -1)
})

function rmVersion(v: string) { spawnSync('rm', ['-rf', join(root, 'sacli', v)]) }
