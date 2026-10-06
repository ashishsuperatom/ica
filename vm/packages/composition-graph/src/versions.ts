// NAMED VERSIONS ("Named versions of the composition graph", docs/platform-architecture.md): every change is saved the
// moment it is made — the change log is the truth and time travel reads it — and a version is a name and a message
// given to one moment of that log, like a git tag. Naming one lists the changes since the last; reading one is the
// graph as of its moment; making one the current graph writes the changes that bring today's graph back to it (new
// changes in the log — history is never rewritten).

import type { Store, Version, Change } from './store.js'
import { GovernanceRefusal, type Actor } from './governance.js'

const NAME = /^[\w][\w .:-]{0,59}$/

/** Name the graph as it is now. Someone who may publish names versions (a version is the project's word for a state). */
export function nameVersion(store: Store, actor: Actor, name: string, message: string, at?: number): Version {
  if (!actor.admin) throw new GovernanceRefusal('naming a version is for someone who may publish')
  const n = String(name ?? '').trim(), m = String(message ?? '').trim()
  if (!NAME.test(n)) throw new GovernanceRefusal('a version is named with letters, digits, spaces, dots and dashes (at most 60)')
  if (!m) throw new GovernanceRefusal('a version says what it is (its message)')
  if (store.version(n)) throw new GovernanceRefusal(`there is already a version "${n}"`)
  const last = store.lastChange()
  if (!last) throw new GovernanceRefusal('the graph has no changes to name yet')
  if (at !== undefined && (!Number.isInteger(at) || at < 1 || at > last)) throw new GovernanceRefusal(`there is no change ${at}`)
  const upto = at ?? last
  store.db.prepare('INSERT INTO version (name, message, upto, at, by) VALUES (?, ?, ?, ?, ?)').run(n, m, upto, Date.now(), actor.id)
  return store.version(n)!
}

/** What changed since the last version — what naming a version now would cover. */
export function sinceLastVersion(store: Store): Change[] {
  const last = store.versions()[0]
  return store.changesBetween(last?.upto ?? 0)
}

/** Make the graph what it was at a version: each node that differs is set back (or taken away, or brought back) as a new
 *  change. Returns the names changed. */
export function restoreVersion(store: Store, actor: Actor, name: string): string[] {
  const v = store.version(name)
  if (!v) throw new GovernanceRefusal(`there is no version "${name}"`)
  return restoreAt(store, actor, v.upto, `back to version ${v.name}`)
}

/** Make the graph what it was after change `upto` (any step of its history, named or not). */
export function restoreStep(store: Store, actor: Actor, upto: number): string[] {
  if (!Number.isInteger(upto) || upto < 1 || upto > store.lastChange()) throw new GovernanceRefusal(`there is no change ${upto}`)
  return restoreAt(store, actor, upto, `back to #${upto}`)
}

function restoreAt(store: Store, actor: Actor, upto: number, reason: string): string[] {
  if (!actor.admin) throw new GovernanceRefusal('making a version the current graph is for someone who may publish')
  const v = { upto }
  const then = new Map(store.names(undefined, { upto: v.upto }).map((x) => [x.name, x]))
  const now = new Map(store.names().map((x) => [x.name, x]))
  const ctx = { by: actor.id, reason }
  const changed: string[] = []
  store.db.exec('SAVEPOINT cg_restore')
  try {
    for (const [n, cur] of now) if (!then.has(n)) { store.remove(n, ctx); changed.push(n) }
    for (const [n, was] of then) {
      const cur = now.get(n)
      if (cur && cur.hash === was.hash && cur.scope === was.scope) continue
      const at = store.get(n, undefined, v.upto)!
      store.put(n, was.kind, at.body, ctx, { scope: was.scope })
      changed.push(n)
    }
    store.db.exec('RELEASE cg_restore')
  } catch (e) { store.db.exec('ROLLBACK TO cg_restore'); store.db.exec('RELEASE cg_restore'); throw e }
  return changed
}


/** One step of the graph's history: a run of changes by one person without a long pause (or a going back, or the end of a
 *  named version), numbered from 1 in order. Every step is a version, named or not; a name is a tag on one. A going back
 *  starts a new line from the step it went back to — the history is a tree, drawn like a git graph. */
export interface Step {
  n: number; from: number; upto: number; startAt: number; at: number; by: string; count: number
  /** The nodes it changed (the first few) and why (its reasons, each once). */
  names: string[]; reasons: string[]
  /** Names given to it. */
  tags: string[]
  /** The step it grew from: the one before it, or the one it went back to. */
  parent: number | null
  restoredTo: number | null
}

/** The graph's history as steps. `pauseMs`: a pause longer than this between one person's changes starts a new step. */
export function steps(store: Store, pauseMs = 30 * 60_000): Step[] {
  const versions = store.versions()
  const tagAt = new Map<number, string[]>()
  for (const v of versions) tagAt.set(v.upto, [...(tagAt.get(v.upto) ?? []), v.name])
  const backTo = (reason: string | null): number | null => {
    const m = /^back to (?:version (.+)|#(\d+))$/.exec(reason ?? ''); if (!m) return null
    return m[2] ? Number(m[2]) : versions.find((v) => v.name === m[1])?.upto ?? null
  }
  const out: (Step & { target: number | null })[] = []
  let cur: (Step & { target: number | null }) | null = null
  for (const c of store.changesBetween(0)) {
    const target = backTo(c.reason)
    const fresh = !cur || cur.by !== c.by || c.at - cur.at > pauseMs || tagAt.has(cur.upto) || cur.target !== target
    if (fresh) {
      cur = { n: out.length + 1, from: c.id, upto: c.id, startAt: c.at, at: c.at, by: c.by, count: 0, names: [], reasons: [], tags: [], parent: out.length || null, restoredTo: null, target }
      out.push(cur)
    }
    cur!.upto = c.id; cur!.at = c.at; cur!.count++
    if (!cur!.names.includes(c.name) && cur!.names.length < 6) cur!.names.push(c.name)
    if (c.reason && !cur!.reasons.includes(c.reason) && cur!.reasons.length < 3) cur!.reasons.push(c.reason)
  }
  const stepOf = (upto: number) => out.find((x) => x.from <= upto && upto <= x.upto)?.n ?? null
  return out.map(({ target, ...x }) => {
    const restoredTo = target === null ? null : stepOf(target)
    return { ...x, tags: tagAt.get(x.upto) ?? [], restoredTo, parent: restoredTo ?? x.parent }
  })
}
