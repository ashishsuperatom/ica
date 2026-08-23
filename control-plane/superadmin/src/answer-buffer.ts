// Durable, per-user ANSWER BUFFER + recent-session snapshot for a project DO.
//
// Always-on delivery: a client that was offline when the answer landed (internet blip, machine asleep, app
// closed, a different device) PULLS it from the DO without waking the engine. Every row is tagged with
// user_id (from the runtime JWT) so it is user-scoped inside the shared project DO and ready to split into
// per-user DOs later. Bounded: pruned to newest KEEP per user / within TTL_MS.
//
// Separation of concerns: this module owns ONLY the storage logic + the payloads it returns. The DO owns
// transport (it calls these and ws.sends the returned payloads) and schema versioning (it calls the static
// migrate() from inside its own migration ladder). Keeping it here keeps the DO lean and the migration ladder
// readable as this grows.

// Minimal structural view of the DO's SQLite handle (ctx.storage.sql) — avoids depending on ambient types.
type Sql = { exec(query: string, ...bindings: any[]): Iterable<any> }

export class AnswerBuffer {
  static readonly KEEP = 20                          // newest answers kept per user
  static readonly TTL_MS = 7 * 24 * 60 * 60 * 1000   // …or within 7 days

  constructor(private sql: Sql, private log: (event: string, detail?: Record<string, unknown>) => void = () => {}) {}

  // Called ONCE from the DO's migration ladder (its own version gate decides when).
  static migrate(sql: Sql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS answer_buffer (
      qid TEXT PRIMARY KEY, user_id TEXT NOT NULL DEFAULT '', session_id TEXT, question TEXT,
      payload_json TEXT, followups_json TEXT,
      at INTEGER NOT NULL, answered_at INTEGER, acked INTEGER NOT NULL DEFAULT 0)`)
    sql.exec('CREATE INDEX IF NOT EXISTS idx_ab_user ON answer_buffer(user_id, at)')
    sql.exec(`CREATE TABLE IF NOT EXISTS session_snapshot (
      session_id TEXT NOT NULL, user_id TEXT NOT NULL DEFAULT '', title TEXT, last_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, user_id))`)
  }

  // A runtime asked a question → PENDING row (user-attributed even if its socket later dies) + bump the
  // recent-session snapshot. Filled in by recordAnswer when the engine replies.
  recordPending(userId: string, p: any) {
    const uid = userId || '', qid = String(p.questionId), sid = String(p.sessionId || ''), q = String(p.question || ''), now = Date.now()
    try {
      this.sql.exec('INSERT INTO answer_buffer (qid, user_id, session_id, question, at) VALUES (?,?,?,?,?) ON CONFLICT(qid) DO UPDATE SET question=excluded.question', qid, uid, sid, q, now)
      if (sid) this.sql.exec('INSERT INTO session_snapshot (session_id, user_id, title, last_at) VALUES (?,?,?,?) ON CONFLICT(session_id,user_id) DO UPDATE SET title=excluded.title, last_at=excluded.last_at', sid, uid, q.slice(0, 80), now)
      this.prune(uid)
    } catch (e) { this.log('buffer:pending_failed', { error: String(e) }) }
  }

  recordAnswer(p: any) { try { this.sql.exec('UPDATE answer_buffer SET payload_json=?, answered_at=?, acked=0 WHERE qid=?', JSON.stringify(p), Date.now(), String(p.qid)) } catch {} }
  recordFollowups(p: any) { try { this.sql.exec('UPDATE answer_buffer SET followups_json=? WHERE qid=?', JSON.stringify(p), String(p.qid)) } catch {} }

  // BOUNDED: drop rows past the TTL, and everything beyond the newest KEEP — per user.
  private prune(uid: string) {
    const cutoff = Date.now() - AnswerBuffer.TTL_MS
    try {
      this.sql.exec('DELETE FROM answer_buffer WHERE user_id=? AND at<?', uid, cutoff)
      this.sql.exec('DELETE FROM answer_buffer WHERE user_id=? AND qid NOT IN (SELECT qid FROM answer_buffer WHERE user_id=? ORDER BY at DESC LIMIT ?)', uid, uid, AnswerBuffer.KEEP)
      this.sql.exec('DELETE FROM session_snapshot WHERE user_id=? AND last_at<?', uid, cutoff)
    } catch {}
  }

  // Client (re)connect / app-open → recent sessions + answered-but-UNACKED answers for this user.
  sync(userId: string) {
    const uid = userId || ''
    const sessions = [...this.sql.exec('SELECT session_id, title, last_at FROM session_snapshot WHERE user_id=? ORDER BY last_at DESC LIMIT 50', uid)]
      .map((r: any) => ({ sessionId: r.session_id, title: r.title, lastAt: r.last_at }))
    const answers = [...this.sql.exec('SELECT qid, session_id, question, payload_json, followups_json FROM answer_buffer WHERE user_id=? AND payload_json IS NOT NULL AND acked=0 ORDER BY at DESC LIMIT ?', uid, AnswerBuffer.KEEP)]
      .map((r: any) => ({ qid: r.qid, sessionId: r.session_id, question: r.question, answer: JSON.parse(r.payload_json), followups: r.followups_json ? JSON.parse(r.followups_json) : null }))
    return { t: 'sync:res', sessions, answers }
  }

  // ONE answer by qid (served from the DO — engine stays asleep).
  get(userId: string, qid: string) {
    const q = String(qid || '')
    const [r] = this.sql.exec('SELECT question, payload_json, followups_json FROM answer_buffer WHERE qid=? AND user_id=?', q, userId || '')
    const rr = r as any
    if (!rr) return { t: 'answer:res', qid: q, status: 'none' as const }
    if (!rr.payload_json) return { t: 'answer:res', qid: q, status: 'pending' as const, question: rr.question }
    return { t: 'answer:res', qid: q, status: 'ready' as const, question: rr.question, answer: JSON.parse(rr.payload_json), followups: rr.followups_json ? JSON.parse(rr.followups_json) : null }
  }

  ack(userId: string, qids: unknown) {
    for (const q of (Array.isArray(qids) ? qids : [])) { try { this.sql.exec('UPDATE answer_buffer SET acked=1 WHERE qid=? AND user_id=?', String(q), userId || '') } catch {} }
  }
}
