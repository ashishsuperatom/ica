// The agent runner (ica/runner.ts, runner-main.ts; docs/connectors-plan.md 1e): a session made where agents run apart
// lives in the runner — a child process — and behaves here as if it were local: a turn's callbacks arrive, what it shows
// is mirrored, a runner that dies is started again and the session made again. The runner is given no engine key, no
// manager key, only the model-only key. (Run as the test's own user; the switch of OS user is checked in the image.)
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SA_RUNNER_TEST = '1'
process.env.ICA_KEY = 'sk-proj-engine'; process.env.SA_MANAGER_KEY = 'm'.repeat(40); process.env.SA_MODEL_KEY = 'sk-proj-m-model'
process.env.ICA_PROJECT = 'p1'; process.env.ICA_CODEX_EFFORT = 'low'
const { createSession } = await import('../ica/index.ts')
const { runnerEnv, runnerPid } = await import('../ica/runner.ts')
const cwd = mkdtempSync(join(tmpdir(), 'runner-'))
after(() => rmSync(cwd, { recursive: true, force: true }))

test('the runner is given the model-only key and the agents\' settings — never the engine\'s key or the manager\'s', () => {
  const env = runnerEnv()
  assert.equal(env.ICA_KEY, undefined); assert.equal(env.SA_MANAGER_KEY, undefined)
  assert.equal(env.SA_MODEL_KEY, 'sk-proj-m-model'); assert.equal(env.ICA_PROJECT, 'p1'); assert.equal(env.ICA_CODEX_EFFORT, 'low')
  assert.equal(env.SA_IN_RUNNER, '1')
})

test('a session in the runner answers, its callbacks arrive here, and what it shows is mirrored', async () => {
  const s = createSession('mock', { cwd })
  const out: string[] = [], events: string[] = []
  const r = await s.run('how many trips', { onOutput: (c) => out.push(c), onEvent: (e) => events.push(String(e.text)) })
  assert.match(r.lastLines, /mock answer for: "how many trips"/)
  assert.equal(out.length, 1); assert.equal(events.length, 1)
  await new Promise((res) => setTimeout(res, 400))   // the mirror is pushed at most every 250ms
  assert.match(s.buffer(), /how many trips/)
  assert.equal(s.busy(), false)
  s.stop()
})

test('a runner that stops is started again, and the session made again on its next use', async () => {
  const s = createSession('mock', { cwd })
  await s.run('first')
  const pid = runnerPid()
  assert.ok(pid, 'a runner is running')
  process.kill(pid!, 'SIGKILL')
  await new Promise((res) => setTimeout(res, 300))
  const r = await s.run('second')
  assert.match(r.lastLines, /second/)
})

test('a turn in flight when the runner dies fails plainly — it does not hang', async () => {
  const s = createSession('mock', { cwd })
  await s.run('warm')
  const pending = s.run('x'.repeat(10))
  process.kill(runnerPid()!, 'SIGKILL')
  await pending.then(() => { /* the mock may answer before the kill lands: fine */ }, (e) => assert.match(String(e.message), /runner stopped/))
})
