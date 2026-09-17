// ── THE INTENT SIDE: WHAT IS BEING DECIDED, AND WHAT HAPPENED WHEN WE TRIED ──────────────────────────────────
//
// Two graphs live here, beside the semantic graph and never inside it, because they are not the same kind of
// thing and they fail differently. The semantic graph denotes COMPUTATIONS: its nodes are sets, its arrows are
// functions, and a question in it compiles to SQL. Neither graph here denotes a computation, and neither one ever
// produces a number.
//
//   THE INTENT GRAPH denotes REQUIREMENTS ON COMPUTATIONS — what an answer must carry to count as an answer to
//   this intent: what it is judged by, what it is judged against, what size of difference is worth acting on,
//   what must be shown, what must be said. It is computed with in exactly two ways: MATCHED, to find a way of
//   answering that is already settled, and CHECKED, to say whether an answer serves the intent. Wrong here gives
//   a correct but unhelpful answer.
//
//   THE APPROACH GRAPH holds what happened when we tried: obstacles met, cautions earned. Its entries point at a
//   node of the semantic graph OR at raw data the semantic graph does not model yet, which is exactly why it
//   cannot live in either of the others. Wrong here costs time, not correctness.
//
// IDENTITY IS DIFFERENT HERE, and this is the part that decides whether any of it can be corrected later. In the
// semantic graph identity is CONTENT: a definition is stored by its hash, and a changed definition is a different
// thing, so everything built on the old one stops matching. That is right for truth. On this side identity is
// CONTINUITY: a situation whose wording is tidied is the SAME situation, and if its identity were its content
// every rephrasing would orphan the things referring to it and nothing could ever settle. So a node here keeps a
// stable id and versions its text.
//
// NOTHING IS EVER DELETED. Two nodes found to be one situation are merged by REDIRECT — the old id resolves to
// the new one and both are kept — so references never break and a merge can be walked back. Every change is a
// row: a suggestion is a row that has not been applied, a consolidation is a row naming what it reconciled.
//
// REFERENCE, NEVER COPY. An intent points at a measure or a setting of the semantic graph; it never restates one.
// A reference is checked when it is written, so a graph-2 node cannot quietly hold a measure that does not exist.

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** A reference into the semantic graph, written so a reader can see which side it points at. */
export type Ref = string   // "g1:<Object>" · "g1:<Object>.<measure>" · "g1:setting:<name>" · "g1:condition:<name>" · "raw:<source>.<field>"

export type IntentKind =
  | 'intent'        // a decision someone is making
  | 'requirement'   // what an answer must carry to serve that decision
  | 'state'         // the situation it is being decided in — free-form, canonical on write
  | 'preference'    // how it should be shown

export interface IntentNode {
  id: string
  kind: IntentKind
  label: string
  /** What this node says, in its own terms. Versioned text: the id outlives the wording. */
  body: Record<string, unknown>
  /** Who it holds for. The same layering the graph already uses for values. */
  level: 'caller' | 'asker' | 'organisation' | 'default'
  owner?: string
  /** How often it has been leaned on, and when last. A node used often deepens; a node used once stays provisional. */
  seen: number
  lastAt: number
  /** Set when this node has been merged into another: it resolves there, and both are kept. */
  redirect?: string
}

export interface ApproachNode {
  id: string
  kind: 'caution' | 'obstacle' | 'path'
  label: string
  /** What it is about — a node of the semantic graph, or raw data that graph does not hold. */
  about: Ref
  body: Record<string, unknown>
  seen: number
  lastAt: number
}

export const intentFile = (dbDir: string) => join(dbDir, 'intent-graph.sqlite')

