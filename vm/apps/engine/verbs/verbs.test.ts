// Run:  cd vm && pnpm exec tsx --test apps/engine/verbs/verbs.test.ts
//
// The verb layer is the one place a user's ordinary question can be silently turned into a command, and the
// one place a "nothing changed" can be silently wrong. Both are failures nobody would notice, so they are
// pinned here.
import { test } from 'node:test'
import assert from 'node:assert'
import { parseVerb, VERBS } from './index.js'
import { diffAnswers, checkReport } from './check.js'

test('parseVerb recognises the verbs and keeps the raw text', () => {
  for (const [input, verb, rest] of [
    ['explain: why is revenue down', 'explain', 'why is revenue down'],
    ['EXPLAIN : why is revenue down', 'explain', 'why is revenue down'],   // case and a space before the colon
    ['  edit: top 10 only', 'edit', 'top 10 only'],
    ['modify: exclude internal jobs', 'edit', 'exclude internal jobs'],    // both spellings, one verb
    ['check: is that still true', 'check', 'is that still true'],
  ] as const) {
    const got = parseVerb(input)
    assert.equal(got?.verb, verb, input)
    assert.equal(got?.rest, rest, input)
    assert.equal(got?.raw, input.trimStart(), `raw must survive for the log: ${input}`)
  }
})

test('parseVerb does NOT hijack an ordinary question', () => {
  // The whole reason the verb set is closed. Each of these would become a command under a "any word + colon"
  // rule, and the user would never be told their question had been reinterpreted.
  for (const input of ['Q1: revenue by region', 'Note: exclude internal jobs', '2026: how did we do',
                       'what does edit: mean', 'edit:']) {
    assert.equal(parseVerb(input), null, input)
  }
})

test('check: and explain: stand alone — the verb IS the whole instruction', () => {
  // check re-runs the same program with the same parameters; there is nothing to say beyond the word, and
  // "check:" on its own is how anyone would type it. Requiring an argument sent that one word off to be
  // answered as a brand-new question — a full build, narrator and all. edit: still needs to say what to change.
  for (const input of ['check:', 'check:  ', 'explain:', 'program:']) {
    const got = parseVerb(input)
    assert.ok(got, `${input} must parse`)
    assert.equal(got!.rest, '')
  }
  assert.equal(parseVerb('edit:'), null, 'an edit with no change requested is not an instruction')
})

const answer = (value: number | null, rows: number, title = 'By pillar') => ({
  status: 'answered',
  headline: value == null ? undefined : { label: 'Total', display: `$${value}`, value },
  sections: [{ kind: 'table', title, columns: ['a'], rows: Array.from({ length: rows }, (_, i) => [i]) }],
})

test('check reports a figure that moved, with the delta', () => {
  const d = diffAnswers(answer(100, 3), answer(110, 3))
  assert.equal(d.changed, true)
  assert.deepEqual(d.movements.map(m => [m.what, m.before, m.after, m.delta]),
    [['Total', '$100', '$110', '+10 (+10.0%)']])
})

test('check reports a row count that moved', () => {
  const d = diffAnswers(answer(100, 3), answer(100, 5))
  assert.deepEqual(d.movements.map(m => [m.what, m.before, m.after]), [['By pillar', '3 rows', '5 rows']])
})

test('check stays silent when nothing moved', () => {
  assert.equal(diffAnswers(answer(100, 3), answer(100, 3)).changed, false)
})

test('a REORDERED answer is not a change', () => {
  // Sections are keyed by title for exactly this reason: a program that emits its sections in a different
  // order is the same answer, and reporting it as movement would train the reader to ignore check.
  const a = { status: 'answered', sections: [{ kind: 'table', title: 'B', rows: [[1]] }, { kind: 'table', title: 'A', rows: [[1], [2]] }] }
  const b = { status: 'answered', sections: [{ kind: 'table', title: 'A', rows: [[1], [2]] }, { kind: 'table', title: 'B', rows: [[1]] }] }
  assert.equal(diffAnswers(a, b).changed, false)
})

test('a formatting-only change is not a change', () => {
  // The headline is compared on its raw `value`; `display` is formatted, so comparing it would report movement
  // when only the rounding moved.
  const a = { status: 'answered', headline: { label: 'X', display: '$1,000', value: 1000 }, sections: [] }
  const b = { status: 'answered', headline: { label: 'X', display: '$1.0K', value: 1000 }, sections: [] }
  assert.equal(diffAnswers(a, b).changed, false)
})

test('a zero baseline gets no percentage', () => {
  const d = diffAnswers({ status: 'answered', headline: { label: 'X', display: '0', value: 0 }, sections: [] },
                        { status: 'answered', headline: { label: 'X', display: '5', value: 5 }, sections: [] })
  assert.equal(d.movements[0].delta, '+5')
})

test('a changed status is reported', () => {
  assert.deepEqual(diffAnswers({ status: 'answered', sections: [] }, { status: 'uncertain', sections: [] })
    .movements.map(m => m.what), ['Status'])
})

