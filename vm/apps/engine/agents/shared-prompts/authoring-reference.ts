// THE AUTHORITATIVE AUTHORING REFERENCE — the ONE self-contained surface an agent needs to write a program.
// It exists so a coding agent (composer/analyst) never reads engine source, the scaffold, node_modules, or OTHER
// programs to learn the shape: the contract types, the full authoring mechanics, and one complete worked example
// are all HERE. Delivered into the agent's system prompt via `systemReference` (see ica: referencePlacement) so it
// is always in context and survives compaction — no file to read.
//
// DRIFT GUARD: the canonical example is READ FROM the real example files at import time (not hand-copied), and
// those files type-check against @superatom/scaffold (see contract.assert.ts + `pnpm authoring:check`). So a
// change to the unit contract breaks the example's compile → a signal to update the hand-written contract block
// below. Prose can't be type-checked; a compiled example can.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PROGRAM_AUTHORING } from './program-authoring.js'

const here = dirname(fileURLToPath(import.meta.url))
const exampleDir = join(here, '..', '..', 'examples', 'example.single-metric')
const read = (rel: string) => { try { return readFileSync(join(exampleDir, rel), 'utf8').trim() } catch { return '(example unavailable)' } }

// The CONTRACT — the exact, whole surface. Mirrors @superatom/scaffold (packages/scaffold/src/unit.ts). If this
// drifts from the real types, the canonical example below stops compiling under `pnpm authoring:check`.
const contract = `# The contract — the whole interface
A **unit** is a file with three exports; a **program** is just a unit whose \`meta.concept === 'program'\` that
composes other units. The kernel injects \`ctx\` — the ONLY capabilities a unit has:

\`\`\`ts
export const meta: {
  name: string
  description: string
  inputs: Record<string, string>          // param name → what it means
  outputs: string | Record<string, string>
  logic: string                            // one line: the calculation
  dataSources: string[]                    // e.g. ['MYSOURCE.orders']
  concept?: string                         // groups units; 'program' marks the composing ROOT unit
}
export default async function (ctx: UnitCtx, params): Promise<Result>
export const ui: { category: 'simple' | 'dashboard'; template?: string; props?: Record<string, unknown> }

type UnitCtx = {                           // the four primitives — nothing else exists
  query:  (dataSourceId: string, sql: string, params?: Record<string, unknown>) => Promise<any[]>  // the ONLY I/O
  use:    <R>(unitName: string, params?: any) => Promise<R>   // run/compose another unit in this program
  decide: (label: string, condition: boolean, reason: string) => boolean   // record a branch + why
  log:    (message: string) => void
}
\`\`\`
Display helpers \`money\`, \`num\` import from \`@superatom/scaffold\`. That plus the four ctx primitives is the
entire API — there is nothing else to discover.`

// The one canonical example, pulled from the real (compiling) example files so it never rots.
const example = `# The one canonical example — every program is this shape: compute unit(s) → one view unit
\`programs/<slug>/program.ts\` — the composing root:
\`\`\`ts
${read('program.ts')}
\`\`\`
\`programs/<slug>/units/total-sales.ts\` — a compute unit (its source/columns are ILLUSTRATIVE; find your real
ones with \`./find-schema\`, and write the query in that source's dialect):
\`\`\`ts
${read('units/total-sales.ts')}
\`\`\`
\`programs/<slug>/units/single-metric-view.ts\` — the final view unit (shapes the answer card):
\`\`\`ts
${read('units/single-metric-view.ts')}
\`\`\`
That is the complete pattern. Write your OWN program + units in this shape against your real source.`

const WORKSPACE = `# Your workspace
Everything you need to write a program is right here. The contract and the example above give you the shape; the
seams give you the data — \`./sources\` and \`./find-schema\` show the real sources and their tables and columns,
\`./query\` and \`./introspect\` look at the data, and \`./find-concept\` finds reusable logic. Build your queries
from what \`./sources\` shows, so every program runs on real, current sources.`

// What we expect from a program WRITER, one named section per expectation. Both program-writing agents (the
// composer and the analyst) get every section, so an expectation is stated once and never drifts between them.
// Sections are added and removed here — keep each one self-contained under its own heading.
export const PARAMETERISATION = `# One program, many runs
This program answers the question now, and it is also the artifact that answers it again — at another time, or for
a variant of the same question. Read the question for what would differ on such a run — a date or period, an
entity, a threshold, a limit — and make each one a parameter with a sensible default. Everything else the program
works out AS IT RUNS: from a query, or from the clock when the question means "now" or "latest". When the answer
turns on a judgement — a cutoff that decides good or bad, in or out, worth it or not — that cutoff is a parameter
too and the verdict is computed from it, so a different cutoff yields a different verdict; what you then present
follows from that result. Each parameter you declare reaches the computation, and every label you print — the
period, the as-of date, the scope — states what that run actually computed. So the same program, run tomorrow or
for another entity, gives the truth for that run.`

// The expectations, in the order they are presented. Add or remove sections here.
const EXPECTATIONS = [WORKSPACE, PARAMETERISATION]

// The complete authoring surface, as ONE string, to install into a coding agent's system prompt (systemReference).
// Use this when the caller's base does NOT already carry the authoring MECHANICS (the composer).
export const AUTHORING_REFERENCE: string = [contract, ...PROGRAM_AUTHORING, example, ...EXPECTATIONS].join('\n\n')

// The surface WITHOUT the mechanics — for a caller whose generated base ALREADY includes PROGRAM_AUTHORING (the
// analyst), so the mechanics aren't repeated. The expectations are identical in both.
export const AUTHORING_SURFACE: string = [contract, example, ...EXPECTATIONS].join('\n\n')
