// The project's configuration on the engine: the neutral reading until the platform's arrives (no currency, no place),
// then the shared formatter writes the answers' text tables its way, and concepts' {{variables}} say it in words.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adoptConfiguration, configuration, configurationWords } from '../configuration.ts'
import { money } from '@superatom/ui/format'

test('neutral until given; then money as the organisation writes it, and its facts as words for concepts', () => {
  adoptConfiguration(null)
  assert.equal(configuration().currency, null)
  assert.equal(money(5435000), '5.44M')                                     // no currency set: the amount alone, no symbol
  adoptConfiguration({ locale: 'en-IN', currency: 'INR', timeZone: 'Asia/Kolkata', financialYear: { startMonth: 4 } })
  assert.equal(money(5435000), '₹54.4L')                                     // lakh and crore: the locale's, not built in
  assert.equal(money(12300000), '₹1.23Cr')
  assert.deepEqual(configurationWords(), { language: 'en', locale: 'en-IN', timeZone: 'Asia/Kolkata', currency: 'INR', weekStart: 'Monday', financialYear: 'starts in April' })
  adoptConfiguration({ locale: 'en-NZ', currency: 'NZD' })
  assert.equal(money(-340000), '−$340K')
  adoptConfiguration(null)
})
