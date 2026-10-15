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
