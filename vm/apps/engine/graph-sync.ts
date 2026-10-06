// THE GRAPH TO THE PLATFORM, AND BACK. The platform keeps the composition graph's records (in the project's Durable Object); this engine's
// graph is the replica it writes first. On every welcome:
//
//   1. ask where the platform's copy ends (its cursor);
//   2. this graph empty, the platform's not → rebuild from the platform (a new box, a lost disk) — then done;
//   3. otherwise send an ANCHOR: this graph's change at the last point both should share. The platform compares it:
//      different → the histories diverged: said loudly, nothing more pushed or pulled until someone looks;
//   4. the same, and this graph is behind → catch up from the platform; ahead → push what the platform lacks.
//
// After a graph change here (and once a minute, for changes the composition-graph CLI made) it pushes again.

import { join } from 'node:path'
import { Store, replicaSince, applyReplica, START, type Cursor } from '@superatom/composition-graph'

const BATCH = 200
type State = 'idle' | 'asking' | 'anchoring' | 'pulling' | 'pushing' | 'stopped'

export function createGraphSync(o: { file: string; send: (msg: Record<string, unknown>) => boolean; log?: (s: string) => void }) {
  let store: Store | null = null
  const open = () => (store ??= new Store(o.file))
  let state: State = 'idle'
  let platform: Cursor = START

  const one = (q: string) => Number((open().db.prepare(q).get() as { v: number | null } | undefined)?.v ?? 0)
  const local = (): Cursor => ({ change: one('SELECT MAX(id) AS v FROM change'), suggestion: one('SELECT MAX(id) AS v FROM suggestion'), decisionAt: one('SELECT MAX(at) AS v FROM decision'), version: one('SELECT MAX(id) AS v FROM version') })
  const isEmpty = (c: Cursor) => !c.change && !c.suggestion && !c.decisionAt
  const ahead = (l: Cursor, p: Cursor) => l.change > p.change || l.suggestion > p.suggestion || l.decisionAt > p.decisionAt || (l.version ?? 0) > (p.version ?? 0)

  function stop(why: string) { state = 'stopped'; o.log?.(`[graph-sync] ${why} — nothing more is pushed or pulled until someone looks`) }

  function push(): void {
    if (state !== 'idle' && state !== 'pushing') return
    const batch = replicaSince(open(), platform, BATCH)
    const { next: _n, ...records } = batch
    if (!records.changes.length && !records.suggestions.length && !(records.versions?.length) && !records.decisions.some((d) => Number(d.at) > platform.decisionAt)) {
      if (state === 'pushing') o.log?.(`[graph-sync] the platform has the graph (up to change ${platform.change})`)
      state = 'idle'; return
    }
    if (o.send({ type: 'graph:sync', batch: records })) state = 'pushing'
  }
  const pull = (from: Cursor) => { if (o.send({ type: 'graph:pull', cursor: from })) state = 'pulling' }

  function onMessage(p: any): void {
    if (state === 'stopped') return
    if (p.error && !p.conflict) { o.log?.(`[graph-sync] ${p.error}`); state = 'idle'; return }
    if (p.t === 'graph:cursor') {
      platform = p.cursor
      const l = local()
      if (isEmpty(l)) { if (!isEmpty(platform)) { o.log?.('[graph-sync] this engine\'s graph is empty — rebuilding it from the platform'); pull(START) } else state = 'idle'; return }
      const anchor = Math.min(l.change, platform.change)
      if (!anchor) { state = 'idle'; push(); return }
      const row = open().db.prepare('SELECT id, at, name, kind, from_hash, to_hash, by, reason, evidence, scope, owner FROM change WHERE id = ?').get(anchor)
      if (!row) { stop(`change ${anchor} is missing here though later ones exist`); return }
      if (o.send({ type: 'graph:sync', batch: { changes: [row], suggestions: [], decisions: [], contents: {} } })) state = 'anchoring'
    } else if (p.t === 'graph:synced') {
      if (p.conflict) { stop(`the platform has a different record (${p.error})`); return }
      if (state === 'anchoring') {
        const l = local()
        if (!ahead(l, platform) && (l.change < platform.change || l.suggestion < platform.suggestion || l.decisionAt < platform.decisionAt || (l.version ?? 0) < (platform.version ?? 0))) { o.log?.('[graph-sync] this engine is behind the platform — catching up'); pull(l); return }
        o.log?.(`[graph-sync] in step with the platform (its copy up to change ${platform.change}, here ${l.change})`)
        state = 'pushing'; push(); return
      }
      platform = p.cursor; push()   // still 'pushing': the next batch, or the word that the platform has it all
    } else if (p.t === 'graph:batch') {
      const b = p.batch
      const known = (d: any) => !!open().db.prepare('SELECT 1 FROM decision WHERE suggestion = ?').get(d.suggestion)
      const done = !b.changes.length && !b.suggestions.length && !(b.versions?.length) && b.decisions.every(known)
      try { applyReplica(open(), b) } catch (e: any) { stop(`taking the platform's records failed: ${e?.message ?? e}`); return }
      if (done) { o.log?.('[graph-sync] rebuilt from the platform'); state = 'idle'; push(); return }
      pull(b.next)
    }
  }

  /** On every (re)connection: start from asking where the platform's copy ends. */
  function welcome(): void { if (state === 'stopped') return; state = 'asking'; o.send({ type: 'graph:cursor' }) }

  const timer = setInterval(() => { if (state === 'idle') push() }, 60_000)
  timer.unref?.()
  return { welcome, push: () => { if (state === 'idle') push() }, onMessage, close: () => { clearInterval(timer); store?.close(); store = null }, get state() { return state }, get stopped() { return state === 'stopped' } }
}

export const graphFileOf = (projectDir: string) => join(projectDir, 'db', 'composition.sqlite')
