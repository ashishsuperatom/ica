// sacli engine, with docker and pm2 played by a fake that keeps their state: start runs the same installer a machine runs
// (from the engine's image, the key passed through a private file, never on a command line); a local image starts under
// the same names and labels, keeping the data volume an earlier engine used; containers are found by their labels however
// they were named; stop takes the updater away first; one project never runs two engines; and the native home's .env is
// written with mode 600, its own port and a process name no other home has.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineCommand, localEnv, cleanEnv, dockerEnv, type EngineDeps, type EngineCredentials } from '../src/engine.ts'

const PID = '11111111-2222-3333-4444-555555555555', OTHER = '99999999-2222-3333-4444-555555555555'
const CREDS: EngineCredentials = { project: PID, name: 'Acme Freight', engineKey: 'sk-proj-secret', hub: 'wss://example.test', platform: 'example.test' }

function world(o: { dockerUp?: boolean; image?: string | null; connected?: boolean } = {}) {
  const homes = mkdtempSync(join(tmpdir(), 'sa-homes-'))
  const repo = mkdtempSync(join(tmpdir(), 'sa-repo-'))
  writeFileSync(join(repo, 'Dockerfile'), 'FROM scratch\n'); writeFileSync(join(repo, 'ecosystem.config.cjs'), '')
  type Box = { role: string; project: string; image: string; state: string; env: string[]; volume: string }
  const s = { containers: new Map<string, Box>(), pm2: [] as string[], connected: o.connected ?? false, calls: [] as string[], said: [] as unknown[], keyFile: '' }
  const deps: EngineDeps = {
    homes, repo, key: 'sak_' + PID + '_' + 'k'.repeat(43), env: { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1' }, sleep: async () => {}, note: () => {},
    say: (_h, d) => s.said.push(d),
    rest: async (_m, path) => {
      s.calls.push(`rest ${path}`)
      if (path.endsWith('/status')) return { connections: s.connected ? [{ type: 'code-engine' }] : [] }
      if (path.endsWith('/engine-credentials')) return CREDS
      if (path.endsWith('/engine-release')) return { desired: null }
      throw new Error(path)
    },
    exec: (cmd, args, x = {}) => {
      s.calls.push(`${cmd} ${args.join(' ')}`)
      if (cmd === 'pm2') {
        assert.ok(!Object.keys(x.env ?? {}).some((k) => k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE'), 'pm2 never inherits a Claude Code session')
        if (args[0] === 'jlist') return { code: 0, out: JSON.stringify(s.pm2.map((n) => ({ name: n, pm2_env: { status: 'online' } }))), err: '' }
        if (args[0] === 'startOrRestart') { for (const n of args[3]!.split(',')) if (!s.pm2.includes(n)) s.pm2.push(n); s.connected = true }
        if (args[0] === 'delete') s.pm2 = s.pm2.filter((n) => n !== args[1])
        return { code: 0, out: '', err: '' }
      }
      const ok = (out = '') => ({ code: 0, out, err: '' })
      if (args[0] === 'info') return { code: o.dockerUp === false ? 1 : 0, out: '27', err: '' }
      if (args[0] === 'ps') { const p = args.find((a) => a.startsWith('label=superatom.project='))!.split('=').pop(); return ok([...s.containers].filter(([, c]) => c.project === p).map(([n, c]) => `${n}|${c.role === 'legacy' ? '' : c.role}`).join('\n')) }
      if (args[0] === 'inspect') {
        const c = s.containers.get(args.at(-1)!); if (!c) return { code: 1, out: '', err: 'no such container' }
        return args[2]!.includes('Mounts') ? ok(c.volume) : ok(`${c.state}|2026-10-08T10:00:00Z|sha256:aaaa|${c.image}`)
      }
      if (args[0] === 'pull') return ok()
      if (args[0] === 'image') return ok('sha256:aaaa')
      if (args[0] === 'run' && args.includes('--rm')) {
        // The installer (apps/updater/install.mjs, tested on its own): it starts the engine and its updater.
        s.keyFile = readFileSync(args[args.indexOf('--env-file') + 1]!, 'utf8')
        s.containers.set('superatom-acme-freight', { role: 'engine', project: PID, image: 'registry', state: 'running', env: [], volume: 'superatom-acme-freight-data' })
        s.containers.set('superatom-acme-freight-updater', { role: 'updater', project: PID, image: 'registry', state: 'running', env: [], volume: '' })
        s.connected = true; return ok()
      }
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1]!, vol = args[args.indexOf('--volume') + 1]!.split(':')[0]!
        s.containers.set(name, { role: 'engine', project: PID, image: args.at(-1)!, state: 'running', env: args.filter((_, i) => args[i - 1] === '--env'), volume: vol }); s.connected = true; return ok('id')
      }
      if (args[0] === 'rm') { s.containers.delete(args.at(-1)!); return ok() }
      if (args[0] === 'stop') { s.containers.get(args.at(-1)!)!.state = 'exited'; s.connected = false; return ok() }
      return ok()
    },
  }
  return { s, deps, homes }
}

test('start runs the installer a machine runs — the key through a private file, never on a command line, gone after', async () => {
  const { s, deps } = world()
  assert.equal(await engineCommand('start', PID, {}, deps), 0)
  assert.ok(s.calls.includes('docker pull -q registry.superatom.ai/superatom-engine:dev'))
  const run = s.calls.find((c) => c.startsWith('docker run --rm'))!
  assert.match(run, /--volume \/var\/run\/docker\.sock:\/var\/run\/docker\.sock --entrypoint node registry\.superatom\.ai\/superatom-engine:dev \/app\/apps\/updater\/install\.mjs$/)
  assert.ok(!s.calls.some((c) => c.includes(deps.key)), 'the key is on no command line')
  assert.match(s.keyFile, new RegExp(`^SUPERATOM_KEY=${deps.key}$`, 'm'))
  assert.ok(!existsSync(run.split('--env-file ')[1]!.split(' ')[0]!), 'the key file is gone')
  assert.ok(!s.calls.some((c) => c.startsWith('docker build')), 'nothing is built on the box')
})

test('a local image (--image) starts under the same names and labels, on the data volume an earlier engine used', async () => {
  const { s, deps } = world()
  s.containers.set(`sa-engine-${PID}`, { role: 'legacy', project: PID, image: 'old', state: 'running', env: [], volume: `sa-engine-${PID}` })
  s.containers.set(`sa-engine-updater-${PID}`, { role: 'legacy', project: PID, image: 'old', state: 'running', env: [], volume: '' })
  assert.equal(await engineCommand('start', PID, { image: 'superatom-engine:mine' }, deps), 0)
  assert.ok(!s.containers.has(`sa-engine-${PID}`) && !s.containers.has(`sa-engine-updater-${PID}`), 'the earlier ones are gone')
  const e = s.containers.get('superatom-acme-freight')!
  assert.equal(e.volume, `sa-engine-${PID}`)
  assert.ok(e.env.includes(`ICA_KEY=${CREDS.engineKey}`) && e.env.includes('SA_ENGINE_IMAGE=superatom-engine:mine'))
  assert.match(s.calls.find((c) => c.startsWith('docker run --detach'))!, /--label superatom\.project=.* --label superatom\.role=engine/)
})

test('stop finds the containers by their labels and takes the updater away first, so a stopped engine stays stopped', async () => {
  const { s, deps } = world()
  await engineCommand('start', PID, {}, deps)
  await engineCommand('stop', PID, {}, deps)
  assert.ok(!s.containers.has('superatom-acme-freight-updater'))
  const i = s.calls.indexOf('docker rm -f superatom-acme-freight-updater'), j = s.calls.indexOf('docker stop superatom-acme-freight')
  assert.ok(i >= 0 && i < j)
  assert.equal(s.containers.get('superatom-acme-freight')!.state, 'exited')
})

test('Docker not running: said so, with --native offered', async () => {
  const { deps } = world({ dockerUp: false })
  await assert.rejects(engineCommand('start', PID, {}, deps), /Docker is not running.*--native/)
})

test('an engine the hub already has from elsewhere is never doubled', async () => {
  const { s, deps } = world({ connected: true })
  await assert.rejects(engineCommand('start', PID, {}, deps), /already has an engine/)
  assert.ok(!s.calls.some((c) => c.includes('engine-credentials')), 'the key is not even fetched')
})

test('--native: the home .env (mode 600, its own port and name), PM2 from the ecosystem; status, logs and stop find it', async () => {
  const { s, deps, homes } = world()
  mkdirSync(join(homes, OTHER)); writeFileSync(join(homes, OTHER, '.env'), 'ICA_PROJECT=x\nPROJECT_NAME=acme-freight\nDATASOURCE_PORT=4021\n')
  assert.equal(await engineCommand('start', PID, { native: true }, deps), 0)
  const file = join(homes, PID, '.env')
  assert.equal(statSync(file).mode & 0o777, 0o600)
  const env = readFileSync(file, 'utf8')
  assert.match(env, /PROJECT_NAME=acme-freight-11111111/)
  assert.match(env, /ICA_KEY=sk-proj-secret/)
  const port = Number(/DATASOURCE_PORT=(\d+)/.exec(env)![1]); assert.ok(port > 4021)
  assert.ok(s.pm2.includes('sa-engine-acme-freight-11111111') && s.pm2.includes('sa-datasources-acme-freight-11111111'))
  // Starting it in Docker now is refused: one engine per project.
  await assert.rejects(engineCommand('start', PID, {}, deps), /already runs here under PM2/)
  await engineCommand('status', PID, {}, deps)
  assert.equal((s.said.at(-1) as any).runs.at, 'native')
  await engineCommand('stop', PID, {}, deps)
  assert.deepEqual(s.pm2, [])
})

test('the native .env keeps what the home had and the port it had', () => {
  const homes = [{ pid: PID, env: { DATASOURCE_PORT: '4030', PROJECT_NAME: 'mine', EXTRA: 'kept' } }]
  const e = localEnv(CREDS, homes, 4030)
  assert.equal(e.EXTRA, 'kept'); assert.equal(e.PROJECT_NAME, 'mine'); assert.equal(e.DATASOURCE_URL, 'http://localhost:4030')
})

test('cleanEnv drops a Claude Code session; dockerEnv names the process by the project', () => {
  assert.deepEqual(cleanEnv({ A: '1', CLAUDE_CODE_X: '2', CLAUDECODE: '1' }), { A: '1' })
  assert.equal(dockerEnv(CREDS).PROJECT_NAME, 'acme-freight')
})

test('engine versions shows what is chosen and running; engine switch <tag> chooses a version', async () => {
  const { s, deps } = world()
  const put: unknown[] = []
  deps.rest = async (m, path, body) => {
    s.calls.push(`rest ${m} ${path}`)
    if (m === 'PUT') { put.push(body); return { ok: true, desired: { digest: 'sha256:' + 'e'.repeat(64) }, delivered: true } }
    return { desired: null, online: true, running: { digest: 'sha256:' + 'e'.repeat(64), build: 'abcdef12', last: { state: 'switched', tag: 'dev-1', at: '2026-10-10T12:00' } }, releases: [{ tag: 'dev-1', digest: 'sha256:' + 'e'.repeat(64), at: '2026-10-10T12:00:00Z' }] }
  }
  assert.equal(await engineCommand('versions', PID, {}, deps), 0)
  assert.equal(await engineCommand('switch', PID, { tag: 'dev-1' }, deps), 0)
  await assert.rejects(() => engineCommand('switch', PID, {}, deps), /switch to which version/)
  assert.deepEqual(put, [{ tag: 'dev-1' }])
})