test('the older flat `table` format is still compared', () => {
  // Programs written before sections existed are still in use; dropping them would make check say "unchanged"
  // about an answer it never actually looked at.
  const legacy = (rows: number) => ({ status: 'answered', table: { title: 'Old', columns: ['a'], rows: Array.from({ length: rows }, () => [1]) } })
  assert.deepEqual(diffAnswers(legacy(2), legacy(4)).movements.map(m => [m.what, m.before, m.after]),
    [['Old', '2 rows', '4 rows']])
})

test('a KPI value that moved is reported', () => {
  const kpi = (v: string) => ({ status: 'answered', sections: [{ kind: 'kpis', items: [{ label: 'Margin', display: v }] }] })
  assert.deepEqual(diffAnswers(kpi('12%'), kpi('14%')).movements.map(m => [m.what, m.before, m.after]),
    [['Margin', '12%', '14%']])
})

test('an answer with nothing measurable says so', () => {
  const prose = { status: 'answered', answer: 'some prose', sections: [] }
  assert.ok(diffAnswers(prose, prose).note, 'must not silently claim "unchanged" when it compared nothing')
})

test('every report carries the caveat and the parameters — changed or not', () => {
  // "check passed" read as "the answer is correct" is the one way this feature could make things worse.
  for (const diff of [diffAnswers(answer(100, 3), answer(100, 3)), diffAnswers(answer(100, 3), answer(110, 4))]) {
    const md = checkReport({ programDir: 'programs/x', params: { year: 2026 }, answeredAt: Date.UTC(2026, 8, 1), ms: 1234, diff })
    assert.ok(md.includes('cannot tell you the answer is right'))
    assert.ok(md.includes('{"year":2026}'))
    assert.ok(!md.includes('<'), 'no raw HTML — the renderer escapes it and the reader sees the markup')
  }
})

test('program: collects source as RELATIVE paths, files before folders', async () => {
  // An absolute path on someone's screen tells them nothing and exposes the machine's layout, so the engine
  // only ever sends paths relative to the program directory.
  const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { collectProgramFiles } = await import('./program.js')

  const ws = await mkdtemp(join(tmpdir(), 'sa-prog-'))
  await mkdir(join(ws, 'programs/p/units'), { recursive: true })
  await mkdir(join(ws, 'programs/p/node_modules'), { recursive: true })
  await writeFile(join(ws, 'programs/p/program.ts'), 'export default 1')
  await writeFile(join(ws, 'programs/p/program.json'), '{"root":"x"}')
  await writeFile(join(ws, 'programs/p/units/total.ts'), 'export default 2')
  await writeFile(join(ws, 'programs/p/units/notes.txt'), 'ignored — not source')
  await writeFile(join(ws, 'programs/p/node_modules/dep.ts'), 'must not appear')

  const files = await collectProgramFiles(ws, 'programs/p')
  assert.deepEqual(files.map(f => f.path), ['program.json', 'program.ts', 'units/total.ts'])
  assert.ok(!files.some(f => f.path.includes('node_modules')), 'dependencies are not the program')
  assert.ok(!files.some(f => f.path.startsWith('/')), 'never an absolute path')
  assert.equal(files.find(f => f.path === 'program.ts')!.text, 'export default 1')
})

test('program: says so rather than showing an empty pane', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { programAnswer } = await import('./program.js')
  await mkdtemp(join(tmpdir(), 'sa-prog-'))
  const a: any = programAnswer('programs/gone', [])
  assert.equal(a.status, 'cannot_answer')
})

test('view: parses a kind, an id, and an optional lens', async () => {
  const { parseView, viewDir, viewLabel } = await import('./view.js')
  assert.deepEqual(parseView('customer 431'), { type: 'customer', id: '431', lens: 'canonical' })
  assert.deepEqual(parseView('customer 431 projects'), { type: 'customer', id: '431', lens: 'projects' })
  // However it was typed, the same view must land in the same directory — or the second asking builds a
  // second program and the whole reuse argument is lost.
  assert.equal(viewDir(parseView('Customer 431 Open Projects')!), 'programs/view.customer.open-projects')
  assert.equal(viewDir(parseView('customer 431 open   projects')!), 'programs/view.customer.open-projects')
  assert.equal(viewLabel(parseView('customer 431')!), 'customer 431')
  assert.equal(viewLabel(parseView('customer 431 projects')!), 'customer 431 (projects)')
})

test('view: needs something to look at', async () => {
  const { parseView } = await import('./view.js')
  assert.equal(parseView('customer'), null, 'a kind with no id names nothing')
  assert.equal(parseView(''), null)
})

