// A question read whole: its terms in the graph — longest phrases, dates as spans, records named at the source, near
// misses repaired — and the words the graph does not hold.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGraph, resolveTerms, Store } from '../src/index.js'
import { instance as I, schema as s } from './fixtures/branches.js'
import { toSqlite } from './fixtures/sqlite.js'

const today = '2026-09-15'
const kinds = (r: ReturnType<typeof resolveTerms>) => r.terms.map((t) => `${t.phrase}=${t.means.map((m: any) => m.kind === 'span' ? JSON.stringify(m.span) : m.measure ?? m.key ?? m.value ?? m.attribute ?? m.role ?? m.node).join('|')}`)

test('terms, spans, plurals, near misses and what the graph lacks', () => {
  const r = resolveTerms(s, 'How many hours did each branch work in September and October 2026, by commitment?', today)
  assert.deepEqual(kinds(r), ['hours=hours', 'branch=Branch', 'september and october 2026={"from":"2026-09-01","through":"2026-10-31"}', 'commitment=commitment'])
  assert.deepEqual(r.unmatched, ['work'])
  assert.ok(!r.terms.some((x) => x.ambiguous))

  const typo = resolveTerms(s, 'budgt for Sydney branches last quarter', today)
  assert.deepEqual(kinds(typo), ['budget=budget', 'sydney=b1', 'branches=Branch', 'last quarter={"previous":"Quarter"}'], JSON.stringify(typo))
  assert.equal(typo.terms[0].repaired?.typed, 'budgt')

  const q = resolveTerms(s, 'soft hours in Q3 2026 vs the last 30 days', today)
  assert.deepEqual(kinds(q), ['soft=Soft', 'hours=hours', 'q3 2026={"from":"2026-07-01","through":"2026-09-30"}', 'the last 30 days={"last":30,"unit":"Day"}'])
  assert.deepEqual(resolveTerms(s, 'hours in october', today).notes, ['"october" has no year; it is read as 2026'])
})

test('records are named at their sources, one lookup per entity', async () => {
  const { query, sources } = toSqlite(s, I)
  let lookups = 0
  const g = createGraph({ store: new Store(':memory:'), query: async (src, sql, p, o) => { if (/ IN \(/.test(sql)) lookups++; return query(src, sql, p, o) } })
  g.defineSchema('m', s, 'test', 'test')
  await g.defineSources('m', sources, 'test', 'test')
  const r = await g.resolveQuestionTerms('m', 'hours of NSW projects', { today })
  assert.ok(r.terms.some((t) => t.phrase === 'nsw' && t.means.some((m: any) => m.node === 'State' && m.key === 'NSW')), JSON.stringify(r))
  assert.ok(lookups >= 1)
})

test('a capitalised word is a name to look for, not a typing mistake to repair', () => {
  const r = resolveTerms(s, 'hours for Sydnee and sydnee', today)
  assert.deepEqual(r.unmatched, ['sydnee'])
  assert.equal(r.terms.filter((t) => t.repaired).length, 1)
})

test('a repaired word still joins its phrase', () => {
  const withPhrase: typeof s = { ...s, objects: { ...s.objects, Sale: { ...s.objects.Sale, measures: { ...s.objects.Sale.measures!, amount: { ...s.objects.Sale.measures!.amount, synonyms: ['projected amount'] } } } } }
  const r = resolveTerms(withPhrase, 'projected amont by branch', today)
  assert.equal(r.terms[0].phrase, 'projected amount')
  assert.deepEqual(r.terms[0].repaired, { typed: 'projected amont', mistakes: 1 })
  assert.deepEqual(r.unmatched, [])
})
