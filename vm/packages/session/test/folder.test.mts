// A session's folder: the log is the truth; beside it, after every change, STATE.json (the current block's STATE),
// ANSWER_HISTORY.jsonl (each answer with the question that made it, its qid), context.md (what it was started with);
// attachments are entries of the log, in the view.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileLog, replay } from '../src/index.ts'

test('the files beside a session\'s log follow it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ses-'))
  const log = fileLog(dir)
  const at = (n: number) => `2026-10-06T00:00:0${n}.000Z`
  log.append('s1', { t: 'open', at: at(0), session: 's1', user: 'user:ana', agent: 'pmo', context: 'The overruns dashboard: 3 projects over budget.' })
  log.append('s1', { t: 'block', at: at(1), id: 'b1', parent: null, state: { packages: { pmo: 'h' }, pmo: { view: 'overruns' } } as any, stateHash: 'x1', intent: null })
  assert.equal(readFileSync(join(dir, 's1', 'context.md'), 'utf8'), 'The overruns dashboard: 3 projects over budget.')
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 's1', 'STATE.json'), 'utf8')).pmo, { view: 'overruns' })
  log.append('s1', { t: 'intent', at: at(2), intent: { id: 'i1', session: 's1', kind: 'language', text: 'which is worst?', to: 'current', by: 'user:ana', at: at(2), qid: 'q1' } })
  log.append('s1', { t: 'answer', at: at(3), answer: { id: 'a1', session: 's1', block: 'b1', cause: 'i1', stateHash: 'x1', at: at(3), markdown: 'Apollo, two months over.', files: [] } })
  log.append('s1', { t: 'state', at: at(4), block: 'b1', state: { packages: { pmo: 'h' }, pmo: { view: 'apollo' } } as any, stateHash: 'x2', intent: 'i2' })
  const history = readFileSync(join(dir, 's1', 'ANSWER_HISTORY.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(history.length, 1)
  assert.deepEqual({ qid: history[0].qid, text: history[0].intent.text, answer: history[0].answer.markdown }, { qid: 'q1', text: 'which is worst?', answer: 'Apollo, two months over.' })
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 's1', 'STATE.json'), 'utf8')).pmo, { view: 'apollo' })   // the STATE as it is now
  log.append('s1', { t: 'attachment', at: at(5), name: 'budget.xlsx', hash: 'ab', size: 10, type: 'application/vnd.ms-excel' })
  const v = replay(log.read('s1'))!
  assert.equal(v.context, 'The overruns dashboard: 3 projects over budget.')
  assert.deepEqual(v.attachments.map((a) => a.name), ['budget.xlsx'])
  assert.equal(existsSync(join(dir, 's1', 'session.jsonl')), true)
})
