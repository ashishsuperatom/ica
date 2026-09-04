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

import type { ProgramTarget } from './index.js'

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

/** The report, as markdown. Deterministic — same inputs, same words. Kept SHORT: it sits above the answer
 *  itself now, so it says what moved and then gets out of the way.
 *
 *  `diff` is absent when there is no earlier answer to compare against — a program named directly that has
 *  never been answered in this project. That is a re-run, not a check, and it says so rather than inventing a
 *  baseline of zero. */
export function checkReport(o: {
  programDir: string
  params: unknown
  answeredAt?: number
  ms: number
  diff?: CheckDiff
}): string {
  const when = o.answeredAt ? new Date(o.answeredAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'earlier'

  const head = !o.diff
    ? `**Re-ran \`${o.programDir}\`.** There is no saved answer for it to compare against, so this is the result as of now.`
    : o.diff.changed
      ? `**The figures have moved** since ${when}.`
      : `**Unchanged** since ${when} — re-running it now gives the same figures.`

  const table = o.diff?.movements.length
    ? '\n\n| | was | now | change |\n| --- | --- | --- | --- |\n' +
      o.diff.movements.map(m => `| ${m.what} | ${m.before} | ${m.after} | ${m.delta ?? ''} |`).join('\n')
    : ''

  // Said on every comparison, including "unchanged" — the sentence that stops a green tick being read as
  // verification. One line, at the end, where it does not push the finding down the page.
  const caveat = o.diff
    ? '\n\nThis catches the data changing underneath; it cannot tell you the answer is right — a wrong program is wrong the same way twice.'
    : ''
  const params = o.params && Object.keys(o.params as any).length ? ` · ${JSON.stringify(o.params)}` : ''
  const foot = `\n\n\`${o.programDir}\`${params} · ${(o.ms / 1000).toFixed(1)}s` + (o.diff?.note ? ` · ${o.diff.note}` : '')

  return `${head}${table}${caveat}${foot}`
}

/** The check, ON TOP OF the answer it just produced.
 *
 *  We ran the program in order to compare it, so the fresh result is already in hand — and a comparison
 *  shown without it describes figures the reader cannot see. `fresh` is that run's answer card; the report
 *  goes in as its first section, so the verdict comes first and today's actual numbers follow.
 *
 *  With no fresh answer (the program failed to run) the report stands alone — which is itself the finding. */
export function checkAnswer(markdown: string, programDir: string, fresh?: any) {
  const note = { kind: 'text', body: markdown }
  if (!fresh || typeof fresh !== 'object') {
    return { status: 'answered', category: 'check', sections: [note], scope: `Re-ran ${programDir}.` }
  }
  return {
    ...fresh,
    category: 'check',
    sections: [note, ...(Array.isArray(fresh.sections) ? fresh.sections : [])],
    scope: fresh.scope ? `${fresh.scope} · re-run to compare` : `Re-ran ${programDir} to compare against the saved answer.`,
  }
}


// ── WHICH PROGRAM ─────────────────────────────────────────────────────────────────────────────────────────
// `check:` on its own means the answer on screen. `check: <something>` names its own subject, so a program can
// be re-run from anywhere — a different chat, days later, or from the re-run button on an old answer card.
//
// TWO WAYS TO NAME ONE, and the qid is the good one: an answer row already carries the programDir AND the
// params it was run with, so a qid re-runs that exact computation with nothing guessed. A program name re-runs
// the program but has to borrow parameters from its most recent answer, which may have been someone else's
// question. Both are lookups — no model is asked to work out what the user meant.

export interface CheckSubject { programDir: string; params: unknown; question?: string; qid?: string; baseline?: { answer: any; createdAt: number } }

export function resolveCheckTarget(rest: string, d: {
  onScreen: ProgramTarget | null
  answerFor: (qid: string) => { programDir?: string; params?: unknown; question?: string; answer?: any; createdAt: number } | null
  latestForProgram: (dir: string) => { qid: string; params?: unknown; question?: string; answer?: any; createdAt: number } | null
  programExists: (dir: string) => boolean
}): { subject: CheckSubject } | { error: string } {
  const text = rest.trim()

  // Nothing named → what is on screen. Its baseline comes from its own qid, so it is the same lookup.
  if (!text) {
    const t = d.onScreen
    if (!t?.programDir) return { error: 'There is no answer on screen to check yet — ask a question first, then `check:` it. You can also name one: `check: <question id>` or `check: <program name>`.' }
    const prior = t.qid ? d.answerFor(t.qid) : null
    return { subject: { programDir: t.programDir, params: t.params ?? {}, question: t.question, qid: t.qid,
                        baseline: prior?.answer ? { answer: prior.answer, createdAt: prior.createdAt } : undefined } }
  }

  // A question id. Exact — an id either exists or it does not, so there is no near-match to get wrong.
  const byQid = d.answerFor(text)
  if (byQid?.programDir && d.programExists(byQid.programDir)) {
    return { subject: { programDir: byQid.programDir, params: byQid.params ?? {}, question: byQid.question, qid: text,
                        baseline: byQid.answer ? { answer: byQid.answer, createdAt: byQid.createdAt } : undefined } }
  }
  if (byQid && !byQid.programDir) return { error: `Answer \`${text}\` was not produced by a program, so there is nothing to re-run.` }
  if (byQid) return { error: `Answer \`${text}\` names \`${byQid.programDir}\`, but that program is no longer in the workspace.` }

  // A program name. Accept it with or without the `programs/` prefix, and with a trailing slash — all three
  // are what a person copies out of a report.
  const bare = text.replace(/\/+$/, '')
  const dir = [bare, `programs/${bare}`].find(c => d.programExists(c))
  if (!dir) return { error: `Nothing here is called \`${text}\` — it is neither a question id nor a program in this workspace.` }
  const last = d.latestForProgram(dir)
  return { subject: { programDir: dir, params: last?.params ?? {}, question: last?.question, qid: last?.qid,
                      baseline: last?.answer ? { answer: last.answer, createdAt: last.createdAt } : undefined } }
}
