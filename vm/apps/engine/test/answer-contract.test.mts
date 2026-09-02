// ── The answer contract, checked where it is TAUGHT ──────────────────────────
//   pnpm exec tsx vm/apps/engine/test/answer-contract.test.mts
//
// The contract lives in three places that can disagree: the EXAMPLE every agent copies, the CONSUMERS that
// turn a program's output into an answer, and the RENDERER that draws it. Nothing kept them in agreement, so
// a mistake in the example was indistinguishable from a correct one until a user saw "[object Object]" — the
// example is executable documentation that nothing executed.
//
// It went wrong exactly that way: the example returned a unit's ENVELOPE (`{ answer: view }`) instead of the
// view, three consumers spread it unchanged, and the card read the whole view-model as its prose while the
// KPI and every table vanished without a word. The model had followed the example faithfully. That is the
// point — a wrong example is obeyed perfectly.
//
// So this asserts the example produces something the renderer can actually draw.
import { answerView, withProseAlias } from '../exec-program.js'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed++
}

// What the renderer needs in order to draw anything at all (mirrors AnswerCard).
const renderable = (a: any) => ({
  kpi:    !!(a?.headline?.display || a?.figures?.length),
  tables: (a?.sections ?? []).filter((s: any) => s?.kind === 'table').length + (a?.table?.columns ? 1 : 0),
  prose:  typeof a?.text === 'string' || Array.isArray(a?.text),
  proseIsObject: !!(a?.answer && typeof a.answer === 'object' && !Array.isArray(a.answer)),
})

// ── 1. THE EXAMPLE PROGRAM returns a view, not an envelope ───────────────────
{
  const unit = await import('../examples/example.single-metric/units/single-metric-view.js')
  const metric = { total: 1234567, currency: 'AUD', n: 42, year: 2026 }
  const unitOut: any = await (unit as any).default({}, { metric })

  check('the UNIT returns an envelope { answer: … }',
        !!unitOut?.answer && typeof unitOut.answer === 'object')

  // The program's contract: hand back the VIEW. Simulated here the way the example now does it.
  const programOut = unitOut.answer
  const a = withProseAlias(answerView(programOut))
  const r = renderable(a)

  check('headline is an OBJECT with `display`', typeof a.headline === 'object' && !!a.headline?.display,
        typeof a.headline === 'string' ? 'it is a STRING — the card renders no KPI' : String(a.headline?.display))
  check('the example renders a KPI', r.kpi)
  check('prose is never an object', !r.proseIsObject)
}

// ── 2. answerView survives BOTH shapes ───────────────────────────────────────
{
  const view = { headline: { label: 'x', display: 'AUD 1', value: 1 }, sections: [{ kind: 'table', columns: ['a'], rows: [['1']] }] }
  check('an ENVELOPE is unwrapped',        renderable(answerView({ answer: view })).kpi)
  check('a bare VIEW is left alone',       renderable(answerView(view)).kpi)
  check('flat prose array is not unwrapped', Array.isArray(answerView({ answer: ['line'] }).answer))
}

// ── 3. Both prose key names travel, so no client is broken by the rename ─────
{
  const a = withProseAlias({ text: ['one', 'two'], headline: { label: 'x', display: '1', value: 1 } })
  check('web reads `text`',   Array.isArray(a.text))
  check('iOS/Teams read `answer`', Array.isArray(a.answer), 'EngineAnswer.swift reads object["answer"]')
  const legacy = withProseAlias({ answer: ['old'], headline: { label: 'x', display: '1', value: 1 } })
  check('a legacy `answer`-only program gains `text`', Array.isArray(legacy.text))
}

console.log(failed ? `\n${failed} failed` : '\nthe example teaches what the renderer draws')
process.exit(failed ? 1 : 0)
