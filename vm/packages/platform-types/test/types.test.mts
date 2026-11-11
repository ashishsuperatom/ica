import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isScope, checkSchema, checkValue, checkObject, checkOp, checkIntent, checkPackage, checkOption, checkProgram, checkPackages, checkGovernanceEntry, checkAuditEvent, checkFilterOptions, type PackageSpec } from '../src/index.ts'

const trips: PackageSpec = {
  owns: 'trips',
  schema: { branch: { nullable: 'string' }, completed: 'boolean', settled: { nullable: 'boolean' }, page: 'number', window: { object: { from: 'date', to: 'date' } }, tags: { list: 'string' }, view: { enum: ['list', 'summary'] } },
  initial: { branch: null, completed: true, settled: null, page: 1, window: { from: '2026-04-01', to: '2027-04-01' }, tags: [], view: 'list' },
  reads: ['scope.branch'],
  functions: [{ name: 'run', produces: 'view' }, { name: 'settle', produces: 'action' }],
  options: ['unsettledLeft', 'settleThem'],
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
  assert.deepEqual(checkIntent({ ...intent, ops: undefined }), ['a structured intent carries ops or a call'])
  assert.deepEqual(checkIntent({ ...intent, ops: undefined, call: { package: 'trips', fn: 'run' }, block: 'b2' }), [])
  assert.deepEqual(checkIntent({ ...intent, kind: 'language', text: 'only Pune', ops: undefined, result: { ops: [{ op: 'set', path: 'branch', value: 'PUNE' }] } }), ['intent.result.ops[0].path must be <slice>.<field>, not "branch"'])
})

test('a package', () => {
  assert.deepEqual(checkPackage(trips), [])
  const p = checkPackage({ ...trips, owns: 'agent', functions: [{ name: 'settle', produces: 'action' }], reads: ['trips.page'], options: ['settle', 'check', 'two', 'two', 'not a name'], doc: '' })
  assert.deepEqual(p, [
    'package.owns: "agent" is the platform\'s, not a package\'s',
    'package.functions must include run, the default',
    'package.options[0] "settle" is an option function: it is not one of the functions an intent calls',
    'package.options[1]: "check" is the slice\'s own check, not an option',
    'package.options[4] names one of its functions',
    'package.options names a function twice',
    'package.doc is required: without it an agent cannot use the package',
  ])
  // the fixed kind is gone: a program offers moves only by computing them
  assert.match(checkPackage({ ...trips, actions: [{ id: 'x', label: 'X', ops: [] }] }).join(), /package.actions: a program offers its next moves with option functions/)
  assert.match(checkPackage({ ...trips, options: undefined }).join(), /package.options must list its option functions/)
})

test('an option, as an option function returns it: a label, and a move that is its own package\'s', () => {
  assert.deepEqual(checkOption({ label: '12 trips completed, not settled', ops: [{ op: 'set', path: 'trips.settled', value: false }] }, trips), [])
  assert.deepEqual(checkOption({ label: 'Every branch', call: { fn: 'run', params: { all: true } }, to: 'new' }, trips), [])
  assert.deepEqual(checkOption({ label: ' ', call: { fn: 'nope' }, ops: [{ op: 'set', path: 'scope.branch', value: 'A' }], to: 'later' }, trips), [
    'option.label says the move, in at most 200 characters',
    'option.call names one of its own functions',
    'option.ops[0] changes another package\'s slice',
    'option.to is new or current',
  ])
  assert.deepEqual(checkOption({ label: 'Nothing to do' }, trips), ['option calls one of its functions or carries ops'])
  // an option explores: a function with an effect outside (here settle, which produces an action) is never one
  assert.deepEqual(checkOption({ label: 'Settle 12 trips', call: { fn: 'settle' } }, trips), ['option.call: settle has an effect outside — an option only explores'])
  assert.deepEqual(checkOption([], trips), ['option is an object (or null: no option here)'])
})

