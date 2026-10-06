// ── A person's sessions, as the platform keeps them — in their own Durable Object ───────────────────────────────────
//
// The platform's copy of a session is the truth; the engine's file is a replica pushed here. A session's log is its
// entries in order (vm/packages/session core: open, block, state, answer, intent, current), each with its sequence number,
// by project and session. An append says where it starts: entries already here are checked (the same entry twice is
// harmless; a different one is a conflict, refused), entries past a gap are refused with where the log ends, so the
// engine resends from there. Reading replays the entries — the same code the engine writes them with — as of any moment.
// Artifacts (what a session's work produced and decided) keep every version. Tables: session_entries, session_artifacts,
// and the index in sessions (UserDO migrations 1 and 3).

import { replay, type Entry } from '../../../vm/packages/session/src/core.js'
import { createRecorder } from './records.js'
import { stepOf, takenOf, scopeOfUser } from '../../../vm/packages/decision/src/index.js'

export class SessionConflict extends Error { constructor(public seq: number) { super(`entry ${seq} differs from the one already kept`) } }

/** A session's title, for lists: its first answer's first line, or its agent. */
function titleOf(v: NonNullable<ReturnType<typeof replay>>): string {
  const first = v.answers[0]?.markdown.split('\n').find((l) => l.trim() && !l.trim().startsWith(':::'))
  return (first ?? v.agent).slice(0, 120)
}

export function sessionStore(storage: DurableObjectStorage, env: unknown) {
  const sql = storage.sql
  const count = (project: string, session: string) => Number([...sql.exec('SELECT COUNT(*) AS n FROM session_entries WHERE project = ? AND session = ?', project, session)][0]?.n ?? 0)
  const entries = (project: string, session: string): Entry[] => [...sql.exec('SELECT entry FROM session_entries WHERE project = ? AND session = ? ORDER BY seq', project, session)].map((r) => JSON.parse(String(r.entry)))
  const artifactRow = (r: any) => ({ id: r.id, version: Number(r.version), kind: r.kind, title: r.title, status: r.status, block: r.block ?? null, body: JSON.parse(String(r.body)), by: r.by, at: r.at, note: r.note ?? null })
  return {
    count,
    async append(project: string, session: string, from: number, fresh: Entry[]): Promise<{ upto: number; added?: number; gap?: true; conflict?: number; error?: string }> {
      const n = count(project, session)
      if (from > n) return { upto: n, gap: true }   // resend from where the log ends
      let added = 0
      try { storage.transactionSync(() => {
        fresh.forEach((e, i) => {
          const seq = from + i
          const text = JSON.stringify(e)
          if (seq < n) {
            const [have] = [...sql.exec('SELECT entry FROM session_entries WHERE project = ? AND session = ? AND seq = ?', project, session, seq)]
            if (have && String(have.entry) !== text) throw new SessionConflict(seq)
            return
          }
          sql.exec('INSERT INTO session_entries (project, session, seq, entry, at) VALUES (?, ?, ?, ?, ?)', project, session, seq, text, (e as any).at ?? new Date().toISOString())
          createRecorder((env as any).RECORDS, () => project)('session.entry', `${session}:${seq}`, { session, seq, entry: e }, (e as any).at)
          added++
        })
      }) } catch (e) { if (e instanceof SessionConflict) return { upto: n, conflict: e.seq, error: e.message }; throw e }
      const all = entries(project, session)
      // Each intent that arrived is a passage through a step: what the step was (cues, world) and the path taken from it,
      // for the project's decision memory. Recorded there; a failure never refuses the append.
      if (added && (env as any).DECISION) {
        const arrived = all.slice(all.length - added)
        for (let k = 0; k < arrived.length; k++) {
          const e = arrived[k]
          if (e.t !== 'intent') continue
          const before = replay(all.slice(0, all.length - added + k))
          if (!before) continue
          const block = e.intent.block ?? before.leaf
          const step = stepOf(before as any, block)
          if (!step) continue
          const stub = (env as any).DECISION.get((env as any).DECISION.idFromName(`dec:${project}`))
          await stub.fetch('http://do/experience', { method: 'POST', headers: { 'x-sa-project': project }, body: JSON.stringify({
            session, block, agent: before.agent, scope: scopeOfUser(before.user), ...step, taken: takenOf(e.intent as any) }) })
            .catch((err: any) => console.warn(`[session] experience for ${session}/${block} not recorded: ${err?.message ?? err}`))
        }
      }
      // The person's index of their sessions: what each is about and when it last changed.
      const v = replay(all)
      if (v) sql.exec(`INSERT INTO sessions (project, session, agent, title, blocks, answers, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (project, session) DO UPDATE SET agent = excluded.agent, title = excluded.title, blocks = excluded.blocks, answers = excluded.answers, updated = excluded.updated`,
        project, session, v.agent ?? '', titleOf(v), v.blocks.length, v.answers.length, v.created ?? v.updated, v.updated)
      return { upto: count(project, session), added }
    },
    view(project: string, session: string, asOf?: string) {
      const v = replay(entries(project, session), asOf)
      return v ? { view: v, upto: count(project, session) } : null
    },
    /** A new version of an artifact (or a new one): every version kept. */
    recordArtifact(project: string, session: string, b: any) {
      const prev = b.id ? [...sql.exec('SELECT * FROM session_artifacts WHERE project = ? AND session = ? AND id = ? ORDER BY version DESC LIMIT 1', project, session, String(b.id))][0] as any : null
      if (b.id && !prev) throw new Error(`there is no artifact ${b.id}`)
      const id = prev ? String(prev.id) : `art_${crypto.randomUUID()}`
      const version = prev ? Number(prev.version) + 1 : 1
      const at = new Date().toISOString()
      const row = { id, version, kind: prev ? String(prev.kind) : String(b.kind), title: String(b.title), status: String(b.status), block: b.block ?? prev?.block ?? null, body: b.body, by: String(b.by), at, note: b.note ?? null }
      sql.exec('INSERT INTO session_artifacts (project, session, id, version, kind, title, status, block, body, by, at, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', project, session, row.id, row.version, row.kind, row.title, row.status, row.block, JSON.stringify(row.body), row.by, row.at, row.note)
      createRecorder((env as any).RECORDS, () => project)('session.artifact', `${session}:${id}:${version}`, { session, ...row }, at)
      return row
    },
    /** Each artifact as its latest version, in the order they were made. */
    artifacts(project: string, session: string) {
      return ([...sql.exec(`SELECT a.* FROM session_artifacts a JOIN (SELECT id, MAX(version) AS m FROM session_artifacts WHERE project = ? AND session = ? GROUP BY id) x ON x.id = a.id AND x.m = a.version
        WHERE a.project = ? AND a.session = ? ORDER BY a.at`, project, session, project, session)] as any[]).map(artifactRow)
    },
    artifactVersions(project: string, session: string, id: string) {
      return ([...sql.exec('SELECT * FROM session_artifacts WHERE project = ? AND session = ? AND id = ? ORDER BY version', project, session, id)] as any[]).map(artifactRow)
    },
  }
}
