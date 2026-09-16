// ── VERBS ON THE ANSWER ON SCREEN, FOR ANSWERS BUILT ON THE SEMANTIC GRAPH ────────────────────────────────────
//
// A person starts a message with a verb to say what kind of turn it is (verbs/index.ts, before the migration):
//
//   view: <Entity> <id> [lens]   look at one record: its view program, built once per kind and lens, run with {id}
//   run:  [qid]                  run the program behind an answer again, with the parameters it was run with
//   check: [qid]                 run it again and say what moved against the answer that was shown
//   program: [qid]               show the program and the parameters it was run with
//   explain: [what]              say how the answer on screen was reached, from its program and its recorded run
//   edit: <change>               change the program on screen (mostly how it shows its answer) and run it again
//
// Only these words match, and only at the very start. Bare `run:`/`check:`/`program:` mean the answer on screen;
// a question id names another. The subject is always a recorded call: its program source and parameters are in
// memory, so nothing is guessed and no model is needed to run or check.

export type Verb = 'edit' | 'explain' | 'run' | 'check' | 'program' | 'view'
export interface VerbMatch { verb: Verb; raw: string; rest: string }

const SPELLINGS: Record<string, Verb> = { edit: 'edit', modify: 'edit', explain: 'explain', run: 'run', rerun: 'run', 're-run': 'run', check: 'check', program: 'program', view: 'view' }
const NEEDS_TEXT: Record<Verb, boolean> = { edit: true, view: true, explain: false, run: false, check: false, program: false }
export const CATEGORY: Record<Verb, string> = { edit: 'analysis', explain: 'explanation', run: 'answer', check: 'check', program: 'program', view: 'view' }

export function parseVerb(input: string): VerbMatch | null {
  const raw = input.replace(/^\s+/, '')
  const m = /^([a-z][a-z-]*)\s*:/i.exec(raw)
  const verb = m ? SPELLINGS[m[1].toLowerCase()] : undefined
  if (!m || !verb) return null
  const rest = raw.slice(m[0].length).trim()
  return !rest && NEEDS_TEXT[verb] ? null : { verb, raw, rest }
}

export interface ViewRef { entity: string; id: string; lens: string }
/** `<Entity> <id> [lens…]` — the entity as the graph names it; its view is one program per kind and lens. */
export function parseView(rest: string, entities: string[]): ViewRef | { error: string } {
  const [kind, id, ...lens] = rest.trim().split(/\s+/)
  const entity = entities.find((e) => e.toLowerCase() === (kind ?? '').toLowerCase())
  if (!entity || !id) return { error: `Say what to look at: \`view: <kind> <id>\`, where the kind is one of ${entities.join(', ')}.` }
  return { entity, id, lens: lens.length ? lens.join(' ').toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'canonical' }
}
export const viewFile = (v: ViewRef) => `${v.entity.toLowerCase()}.${v.lens}.mjs`

export function viewPrompt(v: ViewRef): string {
  return `view: ${v.entity} ${v.id}${v.lens === 'canonical' ? '' : ` ${v.lens}`}

Write a view of one ${v.entity}${v.lens === 'canonical' ? '' : ` through the lens "${v.lens}"`}: what someone opening it wants to see at a glance.
Its only parameter is id, so the same program serves every ${v.entity}, with the same shape each time. Write it as program.mjs, run
./run-program program.mjs '${JSON.stringify({ id: v.id })}', and ./commit it.`
}

export function explainPrompt(raw: string, s: { qid?: string; callId: string; program: boolean }): string {
  return `${raw}

The person asks how the answer on screen was reached. It is the recorded run ${s.callId}: ./behind ${s.callId} shows it${s.program && s.qid ? `, and its program is out/${s.qid}/program.mjs with out/${s.qid}/params.json` : ''}.
Answer what they asked, at the length that answers it, in plain language, and write it as markdown to out/<qid>/explain.md.`
}

export function editPrompt(raw: string, rest: string, s: { qid: string; params: unknown }): string {
  return `${raw}

Change the program behind the answer on screen: out/${s.qid}/program.mjs, run with ${JSON.stringify(s.params)}. Copy it to program.mjs,
make the change "${rest}", run ./run-program program.mjs '${JSON.stringify(s.params)}', and ./commit it.`
}

/** A program's source and parameters as the files a surface shows. */
export function programAnswer(name: string, source: string, params: unknown) {
  return {
    status: 'answered' as const, category: CATEGORY.program,
    answer: `\`${name}\`, run with \`${JSON.stringify(params)}\`.`,
    sections: [{ kind: 'files' as const, title: name, files: [
      { path: 'program.mjs', text: source, bytes: Buffer.byteLength(source) },
      { path: 'params.json', text: JSON.stringify(params, null, 2), bytes: Buffer.byteLength(JSON.stringify(params, null, 2)) },
    ] }],
  }
}

export const explainAnswer = (markdown: string, callId: string) =>
  ({ status: 'answered' as const, category: CATEGORY.explain, sections: [{ kind: 'text' as const, body: markdown.trim() }], scope: `Explanation of ${callId}; no data was read again.` })

// ── check: what moved (verbs/check.ts, before the migration) ──

export interface Movement { what: string; before: string; after: string; delta?: string }
export interface CheckDiff { changed: boolean; movements: Movement[]; note?: string }

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


