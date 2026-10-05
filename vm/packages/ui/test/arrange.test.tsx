// Arrange's order (components/frame/arrange.tsx · arranged): the kept order for the cards present, a new card at its place.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { arranged } from '../src/components/frame/arrange.tsx'

const code = ['kpis', 'expiry', 'reasons', 'noplan']
test('nothing kept: the code’s order', () => assert.deepEqual(arranged(code, []), code))
test('a kept order is applied', () => assert.deepEqual(arranged(code, ['expiry', 'kpis', 'noplan', 'reasons']), ['expiry', 'kpis', 'noplan', 'reasons']))
test('a kept card that is gone is skipped', () => assert.deepEqual(arranged(['kpis', 'expiry'], ['expiry', 'old', 'kpis']), ['expiry', 'kpis']))
test('a new card takes its place from the code, after the card before it', () => assert.deepEqual(arranged(['kpis', 'new', 'expiry', 'reasons'], ['expiry', 'kpis', 'reasons']), ['expiry', 'kpis', 'new', 'reasons']))
test('a new first card goes first', () => assert.deepEqual(arranged(['new', 'kpis', 'expiry'], ['expiry', 'kpis']), ['new', 'expiry', 'kpis']))
