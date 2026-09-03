// CHECK — re-run the program behind the answer on screen, with the SAME parameters, and say what moved.
//
// NO LLM ANYWHERE IN THIS PATH. Running a program is computation and comparing two numbers is arithmetic;
// neither needs a model, and a model asked to judge "did this change matter?" would be the one part of the
// answer nobody could check. So this reports the difference and the reader decides.
//
// WHAT IT DOES NOT DO: it does not tell you the answer is RIGHT. A program with a wrong filter re-runs
// consistently wrong and check will happily report "unchanged". It detects DRIFT — the data moved underneath
// an answer — and nothing more. The report says so, because a green tick people misread as verification is
// worse than no tick.
//
// THE BASELINE IS THE SAVED ANSWER, NOT program.json. run.mjs rewrites program.json on every run, including a
// run of the same program for somebody else's question with different parameters. Diffing against it would
// sometimes compare this answer with a different asking of the same program and report a change that never
// happened to the person reading.

export interface Movement {
  what: string                 // what moved, in the reader's words ("Total billed revenue", "Jobs by pillar")
  before: string
  after: string
  delta?: string               // only for numbers we can subtract
}

export interface CheckDiff {
  changed: boolean
  movements: Movement[]
  note?: string                // something structural we could not diff cleanly
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const txt = (v: unknown): string => v == null ? '—' : typeof v === 'string' ? v : JSON.stringify(v)

/** A signed delta with a percentage when the baseline is non-zero — the two things a reader checks first. */
function delta(before: number, after: number): string {
  const d = after - before
  const sign = d > 0 ? '+' : ''
  const pct = before !== 0 ? ` (${sign}${((d / Math.abs(before)) * 100).toFixed(1)}%)` : ''
  return `${sign}${d}${pct}`
}

/** Tables and KPI strips, keyed by their title/label so a reordered answer doesn't read as a change. */
function sectionsOf(a: any): { tables: Map<string, number>; kpis: Map<string, string> } {
  const tables = new Map<string, number>()
  const kpis = new Map<string, string>()
  const secs: any[] = Array.isArray(a?.sections) ? a.sections : []
  for (const [i, s] of secs.entries()) {
    if (s?.kind === 'table') tables.set(String(s.title ?? `table ${i + 1}`), Array.isArray(s.rows) ? s.rows.length : 0)
    else if (s?.kind === 'kpis') for (const it of (Array.isArray(s.items) ? s.items : [])) kpis.set(String(it?.label ?? ''), txt(it?.display ?? it?.value))
  }
  // Programs written before sections existed emit a flat top-level `table`, and plenty are still in use.
  if (a?.table?.columns && !tables.size) tables.set(String(a.table.title ?? 'table'), Array.isArray(a.table.rows) ? a.table.rows.length : 0)
  return { tables, kpis }
}

/** What moved between the answer that was shown and the answer the program gives now. */
export function diffAnswers(before: any, after: any): CheckDiff {
  const movements: Movement[] = []

  if (String(before?.status ?? '') !== String(after?.status ?? '')) {
    movements.push({ what: 'Status', before: txt(before?.status), after: txt(after?.status) })
  }

  // The headline is the number the person actually read, so it is compared on its raw value — `display` is
  // formatted and would report a change when only the rounding moved.
  const bv = before?.headline?.value, av = after?.headline?.value
  const label = String(before?.headline?.label ?? after?.headline?.label ?? 'Headline')
  if (isNum(bv) && isNum(av)) {
    if (bv !== av) movements.push({ what: label, before: txt(before?.headline?.display ?? bv), after: txt(after?.headline?.display ?? av), delta: delta(bv, av) })
  } else if (txt(bv) !== txt(av)) {
    movements.push({ what: label, before: txt(before?.headline?.display ?? bv), after: txt(after?.headline?.display ?? av) })
  }

  const B = sectionsOf(before), A = sectionsOf(after)
  for (const [title, bRows] of B.tables) {
    if (!A.tables.has(title)) { movements.push({ what: title, before: `${bRows} rows`, after: 'gone' }); continue }
    const aRows = A.tables.get(title)!
    if (bRows !== aRows) movements.push({ what: title, before: `${bRows} rows`, after: `${aRows} rows`, delta: delta(bRows, aRows) })
  }
  for (const [title, aRows] of A.tables) if (!B.tables.has(title)) movements.push({ what: title, before: 'not there', after: `${aRows} rows` })

  for (const [k, bVal] of B.kpis) {
    const aVal = A.kpis.get(k)
    if (aVal === undefined) movements.push({ what: k, before: bVal, after: 'gone' })
    else if (aVal !== bVal) movements.push({ what: k, before: bVal, after: aVal })
  }
  for (const [k, aVal] of A.kpis) if (!B.kpis.has(k)) movements.push({ what: k, before: 'not there', after: aVal })

  const note = (!movements.length && !isNum(av) && !B.tables.size && !B.kpis.size)
    ? 'This answer has no figure or table to compare, so there was nothing to measure.'
    : undefined

  return { changed: movements.length > 0, movements, note }
}

/** The report, as markdown. Deterministic — same inputs, same words. */
export function checkReport(o: {
  programDir: string
  params: unknown
  answeredAt?: number
  ms: number
  diff: CheckDiff
}): string {
  const when = o.answeredAt ? new Date(o.answeredAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'earlier'
  const head = o.diff.changed
    ? `**The figures have moved** since this was answered (${when}).`
    : `**Unchanged.** Re-running it now gives the same figures as when it was answered (${when}).`

  const table = o.diff.movements.length
    ? '\n\n| | was | now | change |\n| --- | --- | --- | --- |\n' +
      o.diff.movements.map(m => `| ${m.what} | ${m.before} | ${m.after} | ${m.delta ?? ''} |`).join('\n')
    : ''

  const params = o.params && Object.keys(o.params as any).length
    ? `\n\nRe-run with the same parameters it was answered with: \`${JSON.stringify(o.params)}\`.`
    : '\n\nRe-run with no parameters, exactly as it was answered.'

  // Said every time, including when nothing moved — this is the sentence that stops "check passed" being read
  // as "the answer is correct".
  const caveat = `\n\nThis compares today's run against the saved answer, so it catches the data changing underneath. It cannot tell you the answer is right — if the program itself is wrong, it is wrong the same way both times.`

  // Plain text, no HTML: the renderer escapes tags, so a `<small>` here reaches the reader as literal markup.
  const foot = `\n\n\`${o.programDir}\` · re-ran in ${(o.ms / 1000).toFixed(1)}s${o.diff.note ? ` · ${o.diff.note}` : ''}`
  return `${head}${table}${params}${caveat}${foot}`
}

/** The report as an answer card — markdown in a text section, like explain. No headline: the figure here
 *  belongs to the answer being checked, and repeating it as this card's own would invite reading the check as
 *  a fresh result. */
export function checkAnswer(markdown: string, programDir: string) {
  return {
    status: 'answered',
    category: 'analysis',
    sections: [{ kind: 'text', body: markdown }],
    scope: `Re-ran ${programDir} to compare against the saved answer.`,
  }
}