test('packages sharing one STATE: one owner per slice, reads resolve', () => {
  const scope: PackageSpec = { ...trips, owns: 'scope', schema: { branch: { nullable: 'string' } }, initial: { branch: null }, reads: [], options: [], commands: [] }
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

test('an audit event', () => {
  const e = { id: 'a1', at: '2026-10-04T10:00:00Z', project: 'p1', actor: { kind: 'agent', id: 'agent:k1' }, via: 'agent', action: 'session.intent', outcome: 'ok', detail: { ops: [] } }
  assert.deepEqual(checkAuditEvent(e), [])
  assert.deepEqual(checkAuditEvent({ ...e, action: 'Asked', via: 'phone', actor: { kind: 'bot' }, outcome: 'maybe' }), [
    'audit.action is <thing>.<verb>, not "Asked"',
    'audit.actor names its kind (user, agent, engine, system) and id',
    'audit.via must be ui, admin, agent, engine, api, channel or system, not "phone"',
    'audit.outcome must be ok, refused or error, not "maybe"',
  ])
})

test('a program names the settings it reads: a list of names, each once', () => {
  const m = { id: 'p', name: 'p', hash: 'h', owner: 'u', attachesTo: 'a.b', scope: 'global', node: { bundle: 'node/index.js' }, ui: { bundle: 'web/index.js', blocks: ['x'] } }
  assert.deepEqual(checkProgram({ ...m, settings: ['a-floor', 'a-token'] }), [])
  assert.deepEqual(checkProgram({ ...m, settings: 'floor' }), ['program.settings lists the settings it reads, by the names the knowledge gives them'])
  assert.deepEqual(checkProgram({ ...m, settings: ['floor', 'floor'] }), ['program.settings names a setting twice'])
})

test('a filter: on a field that can mean "all", its choices computed by a function of the program — never typed, never missing', () => {
  const ok = { ...trips, filters: [{ field: 'branch', label: 'Branch', options: 'branchOptions', size: 'medium', noun: ['trip', 'trips'], unit: 'money' }, { field: 'tags', label: 'Tags', options: 'tagOptions' }],
    breakdown: { field: 'branch', choices: [{ value: 'region', label: 'Region' }] } }
  assert.deepEqual(checkPackage(ok), [])
  const bad = checkPackage({ ...trips, filters: [
    { field: 'branch', label: 'Branch' },                                          // no function
    { field: 'page', label: 'Page', options: 'pageOptions' },                      // a number cannot mean "all"
    { field: 'tags', label: 'Tags', options: 'tagOptions', choices: ['a', 'b'] },   // typed by hand
    { field: 'branch', label: 'Again', options: 'run', size: 'wide' },               // twice; one of its functions; a free width
  ] })
  assert.match(bad[0], /package.filters\[0\] has no options function: name a function of the program in "options" — export async function branchOptions\(state, ctx\) returning \[\{ value, label, count, amount\? \}\]/)
  const all = bad.join('\n')
  assert.match(all, /"page" cannot be a filter — its field is \{ "nullable": "string" \}/)
  assert.match(all, /filters\[2\]\.choices: a filter's choices are never written by hand/)
  assert.match(all, /"branch" is filtered twice/)
  assert.match(all, /options "run" computes a filter's choices: it is not one of its functions/)
  assert.match(all, /size is small, medium, large — a slot on the row's grid, never a width of its own/)
  const b = checkPackage({ ...trips, breakdown: { field: 'page', choices: [] } }).join('\n')
  assert.match(b, /breakdown.field names a field of the slice that is \{ "nullable": "string" \}/)
  assert.match(b, /breakdown.choices lists the groupings it can draw/)
})

test("a filter's computed choices: each holds something, once", () => {
  assert.deepEqual(checkFilterOptions([{ value: 'PUNE', label: 'Pune', count: 776, amount: 1478 }, { value: 'GOA', label: 'Goa', count: 1 }]), [])
  assert.deepEqual(checkFilterOptions([{ value: 'PUNE', label: 'Pune', count: 0 }, { value: 'PUNE', label: '', count: 2, amount: '3' }], 'f()'), [
    'f()[0].count is how many things it holds, more than none: a choice that holds nothing is left out',
    'f()[1].label is what a person reads',
    'f()[1].amount is a number',
    'f() offers one value twice',
  ])
  assert.deepEqual(checkFilterOptions(null, 'f()'), ['f() is a list of { value, label, count, amount? }'])
})
