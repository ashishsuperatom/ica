// ── LOOKING AT A FINISHED ANSWER — one module, two questions ────────────────────────────────────────────
//
//   lintAnswer(a)     what is WRONG with it   → findings, a repair round, the log
//   describeShape(a)  what it IS              → three lines in the agent's own tool output at run time
//
// Both walk the same structure, so they live in one file and share one idea of what a row and a column are.
//
// ── PART 1 — WHAT IS WRONG.  lintAnswer(): a compiler pass over a finished answer ─────────────────────────────────────────────────
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
// EVERY MESSAGE SAYS WHAT TO DO. A finding that only names the fault leaves the agent to infer a remedy, and
// an inferred remedy is how "the customer cell needs its id" became "add a Customer ID column" — a reasonable
// reading of a requirement nobody had actually stated. Each message therefore carries a FIX: clause naming the
// change, in the vocabulary of the thing being edited.
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

/** A plain object. Shared by both halves — the single idea of "a record" this file is built on. */
const isRec = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** A CELL object specifically: a record carrying `value`. A bare scalar is a cell too, just not this. */
const isObj = (c: unknown): c is Record<string, any> => isRec(c) && 'value' in c

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
        message: `cells carry an id but no kind, so the id opens nothing. FIX: add entity:"<what this column names — e.g. customer, invoice, party>" to this column's definition. Change the column only; the rows already carry their ids.`,
      })
    })
  }
  return out
}

/** The mirror image, and an ERROR for the same reason: what the reader loses is identical. A column tagged
 *  entity:"customer" whose cells are bare strings looks openable and is not — the click does nothing, exactly
 *  as when the kind is missing instead of the id. This was a warning first, split on HOW it was wrong rather
 *  than WHAT it costs, and the lint then watched a dead column ship in silence while saying nothing worth
 *  acting on. The axis that matters is the reader's, not the taxonomy's. */
const kindWithoutId: Rule = (a) => {
  const out: Finding[] = []
  for (const { i, sec } of tables(a)) {
    sec.columns.forEach((col: any, c: number) => {
      if (!col?.entity) return
      const cells = sec.rows.map((r: any[]) => r?.[c]).filter((v: any) => v != null)
      if (cells.length && !cells.some((v: any) => isObj(v) && v.id != null)) out.push({
        rule: 'kind-without-id', severity: 'error',
        where: `sections[${i}].columns[${c}] (${col?.label ?? '?'})`,
        message: `column is tagged entity:"${col.entity}" but no cell carries an id, so nothing can be opened. FIX: emit each cell as {"value": <the name>, "id": <its id>} instead of a bare value. If the id is not in the query result, select it — usually a join to that entity's master table. If this column genuinely names nothing openable, drop the entity tag instead.`,
      })
    })
  }
  return out
}

/** The column's own kind, restated on every row. It renders correctly, so this is a warning — but it is pure
 *  weight: one short string per cell, on every row of every entity column, saying what the column already
 *  said. A cell carries `entity` for one reason only, a column that mixes kinds, and that is rare. */
