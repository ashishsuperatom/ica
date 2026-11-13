// A program says what it is in its own code: defineProgram (server) and defineViews (web), each read as data.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defineProgram, defineViews, fn, view, field } from '../src/index.ts'

async function run() { return {} }
async function cover() { return {} }
async function plantOptions() { return [] }
async function coverRisk() { return null }
function RevenueTrend() { return null }
function Controls() { return null }

const program = defineProgram({
  state: { plant: field.nullable('string'), days: field.number(30), kinds: field.list('string') },
  functions: {
    run: fn(run, { produces: 'view', doc: 'Stock cover by plant' }),
    cover: fn(cover, { produces: 'data', doc: 'Free stock against open demand', params: { plant: field.string(), days: field.nullable('number') } }),
  },
  filters: [{ field: 'plant', label: 'Plant', options: plantOptions }],
  options: [coverRisk],
})

test('a program\'s definition, as data: its STATE (types and where each starts), its functions, filters and options by name', () => {
  assert.deepEqual(program.inspect(), {
    state: { schema: { plant: { nullable: 'string' }, days: 'number', kinds: { list: 'string' } }, initial: { plant: null, days: 30, kinds: [] } },
    watches: [],
    functions: [
      { name: 'run', export: 'run', produces: 'view', doc: 'Stock cover by plant' },
      { name: 'cover', export: 'cover', produces: 'data', doc: 'Free stock against open demand', params: { plant: 'string', days: { nullable: 'number' } } },
    ],
    options: ['coverRisk'],
    filters: [{ field: 'plant', label: 'Plant', options: 'plantOptions' }],
  })
  assert.deepEqual(program.functions.cover.inspect(), { name: 'cover', export: 'cover', produces: 'data', doc: 'Free stock against open demand', params: { plant: 'string', days: { nullable: 'number' } } })
  // the build names each reference by its export
  const renamed = new Map<any, string>([[cover, 'coverOf']])
  assert.equal(program.inspect(renamed).functions[1].export, 'coverOf')
})

test('views, as data: each by name, where it sits, what it reads and sends', () => {
  const views = defineViews({
    Controls: view(Controls, { doc: 'The plant filter', place: 'head', sends: [{ set: 'plant' }] }),
    RevenueTrend: view(RevenueTrend, { doc: 'Revenue by month', reads: ['plant'], sends: [{ call: 'inventory.cover' }] }),
  })
  assert.deepEqual(views.inspect(), { as: 'block', views: [
    { name: 'Controls', export: 'Controls', doc: 'The plant filter', place: 'head', reads: [], sends: [{ set: 'plant' }] },
    { name: 'RevenueTrend', export: 'RevenueTrend', doc: 'Revenue by month', place: 'body', reads: ['plant'], sends: [{ call: 'inventory.cover' }] },
  ] })
  assert.equal(views.views.RevenueTrend.inspect().doc, 'Revenue by month')
  assert.equal(defineViews({}, { as: 'ui' }).inspect().as, 'ui')
})

test('a definition takes the function itself, never its name', () => {
  assert.throws(() => fn('run' as any, { produces: 'view' }), /takes the function itself/)
  assert.throws(() => view('RevenueTrend' as any), /takes the component itself/)
})
