// Smoke test — proves the Session interface end-to-end with the mock harness (no external agent), and that
// every file the workspace GENERATES actually parses.
import { execFileSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createSession, prepareWorkspace } from './ica/index.js'

const cwd = await prepareWorkspace({ root: new URL('./.ica-workspace', import.meta.url).pathname, projectId: 'demo' })

// ── DOES WHAT WE WROTE PARSE? ──────────────────────────────────────────────────────────────────────────────
// The workspace writes runnable JavaScript from TypeScript template literals, where an escape is processed
// TWICE — once writing the template, once running the result. A lone `\n` among its correctly-doubled
// neighbours becomes a real newline inside a single-quoted string, and the file stops parsing entirely.
//
// That has now happened three times, and every time it surfaced as a program failing on a box with a stack
// trace from inside tsx — nowhere near the template that wrote it, and only after a deploy had shipped it.
// Nothing checked the one property that matters: the generated file is valid JavaScript. `node --check` is
// the whole test, it costs milliseconds, and it cannot be fooled by an escape that looks right in review.
{
  const files: string[] = []
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) { if (e.name !== 'node_modules') await walk(p) }
      else if (/\.(mjs|js)$/.test(e.name)) files.push(p)
    }
  }
  await walk(cwd)
  const broken = files.filter((f) => {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); return false }
    catch (e: any) { console.error(`✗ generated file does not parse: ${f.replace(cwd, '')}\n  ${String(e.stderr).split('\n').slice(0, 3).join('\n  ')}`); return true }
  })
  if (broken.length) { console.error(`\n${broken.length} of ${files.length} generated files are not valid JavaScript.`); process.exit(1) }
  console.log(`✓ ${files.length} generated files parse`)
}
const s = createSession('mock', { cwd })
console.log(`Session: mock · cwd ${cwd}\n`)

let events = 0
const r = await s.run('What is our total billed revenue for FY2025-26?', {
  onOutput: (chunk) => process.stdout.write(chunk),
  onEvent: () => { events++ },
})
console.log(`\n— final: ${r.lastLines}\n— events: ${events} · ${r.ms}ms`)
