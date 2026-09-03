// Run:  cd vm && pnpm exec tsx --test apps/engine/verbs/verbs.test.ts
//
// The verb layer is the one place a user's ordinary question can be silently turned into a command, and the
// one place a "nothing changed" can be silently wrong. Both are failures nobody would notice, so they are
// pinned here.
import { test } from 'node:test'
import assert from 'node:assert'
import { parseVerb } from './index.js'
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
                       'what does edit: mean', 'check:  ', 'edit:']) {
    assert.equal(parseVerb(input), null, input)
  }
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
