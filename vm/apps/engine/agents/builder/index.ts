// ── The builder: a session's agent that makes programs (docs/intent-graph.md) ──────────────────────────────────────
// Superatom's own, given to every project. It works in the session's folder — the same folder and the same agent every
// time the session reaches a node it answers at — and makes a program only when the person asks for one: a
// calculation, a report, a view, a dashboard. What it writes under ./programs/<name>/ is built by the engine the way
// every program is built (program-seam.ts) and kept by the platform as the person's own, until it is published.

import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const TEMPLATE = join(here, '..', '..', '..', '..', 'packages', 'project-template')

/** The builder's folder made ready: the template and its example beside the session's work. What it is told is its own
 *  domain's (platform-types AGENT_DOMAIN.builder), given by the caller. */
export async function builderBriefing(cwd: string): Promise<void> {
  await mkdir(join(cwd, 'builder'), { recursive: true })
  await mkdir(join(cwd, 'programs'), { recursive: true })
  if (existsSync(join(TEMPLATE, 'TEMPLATE.md'))) await cp(join(TEMPLATE, 'TEMPLATE.md'), join(cwd, 'builder', 'TEMPLATE.md'))
  const example = join(TEMPLATE, 'start', 'agent-template', 'programs', 'example')
  if (existsSync(example)) await cp(example, join(cwd, 'builder', 'example'), { recursive: true })
}