test('only edit:, explain: and program: are tied to the answer on screen', () => {
  // A verb that names its subject can be used from anywhere — a different chat, an old card's re-run button.
  // edit: and explain: cannot: there is no way to say WHICH answer you mean except by looking at it.
  assert.equal(VERBS.view.needsCurrentProgram, false)
  assert.equal(VERBS.check.needsCurrentProgram, false)
  assert.equal(VERBS.run.needsCurrentProgram, false)
  for (const v of ['edit', 'explain', 'program'] as const) assert.equal(VERBS[v].needsCurrentProgram, true, v)
  // Only a view PERSISTS: a view IS an answer, which is what lets edit: improve it afterwards. The reporting
  // verbs must not enter the intent graph, or retrieval could later serve an explanation to someone who asked
  // for a number.
  assert.equal(VERBS.view.persists, true)
  for (const v of ['explain', 'run', 'check', 'program'] as const) assert.equal(VERBS[v].persists, false, v)
})

test('run: and check: are different verbs over the same subject, and neither uses a model', () => {
  // The re-run button asks "what is it now?" — answering that with a diff hands back a comparison nobody asked
  // for, with the figures it is about left out. They share resolveProgramSubject and nothing else.
  assert.notEqual(VERBS.run.category, VERBS.check.category)
  for (const v of ['run', 'check', 'program'] as const) assert.equal(VERBS[v].usesAgent, false, v)
})

test('re-run:, rerun: and run: are the same verb', async () => {
  const { parseVerb } = await import('./index.js')
  for (const spelled of ['run: q-old', 'rerun: q-old', 're-run: q-old', 'RUN: q-old']) {
    const m = parseVerb(spelled)
    assert.equal(m?.verb, 'run', spelled)
    assert.equal(m?.rest, 'q-old', spelled)
  }
  // Bare, with no subject, still fires — it means the answer on screen.
  assert.equal(parseVerb('run:')?.verb, 'run')
  // The hyphen in the pattern must not turn an ordinary question into a command.
  assert.equal(parseVerb('Year-on-year: how did we do'), null)
})

// ── check: naming its own subject ─────────────────────────────────────────────────────────────────────────
const store = {
  onScreen: { programDir: 'programs/on-screen', question: 'what is on screen', params: { a: 1 }, qid: 'q-screen' } as any,
  answerFor: (q: string) => q === 'q-screen' ? { programDir: 'programs/on-screen', params: { a: 1 }, answer: { status: 'answered' }, createdAt: 100 }
            : q === 'q-old' ? { programDir: 'programs/revenue', params: { year: 2025 }, question: 'revenue?', answer: { status: 'answered' }, createdAt: 50 }
            : q === 'q-noprog' ? { programDir: undefined, params: undefined, answer: {}, createdAt: 10 }
            : q === 'q-gone' ? { programDir: 'programs/deleted', params: {}, answer: {}, createdAt: 10 }
            : null,
  latestForProgram: (d: string) => d === 'programs/revenue' ? { qid: 'q-old', params: { year: 2025 }, question: 'revenue?', answer: { status: 'answered' }, createdAt: 50 } : null,
  programExists: (d: string) => d === 'programs/on-screen' || d === 'programs/revenue',
}

test('bare check: is the answer on screen, with its own saved answer as the baseline', async () => {
  const { resolveProgramSubject } = await import('./check.js')
  const r = resolveProgramSubject('', store) as any
  assert.equal(r.subject.programDir, 'programs/on-screen')
  assert.deepEqual(r.subject.params, { a: 1 })
  assert.equal(r.subject.baseline.createdAt, 100)
})

test('check: <question id> re-runs THAT answer with the parameters it was answered with', async () => {
  // The whole point: an answer row carries the program AND its parameters, so any past answer can be re-run
  // exactly, from any chat, with no model asked to work out what was meant.
  const { resolveProgramSubject } = await import('./check.js')
  const r = resolveProgramSubject('q-old', store) as any
  assert.equal(r.subject.programDir, 'programs/revenue')
  assert.deepEqual(r.subject.params, { year: 2025 })
  assert.equal(r.subject.baseline.createdAt, 50)
})

test('check: <program name> works with or without the programs/ prefix', async () => {
  const { resolveProgramSubject } = await import('./check.js')
  for (const named of ['revenue', 'programs/revenue', 'programs/revenue/']) {
    const r = resolveProgramSubject(named, store) as any
    assert.equal(r.subject.programDir, 'programs/revenue', named)
  }
})

test('check: says what went wrong rather than re-running something else', async () => {
  // Every failure names the thing that was not found. Falling back to the answer on screen would re-run the
  // wrong program and report its figures under the name the user typed.
  const { resolveProgramSubject } = await import('./check.js')
  for (const bad of ['nope', 'q-noprog', 'q-gone']) {
    const r = resolveProgramSubject(bad, store) as any
    assert.ok(r.error, bad)
    assert.equal(r.subject, undefined, bad)
  }
  const empty = resolveProgramSubject('', { ...store, onScreen: null }) as any
  assert.ok(empty.error)
})

test('with no baseline it reports a re-run, and does not claim a comparison it did not make', async () => {
  const { checkReport } = await import('./check.js')
  const md = checkReport({ programDir: 'programs/revenue', params: {}, ms: 1200 })
  assert.ok(md.includes('Re-ran'))
  assert.ok(!md.toLowerCase().includes('unchanged'))
})
