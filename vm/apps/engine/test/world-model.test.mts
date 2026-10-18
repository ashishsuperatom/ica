// The world model's adapter in the engine, against a hub that answers as the platform does (world:append / world:read
// over a journal it keeps): a model's decisions are stored on the platform, a fresh engine process rebuilds from it, a
// refusal and a missing connection say what broke.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryJournal } from '@superatom/world-model'
import { createWorldModel } from '../world-model.ts'

/** The platform as the engine sees it: messages in, replies out (as the ProjectDO answers them). */
function platform() {
  const kept = memoryJournal()
  const connect = (projectDir: string, connected = () => true) => {
    const wm = createWorldModel({ projectDir, timeoutMs: 2000, send: (msg) => {
      if (!connected()) return false
      setImmediate(async () => {
        if (msg.type === 'world:append') {
          const entries = msg.entries as any[]
          if (!entries?.length) return wm.onMessage({ t: 'world:refused', reqId: msg.reqId, reason: 'an append is 1 to 1000 entries' })
          wm.onMessage({ t: 'world:appended', reqId: msg.reqId, last: await kept.append(entries) })
        } else if (msg.type === 'world:read') wm.onMessage({ t: 'world:entries', reqId: msg.reqId, ...(await kept.read(Number(msg.since), msg.limit as number | undefined)) })
      })
      return true
    } })
    return wm
  }
  return { kept, connect }
}

test('a model\'s decisions are kept on the platform, and a fresh engine process rebuilds the model from there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-engine-'))
  try {
    const p = platform()
    const model = await p.connect(dir).openModel('approvals')
    for (let i = 0; i < 6; i++) { const d = await model.decide('fp', ['approve', 'escalate'], { user: 'user:ana' }, 'escalate'); await model.recordOutcome(d.decisionId, true) }
    assert.equal(p.kept.entries.length, 12)
    assert.equal(p.kept.entries[0].who, 'user:ana')
    // a new engine process, its cache folder gone: everything rebuilt from the platform's journal
    const again = await p.connect(mkdtempSync(join(tmpdir(), 'wm-engine-'))).openModel('approvals')
    assert.deepEqual(again.tree.toJSON(), model.tree.toJSON())
    assert.equal((await again.decide('fp', ['approve', 'escalate'])).action, 'escalate')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the platform refusing, or not being connected, says what broke — nothing is decided without being kept', async () => {
  const p = platform()
  const wm = p.connect(mkdtempSync(join(tmpdir(), 'wm-engine-')))
  await assert.rejects(() => wm.journal.append([]), /an append is 1 to 1000 entries/)
  const offline = p.connect(mkdtempSync(join(tmpdir(), 'wm-engine-')), () => false)
  await assert.rejects(() => offline.openModel('approvals'), /not connected/)
})
