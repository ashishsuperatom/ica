// ── Agent API keys ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// A project's admin creates a key for an agent — any system that works with the project on its own behalf. The key is shown once:
// only its SHA-256 is kept, with a short prefix to recognise it by. A key has a name, scopes (control-plane/shared/
// agent-scopes.ts), who made it, an optional expiry, and can be revoked; revoking is final. The key names its project,
// so an agent needs nothing else to connect:   sak_<projectId>_<43 random characters>

import { isAgentScope } from '../../shared/agent-scopes.js'
import { isOrgKeyScope } from '../../shared/permissions.js'

/** The two kinds of key: a project's (scopes from agent-scopes.ts) and an organisation's (sak_org_<org>_…, scopes
 *  from permissions.ts ORG_KEY_SCOPES). Same keeping, different table and shape. */
export interface KeyKind { table: string; prefix: (owner: string) => string; ownerOf: (key: string) => string | null; ownerOk: (owner: string) => boolean; isScope: (s: unknown) => boolean }
export const PROJECT_KEYS: KeyKind = { table: 'agent_keys', prefix: (p) => `sak_${p}_`, ownerOf: (k) => projectOfKey(k), ownerOk: (p) => /^[0-9a-f-]{36}$/.test(p), isScope: isAgentScope }
export const ORG_KEYS: KeyKind = { table: 'org_keys', prefix: (o) => `sak_org_${o}_`, ownerOf: (k) => orgOfKey(k), ownerOk: (o) => /^[0-9a-z-]{1,64}$/.test(o), isScope: isOrgKeyScope }
/** The organisation an organisation key names, or null. */
export const orgOfKey = (key: string): string | null => /^sak_org_([0-9a-z-]{1,64})_[A-Za-z0-9_-]{43}$/.exec(key)?.[1] ?? null

type Sql = { exec(q: string, ...p: unknown[]): Iterable<Record<string, unknown>> }

export interface AgentKey { id: string; name: string; prefix: string; scopes: string[]; created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; last_used_at: string | null }

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}
/** The project a key names, or null if it is not shaped like a key. */
export function projectOfKey(key: string): string | null { return /^sak_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/.exec(key)?.[1] ?? null }

export class AgentKeys {
  constructor(private sql: Sql, private project: () => string, private kind: KeyKind = PROJECT_KEYS) {}

  private row = (r: Record<string, unknown>): AgentKey => ({ id: String(r.id), name: String(r.name), prefix: String(r.prefix), scopes: JSON.parse(String(r.scopes)), created_by: String(r.created_by), created_at: String(r.created_at),
    expires_at: (r.expires_at as string) ?? null, revoked_at: (r.revoked_at as string) ?? null, revoked_by: (r.revoked_by as string) ?? null, last_used_at: (r.last_used_at as string) ?? null })

  async create(o: { name: string; scopes: string[]; by: string; expiresAt?: string | null }): Promise<{ key: string; record: AgentKey }> {
    const name = String(o.name ?? '').trim()
    if (!name || name.length > 80) throw new KeyRefusal('a key needs a name of at most 80 characters')
    if (!Array.isArray(o.scopes) || !o.scopes.length) throw new KeyRefusal('a key needs at least one scope')
    const unknown = o.scopes.filter((s) => !this.kind.isScope(s))
    if (unknown.length) throw new KeyRefusal(`there is no scope ${unknown.join(', ')}`)
    if (!o.by) throw new KeyRefusal('who is creating the key?')
    if (o.expiresAt && !(Date.parse(o.expiresAt) > Date.now())) throw new KeyRefusal('a key cannot expire in the past')
    const project = this.project()
    if (!this.kind.ownerOk(project)) throw new KeyRefusal('this project has no id yet')
    const key = `${this.kind.prefix(project)}${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
    const id = `key_${b64url(crypto.getRandomValues(new Uint8Array(9)))}`
    const at = new Date().toISOString()
    const scopes = [...new Set(o.scopes)].sort()
    this.sql.exec(`INSERT INTO ${this.kind.table} (id, name, prefix, hash, scopes, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id, name, key.slice(0, this.kind.prefix(project).length + 6), await sha256(key), JSON.stringify(scopes), o.by, at, o.expiresAt ?? null)
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
    if (this.kind.ownerOf(key) !== this.project()) return { ok: false, reason: 'not a key of this project' }
    const [r] = [...this.sql.exec(`SELECT * FROM ${this.kind.table} WHERE hash = ?`, await sha256(key))]
    if (!r) return { ok: false, reason: 'unknown key' }
    const k = this.row(r)
    if (k.revoked_at) return { ok: false, reason: 'the key was revoked' }
    if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) return { ok: false, reason: 'the key has expired' }
    this.sql.exec(`UPDATE ${this.kind.table} SET last_used_at = ? WHERE id = ?`, new Date().toISOString(), k.id)
    return { ok: true, key: k }
  }
}

export class KeyRefusal extends Error {}
