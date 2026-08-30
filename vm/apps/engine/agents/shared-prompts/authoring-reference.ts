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
const contract = `# The contract — this is the WHOLE interface (you never read engine or scaffold source)
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

const rule = `# Do not go looking
The contract and the example above are the WHOLE authoring surface. Do NOT read the engine, the scaffold, the
kernel, node_modules, or OTHER programs to learn how to write one — other programs carry context specific to
THEIR question and only mislead yours. Read your OWN program only when you are modifying it. Exploring the DATA is
different and encouraged: \`query\`, \`introspect\`, and \`find-concept\` freely — that is analysis, not machinery.`

// The complete authoring surface, as ONE string, to install into a coding agent's system prompt (systemReference).
export const AUTHORING_REFERENCE: string = [contract, ...PROGRAM_AUTHORING, example, rule].join('\n\n')
