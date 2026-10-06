// ── Keys — agents' identities, in the same tree as people ───────────────────────────────────────────────────────────
//
// A key belongs to one node: a project (sak_<project>_…, in its ProjectDO) or an organisation (sak_org_<org>_…, in its
// OrgDO). It is shown once — only its SHA-256 is kept, with a short prefix to recognise it by — and has a name, the
// capabilities it was given (that level's, the names roles use), who it acts for (a person: whoever made it, or the
// person at the root of the keys that made it), the key that made it (if a key did), an optional expiry, and can be
// revoked; revoking is final. What it holds is always cut to what its maker holds now, and a key whose maker key is
// revoked or expired holds nothing — its children go with it (shared/permissions.ts keyHolds).

import { isCapability, keyHolds, type Capability } from '../../shared/permissions.js'

/** The two nodes a key belongs to: a project's keys and an organisation's. Same keeping, different table and level. */
export interface KeyKind { table: string; level: 'org' | 'project'; prefix: (owner: string) => string; ownerOf: (key: string) => string | null; ownerOk: (owner: string) => boolean }
export const PROJECT_KEYS: KeyKind = { table: 'agent_keys', level: 'project', prefix: (p) => `sak_${p}_`, ownerOf: (k) => projectOfKey(k), ownerOk: (p) => /^[0-9a-f-]{36}$/.test(p) }
export const ORG_KEYS: KeyKind = { table: 'org_keys', level: 'org', prefix: (o) => `sak_org_${o}_`, ownerOf: (k) => orgOfKey(k), ownerOk: (o) => /^[0-9a-z-]{1,64}$/.test(o) }
/** The organisation an organisation key names, or null. */
export const orgOfKey = (key: string): string | null => /^sak_org_([0-9a-z-]{1,64})_[A-Za-z0-9_-]{43}$/.exec(key)?.[1] ?? null

type Sql = { exec(q: string, ...p: unknown[]): Iterable<Record<string, unknown>> }

export interface AgentKey {
  id: string; name: string; prefix: string; capabilities: Capability[]
  /** The person it acts for. */ created_by: string
  /** The key that made it: one of this node's (its id), or an organisation's ("org:<id>") for a project key. */ made_by_key: string | null
  created_at: string; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; last_used_at: string | null }

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}
/** The project a key names, or null if it is not shaped like a key. */
export function projectOfKey(key: string): string | null { return /^sak_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/.exec(key)?.[1] ?? null }

export class AgentKeys {
  constructor(private sql: Sql, private owner: () => string, private kind: KeyKind = PROJECT_KEYS) {}

  private row = (r: Record<string, unknown>): AgentKey => ({ id: String(r.id), name: String(r.name), prefix: String(r.prefix), capabilities: JSON.parse(String(r.capabilities)), created_by: String(r.created_by), made_by_key: (r.made_by_key as string) ?? null, created_at: String(r.created_at),
    expires_at: (r.expires_at as string) ?? null, revoked_at: (r.revoked_at as string) ?? null, revoked_by: (r.revoked_by as string) ?? null, last_used_at: (r.last_used_at as string) ?? null })

  async create(o: { name: string; capabilities: string[]; by: string; madeByKey?: string | null; expiresAt?: string | null }): Promise<{ key: string; record: AgentKey }> {
    const name = String(o.name ?? '').trim()
    if (!name || name.length > 80) throw new KeyRefusal('a key needs a name of at most 80 characters')
    if (!Array.isArray(o.capabilities) || !o.capabilities.length) throw new KeyRefusal('a key needs at least one capability')
    const unknown = o.capabilities.filter((c) => !isCapability(this.kind.level, c))
    if (unknown.length) throw new KeyRefusal(`there is no ${this.kind.level} capability ${unknown.join(', ')}`)
    if (!o.by) throw new KeyRefusal('who is the key for?')
    if (o.expiresAt && !(Date.parse(o.expiresAt) > Date.now())) throw new KeyRefusal('a key cannot expire in the past')
    const owner = this.owner()
    if (!this.kind.ownerOk(owner)) throw new KeyRefusal('this node has no id yet')
    const key = `${this.kind.prefix(owner)}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
    const id = `key_${b64url(crypto.getRandomValues(new Uint8Array(9)))}`
    const at = new Date().toISOString()
    const caps = [...new Set(o.capabilities)].sort()
    this.sql.exec(`INSERT INTO ${this.kind.table} (id, name, prefix, hash, capabilities, created_by, made_by_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, name, key.slice(0, this.kind.prefix(owner).length + 6), await sha256(key), JSON.stringify(caps), o.by, o.madeByKey ?? null, at, o.expiresAt ?? null)
    return { key, record: this.get(id)! }
  }

