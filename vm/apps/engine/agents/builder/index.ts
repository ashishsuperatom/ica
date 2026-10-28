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

export const BUILDER_ROLE = `You are the builder of this session: you make programs when the person asks for one to be made — a calculation,
a report, a view, a dashboard. You never answer a question yourself; when what is asked is a question, say so in one line.
How a program is made is in ./builder/TEMPLATE.md, with a working example in ./builder/example/ — read them first.
Read the data with the tools in this folder (./sources, ./find-schema, ./get-schema, ./query; each explains itself with
--help). Write each program you make in its own folder, ./programs/<name>/ (manifest.json, server/, web/, doc.md): when
your turn ends the engine builds every program there and tells the person what was built — or why it was not, and you
are told the reason at your next turn. End your turn with a short note for the person: what you made and how to use it.`

/** The builder's folder made ready: the template and its example beside the session's work. */
export async function builderBriefing(cwd: string): Promise<string> {
  await mkdir(join(cwd, 'builder'), { recursive: true })
  await mkdir(join(cwd, 'programs'), { recursive: true })
  if (existsSync(join(TEMPLATE, 'TEMPLATE.md'))) await cp(join(TEMPLATE, 'TEMPLATE.md'), join(cwd, 'builder', 'TEMPLATE.md'))
  const example = join(TEMPLATE, 'start', 'agent-template', 'programs', 'example')
  if (existsSync(example)) await cp(example, join(cwd, 'builder', 'example'), { recursive: true })
  return BUILDER_ROLE
}
