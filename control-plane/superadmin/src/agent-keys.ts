// ── Agent API keys ───────────────────────────────────────────────────────────────────────────────────────────────────
//
// A project's admin creates a key for an agent — any system that works with the project on its own behalf. The key is shown once:
// only its SHA-256 is kept, with a short prefix to recognise it by. A key has a name, scopes (control-plane/shared/
// agent-scopes.ts), who made it, an optional expiry, and can be revoked; revoking is final. The key names its project,
// so an agent needs nothing else to connect:   sak_<projectId>_<43 random characters>

import { isAgentScope, type AgentScope } from '../../shared/agent-scopes.js'

type Sql = { exec(q: string, ...p: unknown[]): Iterable<Record<string, unknown>> }

export interface AgentKey { id: string; name: string; prefix: string; scopes: AgentScope[]; created_by: string; created_at: string; expires_at: string | null; revoked_at: string | null; revoked_by: string | null; last_used_at: string | null }

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('')
}
/** The project a key names, or null if it is not shaped like a key. */
export const projectOfKey = (key: string): string | null => /^sak_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/.exec(key)?.[1] ?? null

export class AgentKeys {
  constructor(private sql: Sql, private project: () => string) {}

  private row = (r: Record<string, unknown>): AgentKey => ({ id: String(r.id), name: String(r.name), prefix: String(r.prefix), scopes: JSON.parse(String(r.scopes)), created_by: String(r.created_by), created_at: String(r.created_at),
    expires_at: (r.expires_at as string) ?? null, revoked_at: (r.revoked_at as string) ?? null, revoked_by: (r.revoked_by as string) ?? null, last_used_at: (r.last_used_at as string) ?? null })

  async create(o: { name: string; scopes: string[]; by: string; expiresAt?: string | null }): Promise<{ key: string; record: AgentKey }> {
    const name = String(o.name ?? '').trim()
    if (!name || name.length > 80) throw new KeyRefusal('a key needs a name of at most 80 characters')
    if (!Array.isArray(o.scopes) || !o.scopes.length) throw new KeyRefusal('a key needs at least one scope')
    const unknown = o.scopes.filter((s) => !isAgentScope(s))
    if (unknown.length) throw new KeyRefusal(`there is no scope ${unknown.join(', ')}`)
    if (!o.by) throw new KeyRefusal('who is creating the key?')
    if (o.expiresAt && !(Date.parse(o.expiresAt) > Date.now())) throw new KeyRefusal('a key cannot expire in the past')
    const project = this.project()
    if (!/^[0-9a-f-]{36}$/.test(project)) throw new KeyRefusal('this project has no id yet')
    const key = `sak_${project}_${b64url(crypto.getRandomValues(new Uint8Array(32)))}`
    const id = `key_${b64url(crypto.getRandomValues(new Uint8Array(9)))}`
    const at = new Date().toISOString()
    const scopes = [...new Set(o.scopes)].sort()
    this.sql.exec('INSERT INTO agent_keys (id, name, prefix, hash, scopes, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, name, key.slice(0, 4 + 36 + 1 + 6), await sha256(key), JSON.stringify(scopes), o.by, at, o.expiresAt ?? null)
    return { key, record: this.get(id)! }
  }

  get(id: string): AgentKey | null { const [r] = [...this.sql.exec('SELECT * FROM agent_keys WHERE id = ?', id)]; return r ? this.row(r) : null }
  list(): AgentKey[] { return [...this.sql.exec('SELECT * FROM agent_keys ORDER BY created_at DESC')].map(this.row) }

  revoke(id: string, by: string): AgentKey {
    const k = this.get(id)
    if (!k) throw new KeyRefusal(`there is no key ${id}`)
    if (k.revoked_at) throw new KeyRefusal(`key ${id} was already revoked`)
    this.sql.exec('UPDATE agent_keys SET revoked_at = ?, revoked_by = ? WHERE id = ?', new Date().toISOString(), by, id)
    return this.get(id)!
  }

  /** The live key this secret is, or why not. Marks it used. */
  async verify(key: string): Promise<{ ok: true; key: AgentKey } | { ok: false; reason: string }> {
    if (projectOfKey(key) !== this.project()) return { ok: false, reason: 'not a key of this project' }
    const [r] = [...this.sql.exec('SELECT * FROM agent_keys WHERE hash = ?', await sha256(key))]
    if (!r) return { ok: false, reason: 'unknown key' }
    const k = this.row(r)
    if (k.revoked_at) return { ok: false, reason: 'the key was revoked' }
    if (k.expires_at && Date.parse(k.expires_at) <= Date.now()) return { ok: false, reason: 'the key has expired' }
    this.sql.exec('UPDATE agent_keys SET last_used_at = ? WHERE id = ?', new Date().toISOString(), k.id)
    return { ok: true, key: k }
  }
}

export class KeyRefusal extends Error {}
