import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isScope, checkSchema, checkValue, checkObject, checkOp, checkIntent, checkPackage, checkProgram, checkPackages, checkGovernanceEntry, type PackageSpec } from '../src/index.ts'

const trips: PackageSpec = {
  owns: 'trips',
  schema: { branch: { nullable: 'string' }, completed: 'boolean', settled: { nullable: 'boolean' }, page: 'number', window: { object: { from: 'date', to: 'date' } }, tags: { list: 'string' }, view: { enum: ['list', 'summary'] } },
  initial: { branch: null, completed: true, settled: null, page: 1, window: { from: '2026-04-01', to: '2027-04-01' }, tags: [], view: 'list' },
  reads: ['scope.branch'],
  functions: [{ name: 'run', produces: 'view' }, { name: 'settle', produces: 'action' }],
  actions: [{ id: 'unsettled', label: 'Completed, not settled', ops: [{ op: 'set', path: 'trips.settled', value: false }] }, { id: 'settle', label: 'Settle', call: 'settle' }],
  commands: [{ id: 'settle-trip', label: 'Settle trip', permission: 'trips.settle' }],
  doc: 'doc.md',
}

test('scopes', () => {
  for (const s of ['global', 'group:finance', 'user:u_1']) assert.equal(isScope(s), true)
  for (const s of ['', 'group:', 'team:x', 'user:a b', 'GLOBAL']) assert.equal(isScope(s), false)
})

test('slice schemas and values', () => {
  assert.deepEqual(checkSchema(trips.schema), [])
  assert.deepEqual(checkSchema({ a: 'text' }), ['schema.a: "text" is not a type (string, number, boolean, date, json)'])
  assert.deepEqual(checkObject(trips.schema, trips.initial, 'trips'), [])
  const bad = checkObject(trips.schema, { ...trips.initial, page: '2', window: { from: '2026-13-40', to: '2027-04-01' }, view: 'grid', extra: 1, branch: undefined }, 'trips')
  assert.deepEqual(bad, [
    'trips.branch is missing',
    'trips.page must be a number, not "2"',
    'trips.window.from must be a date (YYYY-MM-DD), not "2026-13-40"',
    'trips.view must be one of "list", "summary", not "grid"',
    'trips.extra is not declared',
  ])
  assert.deepEqual(checkValue({ list: 'number' }, [1, 'x'], 'v'), ['v[1] must be a number, not "x"'])
})

test('ops and intents', () => {
  assert.deepEqual(checkOp({ op: 'set', path: 'trips.branch', value: 'PUNE' }), [])
  assert.deepEqual(checkOp({ op: 'put', path: 'branch' }), ['op.op must be set, add or remove, not "put"', 'op.path must be <slice>.<field>, not "branch"'])
  assert.deepEqual(checkOp({ op: 'add', path: 'trips.tags' }), ['op: add needs a value'])
  const intent = { id: 'i1', session: 's1', kind: 'structured', ops: [{ op: 'set', path: 'trips.page', value: 2 }], to: 'current', by: 'user:u1', at: '2026-10-04T10:00:00Z' }
  assert.deepEqual(checkIntent(intent), [])
  assert.deepEqual(checkIntent({ ...intent, kind: 'language', ops: undefined }), ['a language intent carries its text'])
  assert.deepEqual(checkIntent({ ...intent, to: 'here' }), ['intent.to must be new or current'])
  assert.deepEqual(checkIntent({ ...intent, ops: undefined }), ['a structured intent carries ops, an action or a call'])
  assert.deepEqual(checkIntent({ ...intent, ops: undefined, call: { package: 'trips', fn: 'run' }, block: 'b2' }), [])
  assert.deepEqual(checkIntent({ ...intent, ops: undefined, action: { package: 'trips' } }), ['intent.action names its package and id'])
  assert.deepEqual(checkIntent({ ...intent, kind: 'language', text: 'only Pune', ops: undefined, result: { ops: [{ op: 'set', path: 'branch', value: 'PUNE' }] } }), ['intent.result.ops[0].path must be <slice>.<field>, not "branch"'])
})

test('a package', () => {
  assert.deepEqual(checkPackage(trips), [])
  const p = checkPackage({ ...trips, owns: 'agent', functions: [{ name: 'settle', produces: 'action' }], reads: ['trips.page'], actions: [{ id: 'x', label: 'X', ops: [{ op: 'set', path: 'scope.branch', value: 'A' }] }, { id: 'y', label: 'Y', call: 'nope' }], doc: '' })
  assert.deepEqual(p, [
    'package.owns: "agent" is the platform\'s, not a package\'s',
    'package.functions must include run, the default',
    'package.actions[0].ops[0] changes another package\'s slice',
    'package.actions[1] calls "nope", which the package does not have',
    'package.doc is required: without it an agent cannot use the package',
  ])
})

test('packages sharing one STATE: one owner per slice, reads resolve', () => {
  const scope: PackageSpec = { ...trips, owns: 'scope', schema: { branch: { nullable: 'string' } }, initial: { branch: null }, reads: [], actions: [], commands: [] }
  assert.deepEqual(checkPackages([scope, trips]), [])
  assert.deepEqual(checkPackages([trips, { ...trips }]), ['two packages own the slice "trips" — a path has exactly one owner', '"trips" reads scope.branch, but no package owns "scope"', '"trips" reads scope.branch, but no package owns "scope"'])
})

test('a program manifest', () => {
  const m = { id: 'prg_1', name: 'trips', hash: 'abc', version: 1, scope: 'group:operations', owner: 'user:u1', attachesTo: 'operations.vehicle-trips',
    node: { bundle: 'r2://p/abc/node.mjs', runtime: ['on-prem'] }, ui: { bundle: 'r2://p/abc/web.js', blocks: ['unsettled-trips'] }, reads: [], package: trips, published: false }
  assert.deepEqual(checkProgram(m), [])
  assert.deepEqual(checkProgram({ ...m, scope: 'team:x', attachesTo: 'Operations/Trips', ui: { bundle: 'x', blocks: [] } }), [
    'program.scope must be global, group:<name> or user:<id>, not "team:x"',
    'program.attachesTo is a path of the org knowledge index: words joined by dots',
    'program.ui needs its bundle and the blocks it gives the UI',
  ])
})

test('governance entries', () => {
  const e = { seq: 1, at: '2026-10-04T10:00:00Z', by: 'user:u2', item: 'prg_1', action: 'suggest', from: 'h1', to: 'h2', reason: 'add broker column' }
  assert.deepEqual(checkGovernanceEntry(e), [])
  assert.deepEqual(checkGovernanceEntry({ ...e, seq: 2, action: 'approve' }), ['an approve names the suggestion it decides (decides: its seq)'])
  assert.deepEqual(checkGovernanceEntry({ ...e, action: 'grant' }), ['a grant names its subject and permission'])
  assert.deepEqual(checkGovernanceEntry({ ...e, action: 'delete' }), ['entry.action "delete" is not one the log knows'])
})
