import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ago, bytes, dateTime, day } from '../src/lib/when.ts'

test('ago reads every kind of moment, and nothing as the given none', () => {
  const now = Date.now()
  assert.equal(ago(now), 'just now')
  assert.equal(ago(now - 4 * 60_000), '4 min ago')
  assert.equal(ago(new Date(now - 3 * 3_600_000).toISOString()), '3 h ago')
  assert.equal(ago(new Date(now - 2 * 86_400_000)), '2 d ago')
  assert.equal(ago(now - 30 * 86_400_000), day(now - 30 * 86_400_000))
  assert.equal(ago(undefined), '—')
  assert.equal(ago('not a date', ''), '')
})

test('dateTime and day say nothing for nothing', () => {
  assert.equal(dateTime(null), '—')
  assert.equal(day(''), '—')
  assert.match(dateTime('2026-10-10T14:05:00Z'), /2026/)
})

test('bytes picks its unit', () => {
  assert.equal(bytes(980), '980 B')
  assert.equal(bytes(12_700), '12.4 KB')
  assert.equal(bytes(3.1 * 1024 ** 2), '3.1 MB')
  assert.equal(bytes(1.25 * 1024 ** 3), '1.3 GB')
  assert.equal(bytes(undefined), '—')
})
