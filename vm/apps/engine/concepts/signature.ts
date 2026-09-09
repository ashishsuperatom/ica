// ── THE STRUCTURAL SIGNATURE OF A CONCEPT ─────────────────────────────────────────────────────────────────
//
// A concept is JavaScript with SQL inside it, so its signature is both halves. The SQL half goes to the
// datasource manager, which already owns the parser and its dialect handling — a second parser could
// disagree with what actually runs. The JS half is parsed here with the TypeScript compiler, because the
// alternative is matching text with regular expressions and being wrong about it.
//
// WHAT THIS IS FOR: noticing that one measure has been written several times. It is a SIMILARITY key, never
// an identity. Concept identity remains the content hash over the whole body, comments included — an
// explanation that changed is a real change to the artifact. The signature is the opposite: it strips
// comments and names precisely because they are not part of what is computed.
//
// DERIVED, and stored OUTSIDE the concept's props. Putting it in props would fold it into the content hash
// and remint every concept the first time this ran — the store would silently double.
//
// PRECISION OVER RECALL, on purpose. Two bodies computing the same thing by different routes will not match,
// and that is the right failure: what this matches is genuinely related, and what it misses is left exactly
// as it is. Nothing is merged automatically on the strength of it.

import ts from 'typescript'
import { createHash } from 'node:crypto'

export interface SqlSignature {
  core: { measures: string[]; base: string | null; filters: string[] }
  coreHash: string
  dimension: string[]
  timeFilters: string[]
  joins: string[]
}

export interface ConceptSignature {
  /** The whole concept: SQL cores plus the shape of the code around them. What clusters. */
  hash: string
  /** One per SQL string the body contains, in the order they appear. */
  sql: SqlSignature[]
  /** The ctx capabilities used, in order — `query`, `decide`, `verify`, `caveat`. A body that verifies
   *  nothing is visibly different from one that does, which is worth being able to ask about. */
  calls: string[]
  /** Shape of the code with names and literals removed: two bodies that differ only in what they called
   *  their variables produce the same string. */
  shape: string
  /** SQL found but not parseable — a fragment, or a dialect the parser could not read. Reported rather than
   *  dropped, so "this concept has no signature" is never mistaken for "this concept has no SQL". */
  unparsed: number
  /** True when some SQL could not be signed, so the hash rests partly on raw text. Such a signature still
   *  discriminates, but it will not CLUSTER with an equivalent query written differently — and a cluster
   *  built on degraded signatures is worth less than one built on parsed cores, so say so. */
  degraded: boolean
}

/** Enough to make formatting irrelevant, and no more. Deliberately not a parse: this runs precisely when
 *  parsing was not available. */
const normalizeSqlText = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** SQL string literals in the body. Heuristic by necessity — a string is only SQL because of where it is
 *  sent — so the test is deliberately loose and the manager decides for certain by trying to parse it. */
const looksLikeSql = (s: string): boolean =>
  /\bselect\b[\s\S]*\bfrom\b/i.test(s) || /^\s*with\b/i.test(s)

/** Parsed once and shared. Three separate walks over one source used to mean three parses — under a
 *  millisecond each and therefore not a performance problem, but a reader has to work out why a file is read
 *  three times to answer three questions about it. */
const parse = (source: string) => ts.createSourceFile('concept.mjs', source, ts.ScriptTarget.ES2022, true)

export function extractSql(source: string, file = parse(source)): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (looksLikeSql(n.text)) out.push(n.text)
    } else if (ts.isTemplateExpression(n)) {
      // An interpolated query: the spans are values, and a value is a parameter. Holed out so a query built
      // with a template and one built with a bind parameter look the same, which they are.
      const text = n.head.text + n.templateSpans.map((s) => `:p${s.literal.text}`).join('')
      if (looksLikeSql(text)) out.push(text)
    }
    ts.forEachChild(n, visit)
  }
  visit(file)
  return out
}

/** Which ctx capabilities the body uses, in order of appearance. */
export function extractCalls(source: string, file = parse(source)): string[] {
  const calls: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const obj = n.expression.expression
      if (ts.isIdentifier(obj) && obj.text === 'ctx') calls.push(n.expression.name.text)
    }
    ts.forEachChild(n, visit)
  }
  visit(file)
  return calls
}

/** The body's shape with names and literals gone: only the KINDS of node and their nesting.
 *
 *  Two functions that differ solely in what they named their variables — or in the value of a constant —
 *  collapse to the same string, which is exactly the case a text hash cannot see. Comments never reach here:
 *  the parser has already discarded them. */
export function shapeOf(source: string, file = parse(source)): string {
  const parts: string[] = []
  const visit = (n: ts.Node, depth: number): void => {
    // Identifiers and literals are the two things that carry names and values; everything else is structure.
    if (!ts.isIdentifier(n) && !ts.isStringLiteral(n) && !ts.isNumericLiteral(n) &&
        !ts.isNoSubstitutionTemplateLiteral(n) && !ts.isTemplateHead(n) && !ts.isTemplateMiddle(n) &&
        !ts.isTemplateTail(n)) {
      parts.push(`${depth}:${ts.SyntaxKind[n.kind]}`)
    }
    ts.forEachChild(n, (c) => visit(c, depth + 1))
  }
  visit(file, 0)
  return parts.join(' ')
}

export interface SignatureDeps {
  /** How the SQL half is computed. Injected so this is testable without a manager, and so the caller decides
   *  whether an unreachable manager is fatal — here it never is. */
  signSql: (sql: string) => Promise<SqlSignature | null>
}

export async function conceptSignature(source: string, deps: SignatureDeps): Promise<ConceptSignature> {
  const file = parse(source)
  const statements = extractSql(source, file)
  const sql: SqlSignature[] = []
  const unsignable: string[] = []
  for (const s of statements) {
    const sig = await deps.signSql(s).catch(() => null)
    if (sig) sql.push(sig); else unsignable.push(s)
  }
  const unparsed = unsignable.length
  const calls = extractCalls(source, file)
  const shape = shapeOf(source, file)
  // The SQL cores dominate — that is where a measure lives. The code shape then distinguishes two concepts
  // that run the same query and do different arithmetic to it.
  //
  // AN UNSIGNABLE STATEMENT STILL HAS TO DISCRIMINATE. Without this, a manager that is unreachable — or a
  // dialect the parser cannot read — makes every concept produce the same hash, and the clustering silently
  // reports that everything is a duplicate of everything. Caught exactly that way: two different measures
  // collided while the SQL half was returning nothing. So a statement that could not be signed contributes
  // its own normalised text instead, which is a worse key than a core hash and an infinitely better one than
  // nothing.
  const parsed = sql.map((s) => s.coreHash)
  const fallback = unsignable.map((t) => createHash('sha256').update(normalizeSqlText(t)).digest('hex').slice(0, 12))
  const hash = createHash('sha256')
    .update(JSON.stringify(parsed)).update('|')
    .update(JSON.stringify(fallback)).update('|')
    .update(JSON.stringify(sql.map((s) => s.dimension))).update('|')
    .update(shape)
    .digest('hex').slice(0, 16)
  return { hash, sql, calls, shape, unparsed, degraded: unsignable.length > 0 }
}
