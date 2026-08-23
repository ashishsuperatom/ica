// One-time login-code store for the mobile device flow. Lives in the GlobalDO (a strongly-consistent SQLite
// singleton) on purpose: a code is written in one request and claimed seconds later, possibly from a different
// colo — KV's eventual consistency would lose that race and fail logins unpredictably. Touched only twice per
// login (put + claim), never on the message hot path.
//
// Security: single-use (deleted on successful claim) + short TTL + PKCE-bound. A code intercepted from the
// `superatom://` redirect is worthless without the matching verifier. Storage logic only; the GlobalDO wires
// it, exactly like AnswerBuffer.

import { sha256Base64Url } from './tokens.js'

type Sql = { exec(query: string, ...bindings: any[]): Iterable<any> }

export interface LoginCode { code: string; token: string; userId: string; role: string; codeChallenge: string; expiresAt: number }

export class LoginCodeStore {
  constructor(private sql: Sql) {}

  static migrate(sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS mobile_login_code (
      code TEXT PRIMARY KEY, token TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
      code_challenge TEXT NOT NULL, expires_at INTEGER NOT NULL)`)
  }

  private sweep() { try { this.sql.exec('DELETE FROM mobile_login_code WHERE expires_at < ?', Date.now()) } catch {} }

  put(c: LoginCode) {
    this.sweep()
    this.sql.exec('INSERT OR REPLACE INTO mobile_login_code (code, token, user_id, role, code_challenge, expires_at) VALUES (?,?,?,?,?,?)',
      c.code, c.token, c.userId, c.role, c.codeChallenge, c.expiresAt)
  }

  // Claim: verify PKCE, single-use (delete on success). Returns null for missing / expired / wrong-verifier —
  // the caller maps ALL three to an identical 401 so the endpoint can't be probed. A WRONG verifier does NOT
  // delete the row, so a thief holding only the code can't DoS the legitimate login before it redeems.
  async claim(code: string, verifier: string): Promise<{ token: string; userId: string; role: string } | null> {
    this.sweep()
    if (!code || !verifier) return null
    const [r] = this.sql.exec('SELECT token, user_id, role, code_challenge, expires_at FROM mobile_login_code WHERE code = ?', code)
    const rr = r as any
    if (!rr || rr.expires_at < Date.now()) return null
    if (await sha256Base64Url(verifier) !== rr.code_challenge) return null
    this.sql.exec('DELETE FROM mobile_login_code WHERE code = ?', code)   // single-use
    return { token: rr.token, userId: rr.user_id, role: rr.role }
  }
}
