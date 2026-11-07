// Every tool an agent is given is a script written into its folder from a template — one that does not parse leaves
// every agent without it (it happened: an apostrophe in a quoted string broke get-schema everywhere). Each is written
// here and checked to parse.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

test('every tool written into an agent\'s folder parses', async () => {
  const { prepareWorkspace } = await import('../ica/workspace.ts')
  const root = mkdtempSync(join(tmpdir(), 'tools-'))
  try {
    for (const tools of ['conversation', 'shared'] as const) {
      const dir = await prepareWorkspace({ root, projectId: 'p1', sessionId: `s-${tools}`, tools })
      const scripts = readdirSync(join(dir, '.tools')).filter((f) => f.endsWith('.mjs'))
      assert.ok(scripts.length >= 4, `${tools}: ${scripts.join(', ')}`)
      for (const f of scripts) {
        try { execFileSync(process.execPath, ['--check', join(dir, '.tools', f)], { stdio: 'pipe' }) }
        catch (e: any) { assert.fail(`${tools}: .tools/${f} does not parse: ${String(e.stderr ?? e.message).split('\n').slice(0, 4).join(' ')}`) }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the knowledge tools ask the engine, never its files: answered for a ticket the engine signed, refused without one; find-intent only during its turn', async () => {
  const { prepareWorkspace } = await import('../ica/workspace.ts')
  const { serveTools, toolSocketOf } = await import('../tool-socket.ts')
  const { agentTools, hiddenBy } = await import('../agent-tools.ts')
  const { DataSourceIndex } = await import('@superatom/datasource-index')
  const { writeFileSync } = await import('node:fs')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const root = mkdtempSync(join(tmpdir(), 'tk-'))
  const home = join(root, 'p1')
  const tools = serveTools(toolSocketOf(home), { verify: (raw: string) => { if (raw !== 'good') throw new Error('your data access ticket is not valid'); return { raw, policies: { SRC: [{ deny: true, table: 'secret' }] } } } })
  try {
    for (const [name, fn] of Object.entries(agentTools({ index: new DataSourceIndex(join(root, 'index.sqlite')), graphFile: join(root, 'none.sqlite'), manager: 'http://127.0.0.1:9' }))) tools.serve(name, fn as any)
    const dir = await prepareWorkspace({ root, projectId: 'p1', sessionId: 's1', tools: 'conversation' })
    const run = (tool: string, ...a: string[]) => promisify(execFile)(join(dir, tool), a, { cwd: dir, env: { PATH: process.env.PATH ?? '' } }).then((r) => r.stdout, (e) => `refused: ${String(e.stderr).trim()}`)
    writeFileSync(join(dir, '.ticket'), 'good')
    assert.match(await run('find-concept', 'stock value'), /"note":\s*"the knowledge is not here yet"/)
    assert.match(await run('find-schema', 'vendor'), /"matched":\s*0/)
    assert.match(await run('get-schema', 'SRC', 'secret'), /^refused: you are not allowed to read secret/)
    writeFileSync(join(dir, '.ticket'), 'forged')
    assert.match(await run('find-concept', 'stock value'), /^refused: your data access ticket is not valid/)
    assert.deepEqual([...hiddenBy({ SRC: [{ deny: true, table: 'dbo.secret' }, { table: 'open' }] })], ['src.secret'])
  } finally { tools.close(); rmSync(root, { recursive: true, force: true }) }
})

test('a session\'s agent is given its role\'s tools only: the composer is refused find-concept, the analyst is not; work for no agent goes by its ticket', async () => {
  const { refusedFor } = await import('../agent-tools.ts')
  const roles: Record<string, string[]> = { composer: ['find-intent', 'send-to-agent', 'sources', 'query'], analyst: ['sources', 'find-schema', 'get-schema', 'query', 'find-concept'] }
  const toolsOf = (a: string) => roles[a] ?? null
  assert.match(refusedFor('find-concept', 'composer', toolsOf)!, /not one of the composer's tools — hand the question to the analyst/)
  assert.equal(refusedFor('find-concept', 'analyst', toolsOf), null)
  assert.equal(refusedFor('find-schema', null, toolsOf), null)
  assert.equal(refusedFor('find-schema', 'builder', toolsOf), null)   // a role that names no tools: its ticket alone
})
