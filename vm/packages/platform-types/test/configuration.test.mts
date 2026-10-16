import { test } from 'node:test'
import assert from 'node:assert/strict'
import { configurationProblems, resolveConfiguration, NEUTRAL_CONFIGURATION } from '../src/index.ts'

test('nothing set reads neutrally — no place assumed, no currency', () => {
  assert.deepEqual(resolveConfiguration(null), NEUTRAL_CONFIGURATION)
  assert.equal(resolveConfiguration({}).currency, null)
  assert.equal(resolveConfiguration({ language: 'hi' }).locale, 'hi')            // a language alone writes numbers its way
  assert.equal(resolveConfiguration({ locale: 'en-IN', currency: 'INR' }).locale, 'en-IN')
})

test('each field is checked, in words that say what it takes', () => {
  assert.deepEqual(configurationProblems({ language: 'en', locale: 'en-IN', timeZone: 'Asia/Kolkata', currency: 'INR', weekStart: 1, financialYear: { startMonth: 4 } }), [])
  assert.deepEqual(configurationProblems({ financialYear: { months: [{ name: 'P1', from: '2026-01-01', to: '2026-01-28' }, { name: 'P2', from: '2026-01-29', to: '2026-02-25' }] } }), [])
  const bad = configurationProblems({ locale: 'not a locale!', timeZone: 'Mars/Base', currency: 'rupees', weekStart: 0, financialYear: { startMonth: 13 }, colour: 'red' })
  for (const w of [/no "colour"/, /locale is a language tag/, /timeZone is a zone/, /currency is a three-letter code/, /weekStart is 1/, /startMonth is 1/]) assert.ok(bad.some((p) => w.test(p)), `${w} in ${bad.join(' | ')}`)
  assert.match(configurationProblems({ financialYear: { months: [{ name: 'P1', from: '2026-01-01', to: '2026-01-31' }, { name: 'P2', from: '2026-01-15', to: '2026-02-25' }] } })[0], /begins before the month before it ends/)
})
