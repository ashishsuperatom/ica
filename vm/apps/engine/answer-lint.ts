// ── ANSWER LINT — a compiler pass over a finished answer ─────────────────────────────────────────────────
//
// An answer can satisfy every type in the contract and still be broken in a way nobody sees. A cell that
// carries an id but no KIND renders as ordinary text: the reader clicks and nothing happens, no error, no log
// line, nothing to trace. It stayed broken across two questions before anyone noticed, and the only reason it
// was noticed then was that someone happened to click.
//
// So: RULES, run over the finished view-model, each reporting what it knows. The shape is deliberately a
// compiler's — many small passes, a list of findings, severities — because the useful property of a compiler
// is not that it fixes your code, it is that it will not let a whole class of mistake through silently.
//
// WHAT BELONGS HERE. Only defects decidable from STRUCTURE alone. "This cell has an id and no kind" is certain
// without knowing anything about the data. "This customer id is wrong" is not, and never will be — that needs
// the source, and a lint that guesses is a lint people learn to ignore.
//
// SEVERITY IS ABOUT THE READER, not about tidiness:
//   error    the answer will visibly fail someone — a dead affordance, an unrenderable field.
//   warning  it renders, but something was probably meant differently.
// Nothing here blocks an answer. A wrong number is a bad answer; a late answer is no answer, and a correct
// answer withheld because a column tag is missing would be the worst trade of the three.
//
// ── HOW TO TURN THIS OFF ────────────────────────────────────────────────────────────────────────────────
// Delete the single `lintAnswer(...)` call in engine.ts. Nothing else refers to this module, it has no
// side effects, no I/O and no state, and this file can then be deleted outright. That is the whole contract:
// one call site, no hooks, no registry.

export type Severity = 'error' | 'warning'

export interface Finding {
  rule: string
  severity: Severity
  message: string
  /** Where in the answer, in words a person can find — "sections[0].columns[3] (Sub-account)". */
  where?: string
}

/** One pass. Pure: given an answer, say what is wrong with it. Never throws — a lint that can crash the turn
 *  it is inspecting is a worse bug than anything it detects, so every rule is called inside a guard. */
export type Rule = (answer: any) => Finding[]

const isObj = (c: unknown): c is Record<string, any> =>
  !!c && typeof c === 'object' && !Array.isArray(c) && 'value' in (c as any)

const tables = (a: any): Array<{ i: number; sec: any }> =>
  (Array.isArray(a?.sections) ? a.sections : [])
    .map((sec: any, i: number) => ({ i, sec }))
    .filter(({ sec }: any) => sec?.kind === 'table' && Array.isArray(sec?.columns) && Array.isArray(sec?.rows))

// ── RULES ────────────────────────────────────────────────────────────────────────────────────────────────

/** An id with nothing to say what it identifies. THE observed failure: a table of linked accounts shipped
 *  {"value":"V192038 RAJ LOGISTICS","id":233673} with no `entity` on the column, so the cell rendered as
 *  plain text and the click did nothing — by design, since `view: <kind> <id>` cannot be built without a
 *  kind. Half an affordance is indistinguishable from none. */
const idWithoutKind: Rule = (a) => {
  const out: Finding[] = []
  for (const { i, sec } of tables(a)) {
    sec.columns.forEach((col: any, c: number) => {
      const has = sec.rows.some((r: any[]) => isObj(r?.[c]) && r[c].id != null && !(r[c].entity || col?.entity))
      if (has) out.push({
        rule: 'id-without-kind', severity: 'error',
        where: `sections[${i}].columns[${c}] (${col?.label ?? '?'})`,
        message: `cells carry an id but no kind — add entity:"<what this column names>" to the column, or the id opens nothing`,
      })
    })
  }
  return out
}

/** The mirror image, and the other failure we saw: a column tagged entity:"customer" whose cells were bare
 *  strings, with the id put in a SEPARATE "Customer ID" column. The tag promises an openable cell and the
 *  rows do not deliver one. */
const kindWithoutId: Rule = (a) => {
  const out: Finding[] = []
  for (const { i, sec } of tables(a)) {
    sec.columns.forEach((col: any, c: number) => {
      if (!col?.entity) return
      const cells = sec.rows.map((r: any[]) => r?.[c]).filter((v: any) => v != null)
      if (cells.length && !cells.some((v: any) => isObj(v) && v.id != null)) out.push({
        rule: 'kind-without-id', severity: 'warning',
        where: `sections[${i}].columns[${c}] (${col?.label ?? '?'})`,
        message: `column is tagged entity:"${col.entity}" but no cell carries an id — send {"value": <name>, "id": <id>} so it can be opened`,
      })
    })
  }
  return out
}

