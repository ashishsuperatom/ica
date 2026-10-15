// Each program as a workload (program-runs.ts): running while a run is in progress, ready after it, degraded with why
// after one fails; its runs, failures and who the last was for; stopped on request — its runs in progress killed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProgramRuns, programId } from '../program-runs.ts'

test('a program runs: starting while it does, ready after, degraded with why when one fails; stop kills what runs', async () => {
  const seen: any[] = []
  let act: ((id: string, action: string, by: string | null) => Promise<{ note?: string }>) | undefined
  const runs = createProgramRuns({ set: (w: any) => seen.push(w), onAct: (_k: string, f: any) => { act = f } } as any)
  const id = programId('Vendors and Hire', 'unsettled.mjs')
  assert.equal(id, 'vendors-and-hire:unsettled.mjs')
  const killed: string[] = []
  const child = { kill: (sig?: any) => { killed.push(String(sig)); return true } }
  const end1 = runs.began(id, child, 'ana@x.io')
  assert.deepEqual([seen.at(-1).state, seen.at(-1).health.running, seen.at(-1).health.lastFor], ['starting', 1, 'ana@x.io'])
  assert.deepEqual(await act!(id, 'stop', null), { note: '1 run stopped' })
  assert.deepEqual(killed, ['SIGTERM'])
  end1('killed by SIGTERM')
  assert.deepEqual([seen.at(-1).state, seen.at(-1).error.what, seen.at(-1).health.failed], ['degraded', 'its last run failed', 1])
  const end2 = runs.began(id, child, null)
  end2()
  assert.deepEqual([seen.at(-1).state, seen.at(-1).error, seen.at(-1).health.runs], ['ready', null, 2])
  assert.deepEqual(await act!(id, 'stop', null), { note: 'nothing of it was running' })
  await assert.rejects(act!(id, 'explode', null), /no action "explode"/)
})
