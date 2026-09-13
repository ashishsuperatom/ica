// ── WHAT A PROGRAM DECLARES ABOUT ITSELF ──────────────────────────────────────────────────────────────────
//
// The engine composes and checks against the contract, never against the body. The body is free JavaScript;
// the contract is the part the engine can hold it to.
//
// Two kinds of program, and the difference is one rule. A CONCEPT reads data sources. Every other program
// reads programs. That rule is what makes "one definition, referenced everywhere" enforceable rather than
// hoped for: a program that needs revenue has no data access, so it cannot retype a revenue query — it can
// only call the program that defines revenue.

import { shapeProblem, type Shape } from './shape.js'

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
  /** name → what it means. A parameter may name a program for this one to call — see ProgramParam. */
  params: Record<string, string | ProgramParam>
  /** What it hands back: a single value, rows, or a relation — a query asked with coordinates. */
  returns: 'value' | 'rows' | 'relation'
  /** For a relation: which of its columns are dimensions, measures and time. See shape.ts. */
  shape?: Shape
  /** Named beliefs it reads — a working week, a target — looked up by name from the context its caller passes
   *  down, then the organisation's, then the default here. A program reads only what it declares. */
  assumes?: Record<string, Assumption>
}

/** A parameter whose value is the name of a program, which this program may then call — so one program can
 *  compare, rank or explain any measure instead of one per measure. What the named program must be is stated,
 *  and checked when the call is made. */
export interface ProgramParam {
  description: string
  program: {
    returns?: 'value' | 'rows' | 'relation'
    /** For a relation: measures it must have. */
    measures?: string[]
    /** For a relation: dimensions it must have. */
    dimensions?: string[]
  }
}

export interface Assumption {
  description: string
  unit?: string
  /** Used when neither the caller nor the organisation says otherwise. Absent means one must be given. */
  default?: unknown
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
  for (const [n, p] of Object.entries<any>(c.params)) {
    if (typeof p === 'string') continue
    if (!p || typeof p.description !== 'string' || !p.program || typeof p.program !== 'object') {
      return `parameter "${n}" must be a description, or { description, program: { returns?, measures?, dimensions? } }`
    }
  }
  if (!['value', 'rows', 'relation'].includes(c.returns)) return `returns is "${c.returns}" but must be value, rows or relation`
  if (c.assumes !== undefined) {
    if (!c.assumes || typeof c.assumes !== 'object' || Array.isArray(c.assumes)) return 'assumes must be name → { description, unit?, default? }'
    for (const [n, a] of Object.entries<any>(c.assumes)) {
      if (!a || typeof a.description !== 'string' || !a.description.trim()) return `assumption "${n}" needs a description`
    }
  }
  if (c.returns === 'relation') {
    if (c.kind === 'program' && !c.reads.programs.length) {
      return `"${c.name}" is a program that returns a relation, so it must read the relations it is built from`
    }
    const bad = shapeProblem(c.shape)
    if (bad) return bad
  } else if (c.shape) return `"${c.name}" declares a shape but returns ${c.returns}; a shape describes a relation`
  return null
}
