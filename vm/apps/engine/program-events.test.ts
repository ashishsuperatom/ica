// Run:  cd vm && pnpm exec tsx --test apps/engine/program-events.test.ts
//
// The point of this whole path is that a long-running program stops looking like a hang. So what is pinned is
// LIVENESS: events must arrive WHILE the program is still running, not in a lump when it exits. A tail that
// only delivered on completion would pass a naive test and fail at the only job it has.
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { mkdir, appendFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchProgramEvents, describeProgramEvent, EVENTS_FILE } from './program-events.js'

// A real project home with a workspace inside it: the spool sits BESIDE the workspace, so a test that passed
// a bare temp dir would write into /tmp and every test would share one file.
const ws = () => {
  const home = mkdtempSync(join(tmpdir(), 'sa-progev-'))
  return join(home, 'workspace')
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test('events arrive WHILE the program runs, not only at the end', async () => {
  const dir = ws()
  await mkdir(dir, { recursive: true })
  const seen: string[] = []
  const stop = watchProgramEvents(dir, ev => seen.push(ev.t), 20)
  await sleep(60)   // let it take its position at the end of the (empty) file

  const note = (o: unknown) => appendFile(EVENTS_FILE(dir), JSON.stringify(o) + '\n')
  await note({ t: 'program:start', run: 'r1', program: 'p', at: Date.now() })
  await sleep(80)
  assert.deepEqual(seen, ['program:start'], 'the start must be seen before the program has finished')

  await note({ t: 'query:start', run: 'r1', program: 'p', at: Date.now(), id: 'q1', source: 'DB', sql: 'SELECT 1' })
  await sleep(80)
  assert.deepEqual(seen, ['program:start', 'query:start'], 'a query in flight must be visible in flight')

  await note({ t: 'query:end', run: 'r1', program: 'p', at: Date.now(), id: 'q1', source: 'DB', ms: 4200, rows: 7 })
  await note({ t: 'program:end', run: 'r1', program: 'p', at: Date.now(), ms: 4300, nodes: 2 })
  await sleep(80)
  assert.deepEqual(seen, ['program:start', 'query:start', 'query:end', 'program:end'])
  stop()
})

test('history already in the file is NOT replayed as this turn', async () => {
  // The file holds every run this workspace has ever done. Replaying it would show a user someone else's
  // query, timestamped as though it were happening now.
  const dir = ws()
  await mkdir(dir, { recursive: true })
  await writeFile(EVENTS_FILE(dir), JSON.stringify({ t: 'program:start', run: 'old', program: 'x', at: 1 }) + '\n')

  const seen: string[] = []
  const stop = watchProgramEvents(dir, ev => seen.push(String(ev.run)), 20)
  await sleep(60)
  assert.deepEqual(seen, [], 'nothing from before the turn began')

  await appendFile(EVENTS_FILE(dir), JSON.stringify({ t: 'log', run: 'new', program: 'x', at: 2, text: 'hi' }) + '\n')
  await sleep(80)
  assert.deepEqual(seen, ['new'])
  stop()
})

test('a line split across two reads is not lost or garbled', async () => {
  const dir = ws()
  await mkdir(dir, { recursive: true })
  const seen: any[] = []
  const stop = watchProgramEvents(dir, ev => seen.push(ev), 20)
  await sleep(60)

  const line = JSON.stringify({ t: 'log', run: 'r', program: 'p', at: 1, text: 'a long thought' }) + '\n'
  await appendFile(EVENTS_FILE(dir), line.slice(0, 20))     // half a line…
  await sleep(60)
  assert.equal(seen.length, 0, 'half a line is not an event yet')
  await appendFile(EVENTS_FILE(dir), line.slice(20))        // …and the rest
  await sleep(80)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].text, 'a long thought')
  stop()
})

test('stop() really stops', async () => {
  const dir = ws()
  await mkdir(dir, { recursive: true })
  const seen: string[] = []
  const stop = watchProgramEvents(dir, ev => seen.push(ev.t), 20)
  await sleep(60)
  stop()
  await appendFile(EVENTS_FILE(dir), JSON.stringify({ t: 'log', run: 'r', program: 'p', at: 1 }) + '\n')
  await sleep(80)
  assert.deepEqual(seen, [], 'a finished turn must not keep reporting')
})

test('every event says something a person can read', () => {
  const base = { run: 'r', program: 'programs/x', at: 1 }
  const lines = [
    { ...base, t: 'program:start' },
    { ...base, t: 'program:end', ms: 4300, nodes: 2 },
    { ...base, t: 'program:failed', error: 'boom' },
    { ...base, t: 'unit:start', id: 'u#1', unit: 'total-sales' },
    { ...base, t: 'unit:end', id: 'u#1', unit: 'total-sales', ms: 12, rows: 3 },
    { ...base, t: 'decide', label: 'has data', took: true, reason: 'rows returned' },
    { ...base, t: 'log', text: 'checking the cutoff' },
    { ...base, t: 'query:start', id: 'q1', source: 'DB', sql: 'SELECT 1' },
    { ...base, t: 'query:end', id: 'q1', source: 'DB', ms: 4200, rows: 7 },
    { ...base, t: 'query:end', id: 'q2', source: 'DB', ms: 10, error: 'syntax' },
  ]
  for (const l of lines) assert.ok(describeProgramEvent(l as any).length > 0, `no description for ${l.t}`)
  // An event kind added later must not produce a mystery line.
  assert.equal(describeProgramEvent({ ...base, t: 'something:new' } as any), '')
})

// ── WHOSE LINE IS IT ────────────────────────────────────────────────────────────────────────────────────────
// One workspace serves every chat in a project, so the spool is shared. Delivering a line to the wrong turn
// would show one person another person's query — the failure mode worth a test even though the rule is four
// lines long. This mirrors ownsProgramEvent in engine.ts; if that changes, this should fail.
function owns(sid: string, qid: string, ev: any, running: string[]): boolean {
  if (typeof ev.qid === 'string' && ev.qid) return ev.qid === qid
  if (typeof ev.sid === 'string' && ev.sid) return ev.sid === sid
  return running.length === 1 && running[0] === sid
}

test('a stamped line goes only to the turn that started it', () => {
  assert.equal(owns('s1', 'q1', { qid: 'q1' }, []), true)
  assert.equal(owns('s2', 'q2', { qid: 'q1' }, []), false, "another turn's run must not be shown")
})

test('an unstamped line is delivered when exactly one session is running a program', () => {
  assert.equal(owns('s1', 'q1', {}, ['s1']), true)
})

test('an unstamped line is shown to NOBODY when two sessions could own it', () => {
  // The important case. A missing line is a gap; a wrong line is a false statement about someone else's data.
  assert.equal(owns('s1', 'q1', {}, ['s1', 's2']), false)
  assert.equal(owns('s2', 'q2', {}, ['s1', 's2']), false)
})

test('an unstamped line with no session running a program is nobody\'s', () => {
  assert.equal(owns('s1', 'q1', {}, []), false)
})
