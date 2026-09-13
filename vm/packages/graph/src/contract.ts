// ── WHAT A PROGRAM DECLARES ABOUT ITSELF ──────────────────────────────────────────────────────────────────
//
// The engine composes and checks against the contract, never against the body. The body is free JavaScript;
// the contract is the part the engine can hold it to.
//
// Two kinds of program, and the difference is one rule. A CONCEPT reads data sources. Every other program
// reads programs. That rule is what makes "one definition, referenced everywhere" enforceable rather than
// hoped for: a program that needs revenue has no data access, so it cannot retype a revenue query — it can
// only call the program that defines revenue.

export type ProgramKind = 'concept' | 'program'

export interface Contract {
  /** The name it is first created under. A name is a pointer, not identity — see hash.ts. */
  name: string
  kind: ProgramKind
  /** One to three sentences: what this is. */
  description: string
  reads: {
    /** Data sources it queries. Only a concept may have any. */
    sources: string[]
    /** Programs it calls, by name. Calling one not listed here is refused. */
    programs: string[]
  }
  /** name → what it means. */
  params: Record<string, string>
  /** What it hands back: a single value, or rows. */
  returns: 'value' | 'rows'
}

/** Everything that must be true of a contract before a program exists. Returns the first reason it is not. */
export function contractProblem(c: any): string | null {
  if (!c || typeof c !== 'object') return 'the contract is missing'
  if (typeof c.name !== 'string' || !c.name.trim()) return 'name is missing'
  if (c.kind !== 'concept' && c.kind !== 'program') return `kind is "${c.kind}" but must be concept or program`
  if (typeof c.description !== 'string' || !c.description.trim()) return 'description is missing'
  if (!c.reads || !Array.isArray(c.reads.sources) || !Array.isArray(c.reads.programs)) {
    return 'reads must list sources and programs, even when empty'
  }
  if (c.kind === 'program' && c.reads.sources.length) {
    return `"${c.name}" is a program but reads ${c.reads.sources.join(', ')} — only a concept may read a data ` +
      `source; a program gets its data by calling the concept that defines it`
  }
  if (c.kind === 'concept' && !c.reads.sources.length) {
    return `"${c.name}" is a concept but reads no data source — a concept is what reads data`
  }
  if (!c.params || typeof c.params !== 'object' || Array.isArray(c.params)) return 'params must be name → meaning'
  if (c.returns !== 'value' && c.returns !== 'rows') return `returns is "${c.returns}" but must be value or rows`
  return null
}