  get(id: string): AgentKey | null { const [r] = [...this.sql.exec(`SELECT * FROM ${this.kind.table} WHERE id = ?`, id)]; return r ? this.row(r) : null }
  list(): AgentKey[] { return [...this.sql.exec(`SELECT * FROM ${this.kind.table} ORDER BY created_at DESC`)].map(this.row) }

  revoke(id: string, by: string): AgentKey {
    const k = this.get(id)
    if (!k) throw new KeyRefusal(`there is no key ${id}`)
    if (k.revoked_at) throw new KeyRefusal(`key ${id} was already revoked`)
    this.sql.exec(`UPDATE ${this.kind.table} SET revoked_at = ?, revoked_by = ? WHERE id = ?`, new Date().toISOString(), by, id)
    return this.get(id)!
  }

  /** The live key this secret is, or why not. Marks it used. */
  async verify(key: string): Promise<{ ok: true; key: AgentKey } | { ok: false; reason: string }> {
    if (this.kind.ownerOf(key) !== this.owner()) return { ok: false, reason: `not a key of this ${this.kind.level === 'org' ? 'organisation' : 'project'}` }
    const [r] = [...this.sql.exec(`SELECT * FROM ${this.kind.table} WHERE hash = ?`, await sha256(key))]
    if (!r) return { ok: false, reason: 'unknown key' }
    const k = this.row(r)
    if (k.revoked_at) return { ok: false, reason: 'the key was revoked' }
    if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) return { ok: false, reason: 'the key has expired' }
    this.sql.exec(`UPDATE ${this.kind.table} SET last_used_at = ? WHERE id = ?`, new Date().toISOString(), k.id)
    return { ok: true, key: k }
  }

  /** May the key `actor` act on key `id`? A key reaches only the keys below it — those it made, and theirs. A person, or
   *  a key of the node above ("org:…"), reaches every key of this node. */
  reaches(actor: string | null, id: string): boolean {
    if (!actor || actor.includes(':')) return true
    const seen = new Set<string>()
    for (let k = this.get(id); k?.made_by_key && !seen.has(k.id); k = this.get(k.made_by_key)) { seen.add(k.id); if (k.made_by_key === actor) return true }
    return false
  }

  /** Is it in force (not revoked, not expired)? */
  live(k: AgentKey): boolean { return !k.revoked_at && !(k.expires_at && Date.parse(k.expires_at) <= Date.now()) }

  /** What a key holds now: what it was given, cut to what its maker holds now — the person it acts for, or the key of
   *  this node that made it (whose own holding is cut the same way, up to a person). A key made by a key no longer in
   *  force holds nothing. A key made by another node's key ("org:…") is cut to its person here; whether that maker key
   *  is in force is the caller's to ask of that node. */
  holds(k: AgentKey, personHolds: (who: string) => readonly string[], seen = new Set<string>()): Capability[] {
    if (!this.live(k) || seen.has(k.id)) return []
    seen.add(k.id)
    if (k.made_by_key && !k.made_by_key.includes(':')) {
      const parent = this.get(k.made_by_key)
      return parent ? keyHolds(k.capabilities, this.holds(parent, personHolds, seen)) : []
    }
    return keyHolds(k.capabilities, personHolds(k.created_by))
  }
}

export class KeyRefusal extends Error {}