export class IntentStore {
  private db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS i_node (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, body TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'organisation', owner TEXT, seen INTEGER NOT NULL DEFAULT 1,
        last_at INTEGER NOT NULL, redirect TEXT);
      CREATE TABLE IF NOT EXISTS i_edge (
        src TEXT NOT NULL, role TEXT NOT NULL, dst TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (src, role, dst));
      CREATE TABLE IF NOT EXISTS a_node (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, about TEXT NOT NULL,
        body TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 1, last_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS i_change (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, by TEXT NOT NULL, op TEXT NOT NULL,
        target TEXT, args TEXT NOT NULL, reason TEXT, applied INTEGER NOT NULL, reconciles TEXT);
      -- EVERY QUESTION ASKED, with how it was read and what was in force. A question carries an intent whether or
      -- not we notice; kept, it is what tells us later which readings recur, which states mattered, and whether
      -- the intent graph is settling. Thrown away, every question is the first one.
      CREATE TABLE IF NOT EXISTS i_asked (
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, session TEXT NOT NULL, asked TEXT NOT NULL,
        who TEXT, agent TEXT, intent TEXT, matched_how TEXT, state TEXT NOT NULL, call TEXT);
      -- Which states a session is in: references into i_node, never text. The slice IS the state.
      CREATE TABLE IF NOT EXISTS i_session_state (
        session TEXT NOT NULL, node TEXT NOT NULL, at INTEGER NOT NULL, dropped_at INTEGER,
        PRIMARY KEY (session, node));
    `)
  }

  close() { this.db.close() }

  /** Follow a redirect to the node a merged id now resolves to. */
  resolve(id: string): string {
    const seen = new Set<string>()
    let at = id
    for (;;) {
      if (seen.has(at)) return at
      seen.add(at)
      const row = this.db.prepare('SELECT redirect FROM i_node WHERE id = ?').get(at) as { redirect?: string } | undefined
      if (!row?.redirect) return at
      at = row.redirect
    }
  }

  node(id: string): IntentNode | null {
    const r = this.db.prepare('SELECT * FROM i_node WHERE id = ?').get(this.resolve(id)) as any
    return r ? { id: r.id, kind: r.kind, label: r.label, body: JSON.parse(r.body), level: r.level, owner: r.owner ?? undefined, seen: r.seen, lastAt: r.last_at, redirect: r.redirect ?? undefined } : null
  }

  /** What this node points at, and what points at it — the graph, as a reader walks it. */
  edges(id: string): { out: Array<{ role: string; dst: string }>; in: Array<{ role: string; src: string }> } {
    const at = this.resolve(id)
    return {
      out: (this.db.prepare('SELECT role, dst FROM i_edge WHERE src = ? ORDER BY role').all(at) as any[]).map((r) => ({ role: r.role, dst: r.dst })),
      in: (this.db.prepare('SELECT role, src FROM i_edge WHERE dst = ? ORDER BY role').all(at) as any[]).map((r) => ({ role: r.role, src: r.src })),
    }
  }

  /** A node written, or an existing one leaned on again. `known` decides what counts as the same thing. */
  put(n: Omit<IntentNode, 'id' | 'seen' | 'lastAt'> & { id?: string }, by: string, reason?: string): IntentNode {
    const now = Date.now()
    const same = n.id ? this.node(n.id) : this.same(n.kind, n.label, n.level, n.owner)
    if (same) {
      // Leaning on it again deepens it; the wording may be tidied without the id moving.
      this.db.prepare('UPDATE i_node SET seen = seen + 1, last_at = ?, label = ?, body = ? WHERE id = ?')
        .run(now, n.label, JSON.stringify(n.body), same.id)
      this.record(by, 'seen', same.id, { label: n.label }, reason, 1)
      return this.node(same.id)!
    }
    const id = n.id ?? `${n.kind}:${randomUUID().slice(0, 8)}`
    this.db.prepare('INSERT INTO i_node (id, kind, label, body, level, owner, seen, last_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
      .run(id, n.kind, n.label, JSON.stringify(n.body), n.level, n.owner ?? null, now)
    this.record(by, 'add-node', id, { kind: n.kind, label: n.label, level: n.level, owner: n.owner }, reason, 1)
    return this.node(id)!
  }

  /** THE BASIN. A state said in different words is the same state, or the graph never settles: matching has to be
   *  generous, and it is done on the words, at the same level, for the same owner. */
  same(kind: IntentKind, label: string, level: IntentNode['level'], owner?: string): IntentNode | null {
    const rows = this.db.prepare('SELECT * FROM i_node WHERE kind = ? AND level = ? AND (owner IS ? OR owner = ?) AND redirect IS NULL').all(kind, level, owner ?? null, owner ?? '') as any[]
    const words = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 2))
    const mine = words(label)
    let best: { row: any; share: number } | null = null
    for (const r of rows) {
      const theirs = words(r.label)
      const shared = [...mine].filter((w) => theirs.has(w)).length
      const share = shared / Math.max(1, Math.min(mine.size, theirs.size))
      if (share >= 0.6 && (!best || share > best.share)) best = { row: r, share }
    }
    return best ? this.node(best.row.id) : null
  }

  /** An edge, with its far end checked: a reference into the semantic graph must be one the checker accepted. */
  link(src: string, role: string, dst: string, by: string, ok: (ref: Ref) => string | null): void {
    if (dst.startsWith('g1:') || dst.startsWith('raw:')) {
      const why = ok(dst)
      if (why) throw new Error(`${src} -[${role}]-> ${dst}: ${why}`)
    } else if (!this.node(dst)) throw new Error(`${src} -[${role}]-> ${dst}: there is no such node on this side`)
    this.db.prepare('INSERT OR REPLACE INTO i_edge (src, role, dst, at) VALUES (?, ?, ?, ?)').run(this.resolve(src), role, dst, Date.now())
    this.record(by, 'link', src, { role, dst }, undefined, 1)
  }

  /** Two nodes are one situation: the old resolves to the new, both kept, and the merge is itself a step. */
  merge(from: string, into: string, by: string, reason: string): void {
    const a = this.node(from), b = this.node(into)
    if (!a || !b) throw new Error('both nodes must exist to be merged')
    this.db.prepare('UPDATE i_node SET redirect = ?, last_at = ? WHERE id = ?').run(b.id, Date.now(), a.id)
    this.db.prepare('UPDATE i_node SET seen = seen + ? WHERE id = ?').run(a.seen, b.id)
    this.record(by, 'merge', a.id, { into: b.id }, reason, 1, [a.id, b.id])
  }

  /** What is in force for a conversation: references, never text. Pushed, dropped, and read back as a slice. */
  pushState(session: string, node: string, by: string): void {
    const id = this.resolve(node)
    if (!this.node(id)) throw new Error(`there is no state ${node}`)
    this.db.prepare('INSERT OR REPLACE INTO i_session_state (session, node, at, dropped_at) VALUES (?, ?, ?, NULL)').run(session, id, Date.now())
    this.record(by, 'push-state', id, { session }, undefined, 1)
  }

  dropState(session: string, node: string, by: string): void {
    this.db.prepare('UPDATE i_session_state SET dropped_at = ? WHERE session = ? AND node = ?').run(Date.now(), session, this.resolve(node))
    this.record(by, 'drop-state', this.resolve(node), { session }, undefined, 1)
  }

  state(session: string): IntentNode[] {
    const rows = this.db.prepare('SELECT node FROM i_session_state WHERE session = ? AND dropped_at IS NULL ORDER BY at').all(session) as any[]
    return rows.map((r) => this.node(r.node)).filter((x): x is IntentNode => !!x)
  }

  /** A question, as it arrived, with what it was read as and what was in force — kept whether or not anything
   *  matched, because a question nothing matched is the most useful one to come back to. */
  asked(x: { session: string; asked: string; who?: string; agent?: string; intent?: string; how?: string; call?: string }): number {
    const state = this.state(x.session).map((s) => s.id)
    const r = this.db.prepare('INSERT INTO i_asked (at, session, asked, who, agent, intent, matched_how, state, call) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), x.session, x.asked, x.who ?? null, x.agent ?? null, x.intent ?? null, x.how ?? null, JSON.stringify(state), x.call ?? null)
    return Number(r.lastInsertRowid)
  }

  /** What has been asked, newest first — and, for each, whether anything was already settled for it. */
  asks(limit = 50): Array<{ id: number; at: number; asked: string; who?: string; intent?: string; how?: string; state: string[] }> {
    return (this.db.prepare('SELECT * FROM i_asked ORDER BY id DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ id: r.id, at: r.at, asked: r.asked, who: r.who ?? undefined, intent: r.intent ?? undefined, how: r.matched_how ?? undefined, state: JSON.parse(r.state) }))
  }

  /** Is this settling? What share of questions reached something already there, and how many states are new.
   *  Asked of the history rather than assumed — the curve is the only honest evidence of an attractor. */
  settling(): { asked: number; matched: number; share: number; states: number; statesUsed: number } {
    const asked = (this.db.prepare('SELECT COUNT(*) n FROM i_asked').get() as any).n as number
    const matched = (this.db.prepare('SELECT COUNT(*) n FROM i_asked WHERE intent IS NOT NULL').get() as any).n as number
    const states = (this.db.prepare("SELECT COUNT(*) n FROM i_node WHERE kind = 'state' AND redirect IS NULL").get() as any).n as number
    const statesUsed = (this.db.prepare("SELECT COUNT(DISTINCT node) n FROM i_session_state").get() as any).n as number
    return { asked, matched, share: asked ? matched / asked : 0, states, statesUsed }
  }

  /** Every intent this graph holds, for when nothing matched: at the frontier the words are no use, and whoever
   *  understands the sentence should see what there is and judge. This graph is small on purpose. */
  all(): IntentNode[] {
    return (this.db.prepare("SELECT id FROM i_node WHERE kind = 'intent' AND redirect IS NULL ORDER BY seen DESC").all() as any[])
      .map((r) => this.node(r.id)).filter((x): x is IntentNode => !!x)
  }

  /** The intents whose words the question's words reach, deepest first — matching, the first of the two ways this
   *  graph is computed with. Nothing here evaluates: it finds. A thin result is not an answer, it is the frontier. */
  intentsFor(text: string, who?: { owner?: string }): Array<{ intent: IntentNode; requirements: Array<{ role: string; node: IntentNode | null; ref?: Ref }>; share: number }> {
    const words = new Set(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length > 2))
    const out: Array<{ intent: IntentNode; requirements: Array<{ role: string; node: IntentNode | null; ref?: Ref }>; share: number }> = []
    for (const r of this.db.prepare("SELECT * FROM i_node WHERE kind = 'intent' AND redirect IS NULL").all() as any[]) {
      const body = JSON.parse(r.body)
      const hay = new Set([...String(r.label).toLowerCase().split(/[^\p{L}\p{N}]+/u), ...String(body.about ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u),
        ...((body.said ?? []) as string[]).flatMap((s) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u))].filter((w) => w.length > 2))
      const shared = [...words].filter((w) => hay.has(w)).length
      if (!shared) continue
      // A person's own intent outranks the organisation's when both fit: the most specific layer wins, as values do.
      const bias = r.level === 'caller' || (r.owner && r.owner === who?.owner) ? 0.25 : 0
      out.push({
        intent: this.node(r.id)!, share: shared / Math.max(1, words.size) + bias,
        requirements: this.edges(r.id).out.map((e) => ({ role: e.role, node: e.dst.startsWith('g1:') || e.dst.startsWith('raw:') ? null : this.node(e.dst), ...(e.dst.startsWith('g1:') || e.dst.startsWith('raw:') ? { ref: e.dst } : {}) })),
      })
    }
    return out.sort((a, b) => b.share - a.share || b.intent.seen - a.intent.seen)
  }

  /** A requirement stands on the states it was written because of. When none of those is in force, it is not a
   *  requirement here — it is what this conversation would need in some other situation. This is the dependency
   *  set at the level of what is required, and it is what lets a change of situation change the answer without
   *  anything being rewritten. */
  requiredHere(requirement: string, session: string): { required: boolean; because: string[]; absent: string[] } {
    const because = this.edges(requirement).out.filter((e) => e.role === 'because').map((e) => this.resolve(e.dst))
    if (!because.length) return { required: true, because, absent: [] }
    const inForce = new Set(this.state(session).map((s) => s.id))
    const absent = because.filter((b) => !inForce.has(b))
    return { required: absent.length < because.length, because, absent }
  }

  /** What to watch for around a node — the approach graph, consulted before exploring the same ground again. */
  cautions(about?: Ref): ApproachNode[] {
    const rows = about
      ? this.db.prepare('SELECT * FROM a_node WHERE about = ? OR about LIKE ? ORDER BY seen DESC').all(about, `${about}.%`) as any[]
      : this.db.prepare('SELECT * FROM a_node ORDER BY seen DESC, last_at DESC').all() as any[]
    return rows.map((r) => ({ id: r.id, kind: r.kind, label: r.label, about: r.about, body: JSON.parse(r.body), seen: r.seen, lastAt: r.last_at }))
  }

  learn(n: Omit<ApproachNode, 'id' | 'seen' | 'lastAt'>, by: string): ApproachNode {
    const now = Date.now()
    const same = this.db.prepare('SELECT id FROM a_node WHERE kind = ? AND about = ? AND label = ?').get(n.kind, n.about, n.label) as any
    if (same) {
      this.db.prepare('UPDATE a_node SET seen = seen + 1, last_at = ? WHERE id = ?').run(now, same.id)
      return this.cautions(n.about).find((x) => x.id === same.id)!
    }
    const id = `${n.kind}:${randomUUID().slice(0, 8)}`
    this.db.prepare('INSERT INTO a_node (id, kind, label, about, body, seen, last_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(id, n.kind, n.label, n.about, JSON.stringify(n.body), now)
    this.record(by, 'learn', id, { kind: n.kind, about: n.about, label: n.label }, undefined, 1)
    return this.cautions(n.about).find((x) => x.id === id)!
  }

  /** A SUGGESTION IS A ROW THAT HAS NOT BEEN APPLIED. Nothing an agent works out changes either graph by itself. */
  propose(by: string, op: string, target: string | null, args: Record<string, unknown>, reason: string): number {
    return this.record(by, op, target, args, reason, 0)
  }

  proposals(): Array<{ id: number; at: number; by: string; op: string; target: string | null; args: unknown; reason?: string }> {
    return (this.db.prepare('SELECT * FROM i_change WHERE applied = 0 ORDER BY id DESC').all() as any[])
      .map((r) => ({ id: r.id, at: r.at, by: r.by, op: r.op, target: r.target, args: JSON.parse(r.args), reason: r.reason ?? undefined }))
  }

  history(limit = 50): Array<{ id: number; at: number; by: string; op: string; target: string | null; applied: boolean; reason?: string }> {
    return (this.db.prepare('SELECT * FROM i_change ORDER BY id DESC LIMIT ?').all(limit) as any[])
      .map((r) => ({ id: r.id, at: r.at, by: r.by, op: r.op, target: r.target, applied: !!r.applied, reason: r.reason ?? undefined }))
  }

  private record(by: string, op: string, target: string | null, args: Record<string, unknown>, reason: string | undefined, applied: number, reconciles?: string[]): number {
    const r = this.db.prepare('INSERT INTO i_change (at, by, op, target, args, reason, applied, reconciles) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), by, op, target, JSON.stringify(args), reason ?? null, applied, reconciles ? JSON.stringify(reconciles) : null)
    return Number(r.lastInsertRowid)
  }
}
