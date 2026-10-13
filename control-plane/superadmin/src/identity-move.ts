// ── TEMPORARY: the move to email identities (2026-10-13; shared/identity.ts). Removed once every project has moved. ──
//
// People were known by their sign-in provider's id (user:<clerk id>), which changed when Clerk did. They are now
// user:<personId(email)>, and their own Durable Object is person:<org>:<personId>. For one project this:
//   1. finds each old id's email — from the project's own records: session owners, knowledge authors, the audit
//      history, connections — never guessed; an old id with no email is reported, not moved;
//   2. copies that person's rows for this project (sessions, entries, inbox, queries…) from the old home (user:<old>)
//      into the new one — the old home is left as it was;
//   3. points what is current at the new id: session owners, program owners;
//   4. has the engine append an `owner` entry to each session owned under an old id.
// A dry run reports all of it and changes nothing. Each old id is moved once (identity_moves).

import { personId, personHome } from '../../shared/identity.js'

type Sql = { exec(q: string, ...p: unknown[]): { toArray(): unknown[] } }
const isNew = (id: string) => /^[0-9a-f]{32}$/.test(id)

export interface MoveReport {
  dry: boolean
  people: { email: string; from: string[]; to: string; sessions: number; programs: number; rows: Record<string, number>; already?: boolean }[]
  unmatched: string[]
  engine?: unknown
}

export async function moveIdentities(o: {
  sql: Sql; org: string; project: string; dry: boolean
  home: (name: string) => { exportRows(projects: string[], org: string): Promise<Record<string, Record<string, unknown>[]>>; importRows(d: Record<string, Record<string, unknown>[]>): Promise<Record<string, number>> }
  engine: (moves: Record<string, string>) => Promise<unknown>
}): Promise<MoveReport> {
  const all = (q: string, ...p: unknown[]) => o.sql.exec(q, ...p).toArray() as Record<string, unknown>[]
  o.sql.exec('CREATE TABLE IF NOT EXISTS identity_moves (old TEXT PRIMARY KEY, new TEXT NOT NULL, email TEXT NOT NULL, at TEXT NOT NULL, counts TEXT NOT NULL)')
  // 1. Every old id this project knows, with its email where any record names it.
  const email = new Map<string, string>(), seen = new Set<string>()
  const note = (principal: unknown, mail: unknown) => {
    const p = String(principal ?? ''); if (!p.startsWith('user:')) return
    const id = p.slice(5); if (!id || isNew(id)) return
    seen.add(id)
    const m = String(mail ?? '').trim().toLowerCase(); if (m.includes('@') && !email.has(id)) email.set(id, m)
  }
  for (const r of all('SELECT old, email FROM identity_moves')) note(`user:${r.old}`, r.email)   // moved before: reported as such
  for (const r of all('SELECT principal, email FROM session_owners')) note(r.principal, r.email)
  for (const r of all("SELECT actor_id, actor_email FROM audit_log WHERE actor_kind = 'user'")) note(String(r.actor_id).startsWith('user:') ? r.actor_id : `user:${r.actor_id}`, r.actor_email)
  try { for (const r of all('SELECT id, email FROM graph_people')) note(String(r.id).startsWith('user:') ? r.id : `user:${r.id}`, r.email) } catch { /* no graph yet */ }
  for (const r of all('SELECT conn FROM person_links')) { try { const c = JSON.parse(String(r.conn)); note(`user:${c.userId}`, c.email) } catch { /* not a link */ } }
  for (const r of all("SELECT owner FROM programs WHERE owner LIKE 'user:%'")) note(r.owner, null)

  // 2–3. Per person (several old ids may be one person: the development and the production sign-in).
  const byEmail = new Map<string, string[]>()
  for (const [id, m] of email) byEmail.set(m, [...(byEmail.get(m) ?? []), id])
  const report: MoveReport = { dry: o.dry, people: [], unmatched: [...seen].filter((id) => !email.has(id)) }
  const moves: Record<string, string> = {}
  for (const [mail, olds] of byEmail) {
    const to = await personId(mail)
    const done = olds.every((id) => all('SELECT 1 FROM identity_moves WHERE old = ?', id).length)
    const sessions = olds.reduce((n, id) => n + all('SELECT 1 FROM session_owners WHERE principal = ?', `user:${id}`).length, 0)
    const programs = olds.reduce((n, id) => n + all('SELECT 1 FROM programs WHERE owner = ?', `user:${id}`).length, 0)
    const rows: Record<string, number> = {}
    for (const id of olds) {
      if (done) break
      const data = await o.home(`user:${id}`).exportRows([o.project], o.org)
      if (o.dry) { for (const [t, r] of Object.entries(data)) rows[t] = (rows[t] ?? 0) + r.length; continue }
      const took = await o.home(personHome(o.org, to)).importRows(data)
      for (const [t, n] of Object.entries(took)) rows[t] = (rows[t] ?? 0) + n
      o.sql.exec('UPDATE session_owners SET principal = ? WHERE principal = ?', `user:${to}`, `user:${id}`)
      o.sql.exec('UPDATE programs SET owner = ? WHERE owner = ?', `user:${to}`, `user:${id}`)
      o.sql.exec('INSERT OR REPLACE INTO identity_moves (old, new, email, at, counts) VALUES (?, ?, ?, ?, ?)', id, to, mail, new Date().toISOString(), JSON.stringify(Object.fromEntries(Object.entries(data).map(([t, r]) => [t, r.length]))))
    }
    for (const id of olds) moves[`user:${id}`] = `user:${to}`
    report.people.push({ email: mail, from: olds, to, sessions, programs, rows, ...(done ? { already: true } : {}) })
  }
  // 4. The engine's session logs (appended to, never rewritten) — every time, so a session the engine had then is moved.
  if (!o.dry && Object.keys(moves).length) report.engine = await o.engine(moves).catch((e) => ({ error: String(e?.message ?? e) }))
  return report
}