/** Rows that do not match their header. Renders as a shifted or truncated table, which reads as wrong DATA —
 *  the most expensive kind of wrong, because it is believed. */
const rowWidth: Rule = (a) => {
  const out: Finding[] = []
  for (const { i, sec } of tables(a)) {
    const n = sec.columns.length
    const bad = sec.rows.findIndex((r: any) => !Array.isArray(r) || r.length !== n)
    if (bad >= 0) out.push({
      rule: 'row-width', severity: 'error',
      where: `sections[${i}].rows[${bad}]`,
      message: `row has ${Array.isArray(sec.rows[bad]) ? sec.rows[bad].length : 'no'} cells, header has ${n}`,
    })
  }
  return out
}

/** An object where the card expects text. This is the failure the answer-contract test was written for: a
 *  view-model returned inside its unit's envelope rendered as "[object Object]" and took the card down. */
const textIsText: Rule = (a) => {
  const out: Finding[] = []
  for (const k of ['answer', 'period', 'scope', 'caveat']) {
    const v = a?.[k]
    if (v == null) continue
    const ok = typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))
    if (!ok) out.push({
      rule: 'text-is-text', severity: 'error', where: k,
      message: `${k} must be a string or an array of strings, got ${Array.isArray(v) ? 'array of non-strings' : typeof v}`,
    })
  }
  return out
}

/** A headline that cannot be drawn. `display` is what the reader sees; without it the card has a number and
 *  no way to say it. */
const headlineShape: Rule = (a) => {
  const h = a?.headline
  if (h == null) return []
  if (typeof h !== 'object' || Array.isArray(h)) {
    return [{ rule: 'headline-shape', severity: 'error', where: 'headline', message: 'headline must be an object {label, display, value}' }]
  }
  const out: Finding[] = []
  if (!h.label) out.push({ rule: 'headline-shape', severity: 'warning', where: 'headline.label', message: 'headline has no label — the reader cannot tell what the number IS' })
  if (h.display == null && h.value == null) out.push({ rule: 'headline-shape', severity: 'error', where: 'headline', message: 'headline carries neither display nor value' })
  return out
}

const RULES: Array<{ name: string; run: Rule }> = [
  { name: 'id-without-kind', run: idWithoutKind },
  { name: 'kind-without-id', run: kindWithoutId },
  { name: 'row-width', run: rowWidth },
  { name: 'text-is-text', run: textIsText },
  { name: 'headline-shape', run: headlineShape },
]

/** Run every pass. Order is not significant — rules do not interact, which is what keeps adding one cheap. */
export function lintAnswer(answer: unknown): Finding[] {
  if (!answer || typeof answer !== 'object') return []
  const out: Finding[] = []
  for (const r of RULES) {
    try { out.push(...r.run(answer)) }
    catch { /* a broken rule must never cost an answer — see the header */ }
  }
  return out
}

/** One line per finding, for the boot/turn log. Errors first: the list is read top-down and truncated. */
export function describeFindings(f: Finding[]): string {
  return [...f]
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
    .map((x) => `  ${x.severity === 'error' ? '✗' : '!'} ${x.rule}${x.where ? ` at ${x.where}` : ''} — ${x.message}`)
    .join('\n')
}

// ── HANDING IT BACK ─────────────────────────────────────────────────────────────────────────────────────
// ERRORS ONLY. A warning means the answer renders and something was probably meant differently — not worth a
// model turn, and worth seeing in aggregate in the log instead. Spending a turn on every nicety is how a
// useful check becomes one that gets switched off.
//
// TWO ROUNDS, THEN SHIP WHATEVER WE HAVE. The failure mode of a repair loop is not that it fails, it is that
// it does not: an agent that cannot see what is wrong will re-run and re-fail indefinitely, and the user
// waits on a table that renders correctly except that a cell is not clickable. Two attempts is enough for a
// slip and short enough that a genuine misunderstanding costs seconds rather than minutes. After that the
// answer goes out with its findings in the log, because a slightly imperfect answer beats a late one.
export const MAX_REPAIR_ROUNDS = 2

/** What to hand back to the agent when it is worth one more turn. Says only what is wrong and where; it does
 *  NOT say what the value should be, because the engine does not know — only the program that wrote the query
 *  knows that a "Sub-account" is a party. Telling it the kind would be guessing, and a confident guess is how
 *  the wrong id ends up on the right-looking cell. */
export function repairInstruction(f: Finding[]): string | null {
  const errs = f.filter((x) => x.severity === 'error')
  if (!errs.length) return null
  return `The answer your program produced has ${errs.length} problem${errs.length > 1 ? 's' : ''} in its view-model:\n` +
    errs.map((e) => `- ${e.where ? e.where + ': ' : ''}${e.message}`).join('\n') +
    `\nFix the view unit and re-run the program. Change nothing else.`
}
