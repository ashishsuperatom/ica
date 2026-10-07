// THE GRAPH'S REPLICA. The composition graph lives in the platform (the project's Durable Object): every read people
// make and every change is made there. This engine keeps a replica in its own SQLite (<projectDir>/db/composition.sqlite)
// that it only ever pulls into — never writes — so the agents compose from it locally, at once:
//
//   on every welcome, and whenever the platform says the graph changed (graph:changed): ask for what comes after this
//   replica's cursor (graph:pull) and apply each batch in order until nothing is left.
//
// A record here that differs from the platform's (written here by hand, or kept from before the platform held the graph)
// means this replica is wrong: it is set aside and rebuilt from the platform, which is always right. Once caught up after
// a welcome it compares its change log's fingerprint with the platform's (graph:fingerprint), so a replica that drifted
// without a conflict is found too. The replica keeps the log, not only the current state: this engine reads the graph's
// published version (as of a version), which needs the history. The graph is small; replaying it is cheap.

import { join } from 'node:path'
import { renameSync, existsSync } from 'node:fs'
import { openStore, applyReplica, ReplicaConflict, START, changesFingerprint, type Store, type Cursor } from '@superatom/composition-graph/node'

export const graphFileOf = (projectDir: string) => join(projectDir, 'db', 'composition.sqlite')

export function createGraphReplica(o: { file: string; send: (msg: Record<string, unknown>) => boolean; log?: (s: string) => void }) {
  let store: Store | null = null
  const open = () => (store ??= openStore(o.file))
  let pulling = false, again = false, checked = false
  const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  const one = (q: string) => Number((open().db.prepare(q).get() as { v: number | null } | undefined)?.v ?? 0)
  const cursor = (): Cursor => ({ change: one('SELECT MAX(id) AS v FROM change'), suggestion: one('SELECT MAX(id) AS v FROM suggestion'), decisionAt: one('SELECT MAX(at) AS v FROM decision'), version: one('SELECT MAX(id) AS v FROM version') })

  /** Ask for what this replica lacks (one pull at a time; a change said during one pulls again after it). */
  function pull(from: Cursor = cursor()) {
    if (pulling) { again = true; return }
    if (o.send({ type: 'graph:pull', cursor: from })) pulling = true
  }

  function onBatch(p: any) {
    pulling = false
    if (p.error) { o.log?.(`[graph] the platform did not give the graph: ${p.error}`); return }
    const b = p.batch
    const known = (d: any) => !!open().db.prepare('SELECT 1 FROM decision WHERE suggestion = ?').get(d.suggestion)
    const done = !b.changes.length && !b.suggestions.length && !(b.versions?.length) && b.decisions.every(known)
    try { applyReplica(open(), b) }
    catch (e: any) {
      if (e instanceof ReplicaConflict) return rebuild(e.message)
      o.log?.(`[graph] taking the platform's graph failed: ${e?.message ?? e}`); return
    }
    if (!done) { pull(b.next); return }
    // Caught up: this replica holds nothing the platform does not (a change made here would be one it lacks).
    const here = cursor(), there = p.cursor as Cursor | undefined
    if (there && (here.change > there.change || here.suggestion > there.suggestion || (here.version ?? 0) > (there.version ?? 0)))
      return rebuild(`it holds records the platform does not (change ${here.change}, the platform's ${there.change})`)
    if (again) { again = false; pull(); return }
    if (!checked) { checked = true; o.send({ type: 'graph:fingerprint', reqId: `gfp_${Date.now().toString(36)}` }) }
  }
  async function onFingerprint(p: any) {
    const here = await changesFingerprint(open().db.prepare('SELECT id, name, to_hash FROM change').all() as any[])
    if (here.hash !== p.hash) rebuild(`its change log differs from the platform's (${here.count} changes here, ${p.count} there)`)
  }

  /** This replica disagrees with the platform: set it aside, and take the platform's whole. */
  function rebuild(why: string) {
    store?.close(); store = null
    const aside = `${o.file}.differs-${Date.now()}`
    for (const ext of ['', '-wal', '-shm']) if (existsSync(o.file + ext)) renameSync(o.file + ext, aside + ext)
    o.log?.(`[graph] this replica differed from the platform (${why}) — set aside as ${aside}; rebuilding from the platform`)
    pull(START)
  }

  return {
    /** On every (re)connection to the platform. */
    welcome: () => { pulling = false; checked = false; pull() },
    /** A message from the platform about the graph. */
    onMessage: (p: any) => {
      if (p?.t === 'graph:batch') onBatch(p)
      else if (p?.t === 'graph:changed') pull()
      else if (p?.t === 'graph:fingerprint') void onFingerprint(p)
      else if (p?.t === 'graph:written') { const w = waiting.get(String(p.reqId)); if (!w) return; waiting.delete(String(p.reqId)); clearTimeout(w.timer); p.error ? w.reject(new Error(p.error)) : w.resolve(p.results) }
    },
    /** Nodes written in the platform's graph for a person (who, as the hub stamped them) — e.g. an agent made from a
     *  session. The platform's governance decides; this replica gets the result by its next pull. */
    write: (who: Record<string, unknown>, writes: { name: string; kind: string; body: unknown; reason: string; scope?: string }[]) => new Promise<any[]>((resolve, reject) => {
      const reqId = `gw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error('the platform did not answer the graph write in time')) }, 30_000)
      waiting.set(reqId, { resolve, reject, timer })
      if (!o.send({ type: 'graph:write', who, writes, reqId })) { clearTimeout(timer); waiting.delete(reqId); reject(new Error('the platform is not reachable')) }
    }),
    /** A question routed to a domain, recorded by the platform. */
    asked: (question: Record<string, unknown>) => { o.send({ type: 'graph:asked', question }) },
    close: () => { store?.close(); store = null },
  }
}
