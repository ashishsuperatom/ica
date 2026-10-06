// NAMED VERSIONS ("Named versions of the composition graph", docs/platform-architecture.md): every change is saved the
// moment it is made — the change log is the truth and time travel reads it — and a version is a name and a message
// given to one moment of that log, like a git tag. Naming one lists the changes since the last; reading one is the
// graph as of its moment; making one the current graph writes the changes that bring today's graph back to it (new
// changes in the log — history is never rewritten).

import type { Store, Version, Change } from './store.js'
import { GovernanceRefusal, type Actor } from './governance.js'

const NAME = /^[\w][\w .:-]{0,59}$/

/** Name the graph as it is now. Someone who may publish names versions (a version is the project's word for a state). */
export function nameVersion(store: Store, actor: Actor, name: string, message: string): Version {
  if (!actor.admin) throw new GovernanceRefusal('naming a version is for someone who may publish')
  const n = String(name ?? '').trim(), m = String(message ?? '').trim()
  if (!NAME.test(n)) throw new GovernanceRefusal('a version is named with letters, digits, spaces, dots and dashes (at most 60)')
  if (!m) throw new GovernanceRefusal('a version says what it is (its message)')
  if (store.version(n)) throw new GovernanceRefusal(`there is already a version "${n}"`)
  const upto = store.lastChange()
  if (!upto) throw new GovernanceRefusal('the graph has no changes to name yet')
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
  if (!actor.admin) throw new GovernanceRefusal('making a version the current graph is for someone who may publish')
  const v = store.version(name)
  if (!v) throw new GovernanceRefusal(`there is no version "${name}"`)
  const then = new Map(store.names(undefined, { upto: v.upto }).map((x) => [x.name, x]))
  const now = new Map(store.names().map((x) => [x.name, x]))
  const ctx = { by: actor.id, reason: `back to version ${v.name}` }
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

/** The versions as a tree: each one's parent is the version the graph was last made into before it was named (a restore,
 *  "back to version X"), else the version named before it. `now` is where the graph is: on the same line. Simpler than
 *  git — one line that branches where a version was gone back to. */
export function versionTree(store: Store): { parents: Record<string, string | null>; now: string | null } {
  const list = [...store.versions()].sort((a, b) => a.upto - b.upto || a.id - b.id)
  const backTo = (after: number, upto?: number): string | null => {
    let found: string | null = null
    for (const c of store.changesBetween(after, upto)) { const m = /^back to version (.+)$/.exec(c.reason ?? ''); if (m) found = m[1] }
    return found
  }
  const parents: Record<string, string | null> = {}
  let prev: (typeof list)[number] | null = null
  for (const v of list) {
    parents[v.name] = backTo(prev?.upto ?? 0, v.upto) ?? prev?.name ?? null
    prev = v
  }
  return { parents, now: prev ? backTo(prev.upto) ?? prev.name : null }
}
