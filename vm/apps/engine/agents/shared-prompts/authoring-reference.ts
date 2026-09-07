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


// ── HIGH LEVEL FIRST ─────────────────────────────────────────────────────────────────────────────────────
// The reference used to begin in the middle — with the type of a unit's `meta`. An agent that loses the thread
// has nothing to re-orient against, and every rule reads as equally weighted, so a structural requirement and a
// piece of advice look the same. This is the spine: what the pieces are and how they fit, in a dozen lines,
// before any detail. Everything after it hangs off one of these five steps.
const HOW_IT_FITS = `# How this fits together

A question becomes a PROGRAM, and the program's output is the answer.

  question  →  program  →  units  →  sources
                  ↓
             view-model  →  the card the reader sees

- A **unit** is one file with one job: a function of its params, computing over structured keys.
- A **program** is a unit that composes other units — the root, one per question.
- Units reach data only through **ctx** (query / use / decide / log). Nothing else.
- The LAST unit returns a **view-model**: the shape the card renders.
- You finish by writing **built.json**, which points at the program you built or reused.

Reuse before you build: a program that already answers this question is the answer.`

// ── ONE LIST, IN THE ORDER THE WORK HAPPENS ─────────────────────────────────────────────────────────────
// The tools were documented in three places — six in a list, the rest scattered into prose sections that
// mentioned them while explaining something else — so the agent had to assemble its own list from across the
// prompt. A tool needs a name, its arguments, and what comes back; how it is implemented, where it lives, and
// what runs it are not the agent's concern. Ordered by when they are reached, not alphabetically: the sequence
// IS the method, so reading the list top to bottom is reading the approach.
const TOOLS = `# Your tools

Run them from the workspace root. Each takes \`--help\`.

**Is it already answered?**
- \`./find-program "<question>"\` → the shortlist: programs that answered a similar question (what it answers · name · category)
- \`./get-program <name>\` → ONE program in full: every question form it answers, its saved params, its category

**What logic already exists?**
- \`./find-concept "<phrase>"\` → the NAMES of matching concepts
- \`./get-concept "<exact name>"\` → ONE concept's guide: what it is, its rules, where the data lives, how to compute and present it

**Where does the data live?**
- \`./sources\` → every data source with its kind + dialect
- \`./find-schema "<term>" [--source <S>] [--full]\` → where a field or table lives, across every source (SOURCE.TABLE.COLUMN : type)
- \`./introspect "<source>" <tables | columns "<t>" | sample "<t>" [n] | profile "<t>" "<col>" | verify-join …>\` → structure and evidence for one source

**What does the data say?**
- \`./query "<source>" "<query>"\` → run a query against a source → JSON rows
- \`./resolve "<text>"\` → a fuzzy name or value → concrete ids`

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

// THE EXAMPLE IS A POINTER NOW, not 5 KB of inlined code on every question.
//
// It was inlined so it would "survive compaction — no file to read", which is a real property and the reason to
// think twice here. Weighed against it: the example is a sixth of every prompt the composer receives, on turns
// that mostly REUSE a program rather than write one, and the file it copies is sitting in the workspace the
// agent is already working in — verified byte-identical, because prepareWorkspace copies it from the same
// canonical directory this module used to read.
//
// The drift guard is unaffected: examples/example.single-metric still type-checks against @superatom/scaffold
// (contract.assert.ts + `pnpm authoring:check`), so a change to the unit contract still breaks its compile.
// What changes is only WHERE the agent reads it from.
const example = `# The canonical example

\`programs/example.single-metric/\` in your workspace is the shape every program takes: one compute unit → one
view unit, with \`program.ts\` composing them. Read it before writing your first program of a turn —
\`program.ts\` for the shape, \`units/\` for what a unit looks like.

It is a TEMPLATE: its source and columns are illustrative. Never run it, and never point built.json at it.
\`programs/example.grouped-ranking/\` is the same shape for a ranking with openable cells.`

const WORKSPACE = `# Your workspace

Everything needed to write a program is here: the tools above reach the data, and the canonical example gives
the shape. Build every query from a source \`./sources\` actually lists, so a program runs on real, current data.

List at most 100 rows unless the question asks for more, and say how many there are in total.`

// What we expect from a program WRITER, one named section per expectation. Both program-writing agents (the
// composer and the analyst) get every section, so an expectation is stated once and never drifts between them.
// Sections are added and removed here — keep each one self-contained under its own heading.
export const PARAMETERISATION = `# One program, many runs
This program answers the question now, and it is also the artifact that answers it again — at another time, or for
a variant of the same question. Read the question for what would differ on such a run — a date or period, an
entity, a threshold, a limit — and make each one a parameter with a sensible default. When the answer turns on a
judgement the question never stated — a cutoff that decides good or bad, in or out, worth it or not — that cutoff
is a parameter too, carrying the default you chose, and the verdict is computed from it, so a different cutoff
yields a different verdict; what you then present follows from that result. Those two are the parameters: what the
question varies, and the judgements you make. Everything else the program works out AS IT RUNS: from a query, or
from the clock when the question means "now" or "latest". Each parameter you declare reaches the computation, and
every label you print — the period, the as-of date, the scope — states what that run actually computed. So the
same program, run tomorrow or for another entity, gives the truth for that run.`

// The expectations, in the order they are presented. Add or remove sections here.
const EXPECTATIONS = [WORKSPACE, PARAMETERISATION]


// ── HOW TO SEARCH, not what the tools are ───────────────────────────────────────────────────────────────
// The tools are in the list above; this is the only thing about them that is not obvious from their output.
// NARROW THEN OPEN, because the alternative — reading every program to learn what it does — costs a turn of
// reading before any thinking, and gets worse with every program a project accumulates.
const NARROW_THEN_OPEN = `# Finding what already exists

Search, then open one — never the other way round.

\`./find-program\` and \`./find-concept\` return SHORTLISTS: names and what each answers. Judge on that, pick the
one or two that could be yours, and open only those with \`./get-program\` / \`./get-concept\`. Read a program's
code only once you have chosen it.

Judge on the QUESTION, never the slug: two programs can be a rename apart and answer different things, and a
name that matches your words can be built on a different source, grain or window.

Then reuse, adapt, or build — in that order. An exact match runs as it is; a near match is usually the same
program with different params; only when neither holds is a new program the right answer.`

// The complete authoring surface, as ONE string, to install into a coding agent's system prompt (systemReference).
// Use this when the caller's base does NOT already carry the authoring MECHANICS (the composer).
export const AUTHORING_REFERENCE: string = [HOW_IT_FITS, TOOLS, NARROW_THEN_OPEN, contract, ...PROGRAM_AUTHORING, example, ...EXPECTATIONS].join('\n\n')

// The surface WITHOUT the mechanics — for a caller whose generated base ALREADY includes PROGRAM_AUTHORING (the
// analyst), so the mechanics aren't repeated. The expectations are identical in both.
export const AUTHORING_SURFACE: string = [HOW_IT_FITS, TOOLS, NARROW_THEN_OPEN, contract, example, ...EXPECTATIONS].join('\n\n')
