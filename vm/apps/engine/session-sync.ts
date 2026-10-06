// SESSIONS TO THE PLATFORM. The platform keeps the truth of every session (in its owner's UserDO); the engine's log file is the
// replica it writes first. After every append, and again whenever the engine reconnects, the entries the platform does
// not have yet go up as `session:sync { session, from, entries }`, in chunks that fit a frame. The platform answers
// `session:synced { upto }`, and `upto` is written down beside the log, so a restart resends nothing it already has.
// A gap (the platform has fewer) resends from its count; a conflict (it has something different) is said loudly and
// never overwritten.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileLog, type Entry, type SessionLog } from '@superatom/session'

const CHUNK_BYTES = 400_000
const INFLIGHT_MS = 30_000

export function createSessionSync(o: { dir: string; send: (msg: Record<string, unknown>) => boolean; log?: (s: string) => void }) {
  const files = fileLog(o.dir)
  const inflight = new Map<string, ReturnType<typeof setTimeout>>()
  const mark = (s: string) => join(o.dir, s, 'synced.json')
  const synced = (s: string): number => { try { return Number(JSON.parse(readFileSync(mark(s), 'utf8')).upto) || 0 } catch { return 0 } }

  function push(session: string): void {
    if (inflight.has(session)) return
    const entries: Entry[] = files.read(session)
    const from = Math.min(synced(session), entries.length)
    if (from >= entries.length) return
    const chunk: Entry[] = []
    let bytes = 0
    for (const e of entries.slice(from)) {
      const n = JSON.stringify(e).length
      if (chunk.length && bytes + n > CHUNK_BYTES) break
      chunk.push(e); bytes += n
    }
    if (!o.send({ type: 'session:sync', session, from, entries: chunk })) return   // not connected: the next welcome pushes it
    inflight.set(session, setTimeout(() => inflight.delete(session), INFLIGHT_MS))
  }

  function onSynced(p: { session?: string; upto?: number; gap?: boolean; conflict?: number; error?: string }): void {
    const s = String(p.session ?? '')
    clearTimeout(inflight.get(s)); inflight.delete(s)
    const done = () => { if (catching === s) next() }
    if (p.conflict !== undefined) { o.log?.(`[session-sync] ${s}: the platform has a different entry ${p.conflict} — not overwritten: ${p.error ?? ''}`); return done() }
    if (p.error) { o.log?.(`[session-sync] ${s}: ${p.error}`); return done() }
    if (typeof p.upto !== 'number') return done()
    const len = files.read(s).length
    writeFileSync(mark(s), JSON.stringify({ upto: Math.min(p.upto, len), at: new Date().toISOString() }))
    if (p.upto < len) push(s)
    else done()
  }

  // CATCHING UP AFTER A RECONNECT, ONE SESSION AT A TIME: each is brought whole (all its chunks answered) before the next
  // starts, so a box that was away long sends its sessions in turn, never all at once. A session in use is pushed as it
  // changes, whatever the queue is doing.
  let queue: string[] = []
  let catching: string | null = null
  let stuck: ReturnType<typeof setTimeout> | undefined
  function next(): void {
    clearTimeout(stuck)
    catching = null
    while (queue.length) {
      const s = queue.shift()!
      const len = files.read(s).length
      if (synced(s) >= len) continue   // the platform has it whole
      catching = s
      stuck = setTimeout(next, INFLIGHT_MS * 2)   // no answer: go on to the next; this one is tried at the next reconnect
      push(s)
      return
    }
  }
  /** Every session the platform does not have whole (after a reconnect), in turn. */
  function pushAll(): void {
    if (!existsSync(o.dir)) return
    queue = readdirSync(o.dir).filter((s) => /^[\w-]+$/.test(s) && existsSync(join(o.dir, s, 'session.jsonl')))
    next()
  }

  /** The session log, pushing up after every append. */
  const log: SessionLog = { append: (s, e) => { files.append(s, e); push(s) }, read: (s) => files.read(s) }

  return { push, pushAll, onSynced, log }
}
