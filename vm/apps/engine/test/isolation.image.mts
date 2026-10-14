// RUN INSIDE THE ENGINE IMAGE, AS ROOT (docs/connectors-plan.md 1e) — not part of `pnpm test` (it needs the image's
// sa-agent user):  docker run --rm --entrypoint bash <image> -c 'cd /app/apps/engine && pnpm exec tsx test/isolation.image.mts'
// Agents run as sa-agent: they cannot read the environment of a process of the engine's (its keys), cannot write what the
// engine runs (bridges, programs), can write their own HOME and work folders; a session runs in the runner as sa-agent,
// holding neither the engine's key nor the manager's.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

assert.equal(process.getuid?.(), 0, 'run as root, inside the image')
const AGENT = process.env.SA_AGENT_USER ?? 'sa-agent'
const asAgent = (cmd: string) => spawnSync('setpriv', ['--reuid', AGENT, '--regid', 'sa', '--init-groups', 'bash', '-c', cmd], { encoding: 'utf8' })
const ok = (name: string, cond: boolean, detail = '') => { console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`); if (!cond) process.exitCode = 1 }

// 1. A process of the engine's, with a key in its environment: the agent cannot read it.
const engine = spawn('sleep', ['60'], { env: { ...process.env, ICA_KEY: 'sk-proj-secret-of-the-engine' }, stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 300))
const env = asAgent(`cat /proc/${engine.pid}/environ`)
ok("an agent cannot read the engine's environment", env.status !== 0 && !env.stdout.includes('secret-of-the-engine'), env.stderr.trim().split('\n')[0])
engine.kill()

// 2. What the engine runs: not the agent's to change.
mkdirSync('/app/data/datasources', { recursive: true })
const w = asAgent('touch /app/data/datasources/planted.mjs')
ok('an agent cannot plant a bridge', w.status !== 0, w.stderr.trim())

// 3. Its own HOME and a work folder shared with it: its to write.
spawnSync('chown', ['-R', `${AGENT}:sa`, process.env.HOME ?? '/app/data/agent-home'])
ok('an agent writes its own HOME', asAgent('touch "$HOME/.probe" && rm "$HOME/.probe"').status === 0)
const work = mkdtempSync('/app/data/work-')
const { shareWithAgents, agentUser } = await import('../agent-user.ts')
ok('the engine knows its agent user', agentUser?.name === AGENT, JSON.stringify(agentUser))
shareWithAgents(work)
process.umask(0o002)
mkdirSync(join(work, 'out', 'q1'), { recursive: true })   // made later by the engine, inside the shared folder
ok('an agent writes in a folder shared with it, and in what the engine makes there later', asAgent(`touch ${work}/a && touch ${work}/out/q1/b`).status === 0)

// 4. A session runs in the runner, as sa-agent, with no engine key and no manager key.
process.env.ICA_KEY = 'sk-proj-engine'; process.env.SA_MANAGER_KEY = 'm'.repeat(40); process.env.SA_MODEL_KEY = 'sk-proj-m-x'
const { createSession } = await import('../ica/index.ts')
const { runnerSaid } = await import('../ica/runner.ts')
const s = createSession('mock', { cwd: work })
const r = await s.run('who am i')
ok('a session answers from the runner', /who am i/.test(r.lastLines))
for (let i = 0; i < 50 && !runnerSaid(); i++) await new Promise((res) => setTimeout(res, 100))
const said = runnerSaid()
const uid = Number(spawnSync('id', ['-u', AGENT], { encoding: 'utf8' }).stdout.trim())
ok('the runner runs as the agent user', said?.uid === uid, JSON.stringify(said))
ok("the runner holds neither the engine's key nor the manager's", said?.engineKey === false && said?.managerKey === false)
process.exit(process.exitCode ?? 0)
