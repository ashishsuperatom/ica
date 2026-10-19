// ── A person's keys, in their UserDO (docs/one-door-plan.md, step 4) ─────────────────────────────────────────────────
//
// Every key acts for one person and is checked at that person's door: here, by its SHA-256 (the only place a key's
// secret is checked), with where it works — a project, or the organisation (whose projects it may reach as the
// organisation allows). The project or organisation keeps the reference row and is the authority on it: it decides
// again what the key holds, and a revoke there counts at once; this copy hears of it and stops the key at the door.

import { sha256 } from './agent-keys.js'

type Sql = { exec(q: string, ...p: unknown[]): Iterable<Record<string, unknown>> }

/** A key a project or organisation made for this person: kept by hash, with where it works. */
export function keepKey(sql: Sql, b: { id?: unknown; hash?: unknown; email?: unknown; scope?: { kind?: unknown; id?: unknown }; expiresAt?: unknown }): string | null {
  const id = String(b.id ?? ''), hash = String(b.hash ?? ''), email = String(b.email ?? '').toLowerCase()
  const kind = String(b.scope?.kind ?? ''), where = String(b.scope?.id ?? '')
  if (!/^key_[\w-]{4,40}$/.test(id) || !/^[0-9a-f]{64}$/.test(hash) || !email.includes('@') || (kind !== 'project' && kind !== 'org') || !where) return 'a key names its id, hash, person and where it works'
  sql.exec('INSERT INTO keys (id, hash, email, scope_kind, scope_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET hash = excluded.hash, expires_at = excluded.expires_at, revoked_at = NULL',
    id, hash, email, kind, where, new Date().toISOString(), typeof b.expiresAt === 'string' ? b.expiresAt : null)
  return null
}

export function revokeKey(sql: Sql, id: string) {
  sql.exec('UPDATE keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', new Date().toISOString(), id)
}

/** The key this secret is, if it may work on `target` (a project, an organisation): who it acts for and its id — or why
 *  not. An organisation's key may go to a project: the project asks its organisation what the key holds there. */
export async function checkKey(sql: Sql, key: string, target: { kind: string; id: string }): Promise<{ ok: true; keyId: string; email: string } | { ok: false; reason: string }> {
  const [r] = [...sql.exec('SELECT * FROM keys WHERE hash = ?', await sha256(key))] as any[]
  if (!r) return { ok: false, reason: 'unknown key' }
  if (r.revoked_at) return { ok: false, reason: 'the key was revoked' }
  if (r.expires_at && Date.parse(String(r.expires_at)) <= Date.now()) return { ok: false, reason: 'the key has expired' }
  const fits = (r.scope_kind === target.kind && r.scope_id === target.id) || (r.scope_kind === 'org' && target.kind === 'project')
  if (!fits) return { ok: false, reason: `the key works in ${r.scope_kind === 'org' ? 'its organisation' : 'another project'}` }
  return { ok: true, keyId: String(r.id), email: String(r.email) }
}
