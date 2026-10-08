// A new agent's folder from the template (embedded at build: agent-template.gen.ts): its agent.json, its domain and its
// first program, all named for it. The template's "example" becomes the agent's name where a name is meant (the agent,
// its domain, its program, the program's block) and its slice — the name as an identifier — where STATE is meant.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CliError } from './config.ts'
import { AGENT_TEMPLATE } from './agent-template.gen.ts'

export function initAgent(dir: string, name: string): { dir: string; name: string; files: string[] } {
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(name)) throw new CliError(`"${name}" is not an agent name: lower-case letters, digits and dashes, starting with a letter`, 2)
  if (existsSync(dir)) throw new CliError(`${dir} is there already`, 1)
  const slice = name.replace(/-/g, '_')
  const pascal = name.split('-').map((w) => w[0]!.toUpperCase() + w.slice(1)).join('')
  const title = name.split('-').map((w, i) => (i ? w : w[0]!.toUpperCase() + w.slice(1))).join(' ')
  const written: string[] = []
  for (const [rel, text] of Object.entries(AGENT_TEMPLATE)) {
    const path = rel.replace(/^programs\/example\//, `programs/${name}/`)
    let body = text.replace(/\bprg_example\b/g, `prg_${slice}`).replace(/\bExample\b/g, pascal).replace(/\bexample\b/g, slice)
    if (rel === 'agent.json') {
      const a = JSON.parse(body); a.name = name; a.title = title; a.domain = name; a.programs = [name]
      body = JSON.stringify(a, null, 2) + '\n'
    }
    if (rel === 'programs/example/manifest.json') {
      const m = JSON.parse(body); m.name = name; m.ui.blocks = [name]
      body = JSON.stringify(m, null, 2) + '\n'
    }
    if (rel === 'knowledge/index.mts') body = body.replace(`name: '${slice}',`, `name: '${name}',`)
    const out = join(dir, path)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, body)
    written.push(path)
  }
  return { dir, name, files: written }
}
