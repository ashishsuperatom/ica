// DRAFT AND PUBLISHED VERSIONS. Every change is saved the moment it is made — the change log is the truth and time
// travel reads it — but a change is only a change: what the project's agents read is the latest PUBLISHED version (v1,
// v2, …), a point of that log given a message. What changed since it is the draft: its nodes as they differ from the
// published graph. Publishing makes the next version of the draft; discarding sets the draft back to the published
// graph; bringing an older version into the draft and publishing it starts a new line from that version — the history
// of versions is a tree. Nothing is ever rewritten: going back writes changes that bring nodes back.

import type { Store, Version, Change, Kind } from './store.js'
import { GovernanceRefusal, type Actor } from './governance.js'

/** The version the project's agents read: the latest published, or null before the first. */
export function published(store: Store): Version | null {
  return store.versions().reduce<Version | null>((a, v) => (!a || v.upto > a.upto || (v.upto === a.upto && v.id > a.id) ? v : a), null)
}

/** The change the agents read the graph at: the published version's, or undefined (the graph as it is) before the first. */
export const publishedUpto = (store: Store): number | undefined => published(store)?.upto

/** One node of the draft: how it differs from the published graph (null: not there). */
export interface DraftNode { name: string; kind: Kind; was: string | null; now: string | null }

/** The draft: every node that differs from the published graph (every node, before the first version). */
export function draft(store: Store): DraftNode[] {
  const p = published(store)
  const then = new Map((p ? store.names(undefined, { upto: p.upto }) : []).map((x) => [x.name, x]))
  const now = new Map(store.names().map((x) => [x.name, x]))
  const out: DraftNode[] = []
  for (const [n, cur] of now) { const was = then.get(n); if (!was || was.hash !== cur.hash || was.scope !== cur.scope) out.push({ name: n, kind: cur.kind, was: was?.hash ?? null, now: cur.hash }) }
  for (const [n, was] of then) if (!now.has(n)) out.push({ name: n, kind: was.kind, was: was.hash, now: null })
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Publish the draft as the next version (v1, v2, …), with what it is. The agents read it from then on. */
export function publishDraft(store: Store, actor: Actor, message: string): Version {
  if (!actor.admin) throw new GovernanceRefusal('publishing the graph is for someone who may publish')
  const m = String(message ?? '').trim()
  if (!m) throw new GovernanceRefusal('a version says what changed in it (its message)')
  if (!draft(store).length) throw new GovernanceRefusal('nothing in the draft to publish — it is the published graph')
  const upto = store.lastChange()
  const name = `v${store.versions().length + 1}`
  store.db.prepare('INSERT INTO version (name, message, upto, at, by) VALUES (?, ?, ?, ?, ?)').run(name, m, upto, Date.now(), actor.id)
  return store.version(name)!
}

/** The changes made since the published version (the draft's history, in order). */
export function sincePublished(store: Store): Change[] {
  return store.changesBetween(published(store)?.upto ?? 0)
}

/** Set the draft to a version: every node that differs is set back (or taken away, or brought back) as new changes. The
 *  latest published version discards the draft; an older one, published after, starts a new line from it. */
export function restoreVersion(store: Store, actor: Actor, name: string): string[] {
  if (!actor.admin) throw new GovernanceRefusal('bringing a version back is for someone who may publish')
  const v = store.version(name)
  if (!v) throw new GovernanceRefusal(`there is no version "${name}"`)
  const then = new Map(store.names(undefined, { upto: v.upto }).map((x) => [x.name, x]))
  const now = new Map(store.names().map((x) => [x.name, x]))
  const ctx = { by: actor.id, reason: `back to version ${v.name}` }
  const changed: string[] = []
  store.db.atomic(() => {
    for (const [n] of now) if (!then.has(n)) { store.remove(n, ctx); changed.push(n) }
    for (const [n, was] of then) {
      const cur = now.get(n)
      if (cur && cur.hash === was.hash && cur.scope === was.scope) continue
      const at = store.get(n, undefined, v.upto)!
      store.put(n, was.kind, at.body, ctx, { scope: was.scope })
      changed.push(n)
    }
  })
  return changed
}

/** A published version on its line: the one it was published from (the version before it, or the one brought back into
 *  the draft before it was published), what it changed and who published it. */
export interface Line extends Version { n: number; from: number; count: number; names: string[]; parent: string | null; restoredFrom: string | null }

/** The published versions, oldest first, each with its parent — the tree a git graph draws. */
export function versionLine(store: Store): Line[] {
  const list = [...store.versions()].sort((a, b) => a.upto - b.upto || a.id - b.id)
  const out: Line[] = []
  let prev: Version | null = null
  for (const v of list) {
    const changes = store.changesBetween(prev?.upto ?? 0, v.upto)
    let restoredFrom: string | null = null
    for (const c of changes) { const m = /^back to version (.+)$/.exec(c.reason ?? ''); if (m && m[1] !== prev?.name) restoredFrom = m[1]; else if (m) restoredFrom = null }
    const names: string[] = []
    for (const c of changes) if (!names.includes(c.name) && names.length < 8) names.push(c.name)
    out.push({ ...v, n: out.length + 1, from: (prev?.upto ?? 0) + 1, count: changes.length, names, parent: restoredFrom ?? prev?.name ?? null, restoredFrom })
    prev = v
  }
  return out
}