const redundantCellEntity: Rule = (a) => {
  const out: Finding[] = []
  for (const { i, sec } of tables(a)) {
    sec.columns.forEach((col: any, c: number) => {
      if (!col?.entity) return
      const cells = sec.rows.map((r: any[]) => r?.[c]).filter((v: any) => isObj(v))
      if (cells.length >= 2 && cells.every((v: any) => v.entity === col.entity)) out.push({
        rule: 'redundant-cell-entity', severity: 'warning',
        where: `sections[${i}].columns[${c}] (${col?.label ?? '?'})`,
        message: `every cell repeats entity:"${col.entity}", which the column already declares. FIX: drop entity from the cells and keep {"value", "id"} — a cell states its own kind only when the column mixes kinds.`,
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
      message: `row has ${Array.isArray(sec.rows[bad]) ? sec.rows[bad].length : 'no'} cells, header has ${n}. FIX: every row must be an array with exactly one entry per column, in the same order — pad missing values with null rather than shortening the row.`,
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
      message: `${k} must be a string or an array of strings, got ${Array.isArray(v) ? 'array of non-strings' : typeof v}. FIX: put the prose here and the structure in sections[]; an object in this field renders as "[object Object]" and takes the card down.`,
    })
  }
  return out
}

/** No takeaway. The card renders a headline, a table, a scope and a caveat, and never says what any of it
 *  MEANS — the reader is handed the working and left to draw the conclusion. Observed on a delivery-delay
 *  answer that found a real 72-day outlier and shipped `answer: null`: everything needed to see it was on the
 *  card, and nothing on the card said it. The contract calls this "the key takeaway"; an answer without one is
 *  an answer that stopped one sentence early. */
const noTakeaway: Rule = (a) => {
  if (a?.status && a.status !== 'answered') return []   // an unknowable or uncertain answer says its piece elsewhere
  const v = a?.answer
  const empty = v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.filter(Boolean).length)
  return empty ? [{
    rule: 'no-takeaway', severity: 'error', where: 'answer',
    message: 'the answer has no takeaway — the card shows figures and says nothing about them. FIX: set "answer" to the one thing the reader should take away (a short string, or an array of short strings). Not a restatement of the table.',
  }] : []
}

/** A headline that cannot be drawn. `display` is what the reader sees; without it the card has a number and
 *  no way to say it. */
const headlineShape: Rule = (a) => {
  const h = a?.headline
  if (h == null) return []
  if (typeof h !== 'object' || Array.isArray(h)) {
    return [{ rule: 'headline-shape', severity: 'error', where: 'headline', message: 'headline must be an object. FIX: emit {"label": <what the number IS>, "display": <the number short, with its unit>, "value": <the raw number>}.' }]
  }
  const out: Finding[] = []
  if (!h.label) out.push({ rule: 'headline-shape', severity: 'warning', where: 'headline.label', message: 'headline has no label, so the reader cannot tell what the number IS. FIX: add "label" — a short phrase naming the quantity.' })
  if (h.display == null && h.value == null) out.push({ rule: 'headline-shape', severity: 'error', where: 'headline', message: 'headline carries neither display nor value. FIX: add "value" (the raw number) and "display" (how it should read, with its unit).' })
  return out
}

const RULES: Array<{ name: string; run: Rule }> = [
  { name: 'id-without-kind', run: idWithoutKind },
  { name: 'kind-without-id', run: kindWithoutId },
  { name: 'redundant-cell-entity', run: redundantCellEntity },
  { name: 'row-width', run: rowWidth },
  { name: 'text-is-text', run: textIsText },
  { name: 'no-takeaway', run: noTakeaway },
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


// ════════════════════════════════════════════════════════════════════════════════════════════════════════
// PART 2 — WHAT THE ANSWER IS.  describeShape()
//
// The same traversal, asked a different question. Part 1 judges; this one describes, and they live together
// because two modules walking the same structure is how two definitions of "a column" appear and then drift.
//
// Printed by run.mjs into the agent's own tool output, beside the path to the full result. It exists because
// an agent shipped a twenty-row ranking of identical zeros having received the whole table — 4,773 characters,
// nothing truncated — and reported "Built and verified". Twenty rows of the same number are easy to skim;
// `1 distinct value` is not. This is LESS information than it already had, arranged so the pathology cannot be
// skimmed past.
//
// IT MUST NOT KNOW WHAT A TABLE IS. The answer format has grown before and will again, and a summariser that
// greps for sections[].kind === 'table' stops working the first time somebody adds a chart. It walks the VALUE,
// not the schema: wherever it finds an array of rows, it describes that array. A component invented next month
// is described on the day it is written, by nobody. Labels are taken opportunistically — duck-typed, never
// required — so a component that names its columns the same way gets named output for free, and one that does
// not falls back to positions and is still useful.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════

const MAX_ARRAYS = 4          // distinct row-arrays described
const MAX_COLS = 6            // columns named per array, notable ones first
const MIN_ROWS = 2            // one row cannot be "all the same"
// A LIST IS SAMPLED, NEVER SCANNED WHOLE. A summary that walks a million rows costs more than the answer it
// describes, and the statistics it produces are no better for it — a thousand rows settle "are these all the
// same", "are they mostly null", "how wide is the range". Past the cap the line says so, because a statistic
// over part of the data described as if it were all of it is the kind of small lie that gets believed.
const SCAN_CAP = 1000

type Row = unknown[] | Record<string, unknown>

/** An array worth describing: at least a couple of entries, all the same shape. */
function rowsOf(v: unknown): Row[] | null {
  if (!Array.isArray(v) || v.length < MIN_ROWS) return null
  if (v.every((e) => Array.isArray(e))) return v as Row[]
  if (v.every((e) => isRec(e))) return v as Row[]
  return null
}

/** Labels for the columns, IF something beside the rows looks like headers. Never required. */
function labelsFor(parent: unknown, width: number): string[] | null {
  if (!isRec(parent)) return null
  for (const v of Object.values(parent)) {
    if (!Array.isArray(v) || v.length !== width) continue
    const names = v.map((c) => (isRec(c) && typeof c.label === 'string' ? c.label : null))
    if (names.every((n) => n)) return names as string[]
  }
  return null
}

// The cheap statistics — the ones a scan already has in hand. No percentiles, no histograms: the point is to
// make a column's character visible in a few words, not to analyse it. The agent has the path to the full
// output and can compute anything it actually needs.
interface ColStat {
  name: string; n: number; distinct: number; nulls: number
  min?: number; max?: number; mean?: number; zeros?: number; negatives?: number
  sample?: unknown
}

function statsFor(rows: Row[]): ColStat[] {
  const keys: (string | number)[] = Array.isArray(rows[0])
    ? (rows[0] as unknown[]).map((_, i) => i)
    : Object.keys(rows[0] as Record<string, unknown>)
  return keys.map((k) => {
    // ONE PASS, and nothing that allocates per row beyond the distinct set. Six chained .filter() calls over
    // the same column was six walks to learn what one walk knows, and Math.min(...nums) spreads the array into
    // arguments — fine at a thousand rows, a stack overflow at a hundred thousand, and this file should not
    // depend on a cap elsewhere staying where it is.
    const seen = new Set<unknown>()
    let nulls = 0, count = 0, sum = 0, zeros = 0, negatives = 0
    let min = Infinity, max = -Infinity, sample: unknown
    for (const r of rows) {
      const v = Array.isArray(r) ? (r as unknown[])[k as number] : (r as any)[k]
      seen.add(typeof v === 'object' && v !== null ? JSON.stringify(v) : v)
      if (v == null) { nulls++; continue }
      if (sample === undefined) sample = v
      if (typeof v === 'number') {
        count++; sum += v
        if (v < min) min = v
        if (v > max) max = v
        if (v === 0) zeros++
        if (v < 0) negatives++
      }
    }
    const st: ColStat = { name: String(k), n: rows.length, distinct: seen.size, nulls, sample }
    if (count) { st.min = min; st.max = max; st.mean = sum / count; st.zeros = zeros; st.negatives = negatives }
    return st
  })
}

/** A column worth putting first: it says one thing on every row, says nothing at all, or is mostly empty. */
const notable = (c: ColStat, rows: number) =>
  c.nulls === rows || (rows >= MIN_ROWS && c.distinct === 1) || c.nulls > rows / 2 ||
  (c.zeros !== undefined && c.zeros > rows / 2)

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

function describeCol(c: ColStat, rows: number, label: string): string {
  // The flags come first and stand alone: a column that is all one value has no useful range, and printing
  // one beside the flag invites reading past it.
  if (c.nulls === rows) return `⚠ '${label}' all ${rows} null`
  if (c.distinct === 1) return `⚠ '${label}' all ${rows} rows = ${typeof c.sample === 'number' ? num(c.sample) : JSON.stringify(c.sample)}`
  const parts: string[] = [`${c.distinct} distinct`]
  if (c.min !== undefined && c.max !== undefined) parts.push(`${num(c.min)}–${num(c.max)}`)
  if (c.mean !== undefined && c.min !== c.max) parts.push(`mean ${num(c.mean)}`)
  if (c.nulls) parts.push(`${c.nulls} null`)
  if (c.zeros) parts.push(`${c.zeros} zero`)
  if (c.negatives) parts.push(`${c.negatives} negative`)
  const flag = c.nulls > rows / 2 || (c.zeros ?? 0) > rows / 2 ? '⚠ ' : ''
  return `${flag}'${label}' ${parts.join(', ')}`
}

/** One line per row-array found anywhere in the value. Notable columns first, because the reason this is
 *  printed at all is to make a degenerate one impossible to miss. */
export function describeShape(output: unknown): string[] {
  const out: string[] = []
  const seen = new Set<unknown>()

  // FIRST, find the arrays that are HEADERS for another array and take them out of consideration. Without
  // this the column definitions get described as data — "rows 6 × 2 · 'label' 6 distinct" — which is true,
  // useless, and appears above the rows it describes because it comes first in the object. An array serving
  // as another's labels has already been accounted for. Still no schema knowledge: the test is the same
  // duck-typing labelsFor uses, applied in reverse.
  const headers = new Set<unknown>()
  const findHeaders = (v: unknown) => {
    if (v == null || typeof v !== 'object') return
    if (isRec(v)) {
      for (const child of Object.values(v)) {
        const rows = rowsOf(child)
        if (rows && Array.isArray(rows[0])) {
          const w = (rows[0] as unknown[]).length
          for (const sib of Object.values(v)) {
            if (sib === child || !Array.isArray(sib) || sib.length !== w) continue
            if (sib.every((c) => isRec(c) && typeof (c as any).label === 'string')) headers.add(sib)
          }
        }
      }
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) findHeaders(child)
  }
  try { findHeaders(output) } catch { /* best effort */ }

  const walk = (v: unknown, parent: unknown) => {
    if (headers.has(v)) return
    if (out.length >= MAX_ARRAYS || v == null || typeof v !== 'object' || seen.has(v)) return
    seen.add(v)
    const all = rowsOf(v)
    if (all) {
      const rows = all.length > SCAN_CAP ? all.slice(0, SCAN_CAP) : all
      const stats = statsFor(rows)
      const labels = Array.isArray(rows[0]) ? labelsFor(parent, (rows[0] as unknown[]).length) : null
      const named = stats.map((c, i) => ({ c, label: labels?.[i] ?? c.name }))
      const ordered = [...named].sort((a, b) =>
        Number(notable(b.c, rows.length)) - Number(notable(a.c, rows.length)))
      const shown = ordered.slice(0, MAX_COLS).map(({ c, label }) => describeCol(c, rows.length, label))
      const more = ordered.length > MAX_COLS ? ` (+${ordered.length - MAX_COLS} more)` : ''
      const scanned = all.length > SCAN_CAP ? ` (first ${SCAN_CAP} of ${all.length})` : ''
      out.push(`rows ${all.length} × ${stats.length}${scanned} · ${shown.join(' · ')}${more}`)
      return   // do not descend into the rows themselves
    }
    for (const child of Array.isArray(v) ? v : Object.values(v)) walk(child, v)
  }

  try { walk(output, null) } catch { /* a summary that throws is worse than no summary */ }
  return out
}
