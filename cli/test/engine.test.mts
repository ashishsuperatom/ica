// sacli engine, with docker and pm2 played by a fake that keeps their state: where an engine runs is found, start is
// idempotent, a changed image makes the container again on the same volume, one project never runs two engines, and the
// native home's .env is written with mode 600, its own port and a process name no other home has.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { engineCommand, localEnv, cleanEnv, dockerEnv, containerOf, type EngineDeps, type EngineCredentials } from '../src/engine.ts'

const PID = '11111111-2222-3333-4444-555555555555', OTHER = '99999999-2222-3333-4444-555555555555'
const CREDS: EngineCredentials = { project: PID, name: 'Acme Freight', engineKey: 'sk-proj-secret', hub: 'wss://example.test', platform: 'example.test' }

function world(o: { dockerUp?: boolean; image?: string | null; connected?: boolean } = {}) {
  const homes = mkdtempSync(join(tmpdir(), 'sa-homes-'))
  const repo = mkdtempSync(join(tmpdir(), 'sa-repo-'))
  writeFileSync(join(repo, 'Dockerfile'), 'FROM scratch\n'); writeFileSync(join(repo, 'ecosystem.config.cjs'), '')
  const s = { image: o.image === undefined ? 'sha256:aaaaaaaaaaaaaaaaaaaa' : o.image, container: null as null | { image: string; state: string; env: string[] },
    pm2: [] as string[], connected: o.connected ?? false, calls: [] as string[], said: [] as unknown[] }
  const deps: EngineDeps = {
    homes, repo, env: { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDECODE: '1' }, sleep: async () => {}, note: () => {},
    say: (_h, d) => s.said.push(d),
    rest: async (_m, path) => {
      s.calls.push(`rest ${path}`)
      if (path.endsWith('/status')) return { connections: s.connected ? [{ type: 'code-engine' }] : [] }
      if (path.endsWith('/engine-credentials')) return CREDS
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
      if (args[0] === 'info') return { code: o.dockerUp === false ? 1 : 0, out: '27', err: '' }
      if (args[0] === 'image' && args[1] === 'inspect') return s.image ? { code: 0, out: s.image, err: '' } : { code: 1, out: '', err: 'no such image' }
      if (args[0] === 'build') { s.image = 'sha256:bbbbbbbbbbbbbbbbbbbb'; return { code: 0, out: '', err: '' } }
      if (args[0] === 'inspect') return s.container ? { code: 0, out: `${s.container.state}|2026-10-08T10:00:00Z|${s.container.image}`, err: '' } : { code: 1, out: '', err: '' }
      if (args[0] === 'run') { s.container = { image: s.image!, state: 'running', env: args.filter((_, i) => args[i - 1] === '--env') }; s.connected = true; return { code: 0, out: 'id', err: '' } }
      if (args[0] === 'rm') { s.container = null; return { code: 0, out: '', err: '' } }
      if (args[0] === 'stop') { s.container!.state = 'exited'; s.connected = false; return { code: 0, out: '', err: '' } }
      return { code: 0, out: '', err: '' }
    },
  }
  return { s, deps, homes }
}

test('start in Docker: one container and volume per project, with what the platform gave it', async () => {
  const { s, deps } = world()
  assert.equal(await engineCommand('start', PID, {}, deps), 0)
  const run = s.calls.find((c) => c.startsWith('docker run'))!
  assert.match(run, new RegExp(`--name ${containerOf(PID)} --restart unless-stopped --volume ${containerOf(PID)}:/app/data`))
  assert.ok(s.container!.env.includes(`ICA_KEY=${CREDS.engineKey}`) && s.container!.env.includes('ICA_HUB=wss://example.test') && s.container!.env.includes('SUPERATOM_HOME=/app/data'))
  assert.deepEqual(s.said.at(-1), { project: PID, at: 'docker', connected: true })
})

test('start again changes nothing; a new image makes the container again on the same volume', async () => {
  const { s, deps } = world()
  await engineCommand('start', PID, {}, deps)
  s.calls.length = 0
  await engineCommand('start', PID, {}, deps)
  assert.ok(!s.calls.some((c) => c.startsWith('docker run') || c.startsWith('docker rm')), 'nothing made again')
  s.image = 'sha256:cccccccccccccccccccc'
  s.calls.length = 0
  await engineCommand('start', PID, {}, deps)
  assert.ok(s.calls.some((c) => c === `docker rm -f ${containerOf(PID)}`) && s.calls.some((c) => c.startsWith('docker run')))
  assert.equal(s.container!.image, 'sha256:cccccccccccccccccccc')
})

test('no image yet: built from the repo', async () => {
  const { s, deps } = world({ image: null })
  await engineCommand('start', PID, {}, deps)
  assert.ok(s.calls.includes(`docker build -t superatom-engine:local ${deps.repo}`))
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
