import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openStore, Store, compose, join, leave, domains, conceptsOf } from '../src/node.ts'

const by = { by: 'test' }
const c = (title: string) => ({ title, form: 'text' as const, text: `${title} text` })
const tick = () => { const t = Date.now(); while (Date.now() === t) { /* the next millisecond, so moments differ */ } return Date.now() }

test('a graph from before concepts were named so: its parts become concepts, and every moment still composes', () => {
  const file = pathJoin(mkdtempSync(pathJoin(tmpdir(), 'cg-')), 'composition.sqlite')
  // the old shape, written by hand: kind 'part', a domain listing `parts`, no migration record
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE content (hash TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE name (name TEXT PRIMARY KEY, kind TEXT NOT NULL, hash TEXT NOT NULL);
    CREATE TABLE change (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, from_hash TEXT, to_hash TEXT, by TEXT NOT NULL, reason TEXT, evidence TEXT);
    CREATE TABLE question (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, session TEXT NOT NULL, qid TEXT, question TEXT NOT NULL, domain TEXT, domain_hash TEXT, how TEXT NOT NULL, ranked TEXT);`)
  const put = (name: string, kind: string, hash: string, body: unknown) => {
    old.prepare('INSERT INTO content VALUES (?, ?, 1)').run(hash, JSON.stringify(body))
    old.prepare('INSERT INTO name VALUES (?, ?, ?)').run(name, kind, hash)
    old.prepare("INSERT INTO change (at, name, kind, from_hash, to_hash, by) VALUES (1, ?, ?, NULL, ?, 'old')").run(name, kind, hash)
  }
  put('d/rules', 'part', 'h1', c('Rules'))
  put('d', 'domain', 'h2', { capabilities: [], parts: ['d/rules'], files: [] })
  old.close()
  const s = openStore(file)
  assert.equal(s.get('d/rules')!.kind, 'concept')
  assert.equal(s.get('d/rules')!.scope, 'global')
  assert.match(compose(s, 'd').text, /# Rules\nRules text/)
  assert.match(compose(s, 'd', 1).text, /# Rules/)               // as of the old moment, too
  assert.deepEqual(conceptsOf(s.get<any>('d')!.body), ['d/rules'])
  s.close()
})

test('join and leave change a domain\'s composition; the graph can be read as it was before each', () => {
  const s = openStore(':memory:')
  s.put('rules', 'concept', c('Rules'), by)
  s.put('tone', 'concept', c('Tone'), by)
  s.put('d', 'domain', { capabilities: [], concepts: ['rules'], files: [] }, by)
  const beforeJoin = tick()
  tick(); join(s, 'd', 'tone', by, 0)
  assert.deepEqual(conceptsOf(s.get<any>('d')!.body), ['tone', 'rules'])
  join(s, 'd', 'tone', by)                                                 // moved to the end, not twice
  assert.deepEqual(conceptsOf(s.get<any>('d')!.body), ['rules', 'tone'])
  const beforeLeave = tick()
  tick(); leave(s, 'd', 'rules', by)
  assert.deepEqual(conceptsOf(s.get<any>('d')!.body), ['tone'])
  assert.equal(s.get('rules')!.kind, 'concept')                           // the concept stays in the graph
  assert.doesNotMatch(compose(s, 'd', beforeJoin).text, /# Tone/)
  assert.match(compose(s, 'd', beforeLeave).text, /# Rules[\s\S]*# Tone/)
  assert.throws(() => join(s, 'd', 'missing', by), /no concept "missing"/)
  assert.throws(() => leave(s, 'd', 'rules', by), /does not compose "rules"/)
  assert.equal(s.history('d').length, 4)
})

test('scopes: a viewer sees global and their own; a scope change is a recorded change; scopes as they were', () => {
  const s = openStore(':memory:')
  s.put('rules', 'concept', c('Rules'), by)
  s.put('finance-rules', 'concept', c('Finance rules'), by, { scope: 'group:finance', owner: 'user:ana' })
  s.put('my-notes', 'concept', c('My notes'), by, { scope: 'user:u1', owner: 'user:u1' })
  s.put('d', 'domain', { capabilities: [], concepts: ['rules', 'finance-rules', 'my-notes'], files: [] }, by)
  s.put('private', 'domain', { capabilities: [], concepts: ['rules'], files: [] }, by, { scope: 'user:u2', owner: 'user:u2' })
  const sees = (viewer: string[]) => [...compose(s, 'd', undefined, { viewer }).text.matchAll(/^# (.+)$/gm)].map((m) => m[1]).filter((t) => t !== 'How every answer is given')
  assert.deepEqual(sees(['user:u1']), ['Rules', 'My notes'])
  assert.deepEqual(sees(['user:u3', 'group:finance']), ['Rules', 'Finance rules'])
  assert.deepEqual(sees([]), ['Rules'])
  assert.throws(() => compose(s, 'private', undefined, { viewer: ['user:u1'] }), /no domain "private" for this viewer/)
  assert.deepEqual(domains(s, { viewer: ['user:u1'] }).map((d) => d.name), ['d'])
  assert.deepEqual(s.names('concept', { viewer: ['user:u1'] }).map((n) => n.name), ['my-notes', 'rules'])
  assert.equal(s.get('finance-rules')!.owner, 'user:ana')
  // the scope widens, content unchanged: one change, same hash
  const before = tick()
  tick()
  const r = s.put('finance-rules', 'concept', c('Finance rules'), { by: 'user:ana', reason: 'everyone may read it' }, { scope: 'global' })
  assert.equal(r.changed, true)
  const h = s.history('finance-rules')
  assert.equal(h.length, 2)
  assert.equal(h[1].fromHash, h[1].toHash)
  assert.deepEqual([h[0].scope, h[1].scope], ['group:finance', 'global'])
  assert.equal(s.names('concept', { asOf: before }).find((n) => n.name === 'finance-rules')!.scope, 'group:finance')
  assert.equal(s.put('finance-rules', 'concept', c('Finance rules'), by).changed, false)   // nothing new: nothing recorded
  assert.throws(() => s.put('x', 'concept', c('X'), by, { scope: 'team:x' }), /not a scope/)
})

test('the CLI reads the replica — compose as it was, list by viewer, history — and refuses to change it', () => {
  const dir = mkdtempSync(pathJoin(tmpdir(), 'cg-cli-'))
  const db = pathJoin(dir, 'composition.sqlite')
  const bin = fileURLToPath(new URL('../bin/composition-graph', import.meta.url))
  const run = (...a: string[]) => execFileSync(bin, [...a, '--db', db], { encoding: 'utf8' }).trim()
  // The replica as an engine holds it (what the platform's graph gave it).
  const s = openStore(db), by = { by: 'tester' }
  s.put('rules', 'concept', { title: 'Rules', form: 'text', text: 'Bookings are confirmed consignments.' }, by)
  s.put('steps', 'concept', { title: 'Steps', form: 'bullets', items: ['find the branch', 'read the trips'] }, by, { scope: 'group:ops' })
  const empty = new Date().toISOString(); tick()
  s.put('d', 'domain', { capabilities: [], concepts: ['rules', 'steps'], files: [] }, by)
  s.close()
  assert.match(run('compose', 'd'), /# Rules\nBookings are confirmed consignments\.\n\n# Steps\n- find the branch\n- read the trips/)
  assert.doesNotMatch(run('compose', 'd', '--viewer', 'user:u1'), /# Steps/)
  assert.throws(() => run('compose', 'd', '--as-of', empty))   // the domain did not exist yet
  assert.deepEqual(run('names', '--kind', 'concept', '--viewer', 'user:u1').split('\n').map((l) => l.split('\t')[1]), ['rules'])
  assert.match(run('history', 'd'), /tester/)
  assert.throws(() => run('concept', 'x', '--title', 'X', '--text', 'y'), (e: any) => /the graph lives in the platform/.test(String(e.stderr)))
})
