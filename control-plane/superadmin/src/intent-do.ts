// ── IntentDO — one cluster of a project's intent nodes (docs/intent-graph.md) ───────────────────────────────────────
//
// A node's id is `<cluster>-<unique>`; every node of a cluster lives in the one Durable Object named
// `intent:<project>:<cluster>`, so the nodes people move between (mostly within one area) are read together, and one node
// can still be given a Durable Object of its own later by giving it a cluster of its own. It keeps:
//
//   nodes          each node as it is now (its body: intent, links, agent, the agent's own keys) and whether stale
//   node_versions  every version of every node — a node is changed only by writing a new one; read as of any moment
//   edges          the ways out of a node (to any node, any cluster), per scope, as people took them, counted
//   passages       every question answered at a node (append-only): its memory, and the history of its answers
//
// The project's ProjectDO is the only caller (intent graph messages; it keeps the index every node is searched in).

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { INTENT_MIGRATIONS } from './migrations.js'
import { checkIntentBody, type IntentEdge, type IntentNode, type IntentNodeBody, type IntentPassage } from '../../../vm/packages/platform-types/src/intent.js'

/** How much of an answer a passage keeps: enough to read what was said, never the whole report. */
const ANSWER_KEPT = 4000

export function intentStub(env: any, project: string, cluster: string) {
  return env.INTENT.get(env.INTENT.idFromName(`intent:${project}:${cluster}`)) as unknown as IntentDO
}

export class IntentDO extends DurableObject<Env> {
  private sql: SqlStorage
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), INTENT_MIGRATIONS, { name: 'intent' }) })
  }

  private row(id: string): IntentNode | null {
    const r = [...this.sql.exec('SELECT * FROM nodes WHERE id = ?', id)][0] as any
    if (!r) return null
    return { id: r.id, cluster: id.split('-').slice(0, -1).join('-'), version: Number(r.version), ...JSON.parse(String(r.body)), stale: r.stale ?? null, by: r.by, at: r.at, passages: Number(r.passages) }
  }

  /** A node written: made (version 1) or changed (the next version); every version kept. */
  async write(id: string, body: IntentNodeBody, by: string, why: string): Promise<IntentNode> {
    const bad = checkIntentBody(body); if (bad) throw new Error(bad)
    const at = new Date().toISOString()
    const was = this.row(id)
    const version = (was?.version ?? 0) + 1
    const json = JSON.stringify({ title: body.title, intent: body.intent, links: body.links, agent: body.agent ?? null, ...(body.about ? { about: body.about } : {}) })
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO node_versions (id, version, body, by, why, at) VALUES (?, ?, ?, ?, ?, ?)', id, version, json, by, why, at)
      if (was) this.sql.exec('UPDATE nodes SET version = ?, body = ?, stale = NULL, at = ? WHERE id = ?', version, json, at, id)
      else this.sql.exec('INSERT INTO nodes (id, version, body, by, at) VALUES (?, ?, ?, ?, ?)', id, version, json, by, at)
    })
    return this.row(id)!
  }

  async nodes(ids?: string[]): Promise<IntentNode[]> {
    const all = ids ? ids.map((id) => this.row(id)).filter((n): n is IntentNode => !!n) : [...this.sql.exec('SELECT id FROM nodes ORDER BY at')].map((r: any) => this.row(String(r.id))!)
    return all
  }

  /** One node with its ways out, its versions and its latest passages. */
  async node(id: string, o: { passages?: number } = {}): Promise<{ node: IntentNode; edges: IntentEdge[]; versions: { version: number; by: string; why: string; at: string }[]; passages: IntentPassage[] } | null> {
    const node = this.row(id)
    if (!node) return null
    return {
      node,
      edges: this.edgesFrom([id]),
      versions: [...this.sql.exec('SELECT version, by, why, at FROM node_versions WHERE id = ? ORDER BY version DESC', id)].map((r: any) => ({ version: Number(r.version), by: r.by, why: r.why, at: r.at })),
      passages: [...this.sql.exec('SELECT * FROM passages WHERE node = ? ORDER BY seq DESC LIMIT ?', id, o.passages ?? 20)].map(passage),
    }
  }

  private edgesFrom(ids: string[]): IntentEdge[] {
    if (!ids.length) return []
    return [...this.sql.exec(`SELECT * FROM edges WHERE from_id IN (${ids.map(() => '?').join(',')}) ORDER BY count DESC`, ...ids)]
      .map((r: any) => ({ from: r.from_id, to: r.to_id, scope: r.scope, count: Number(r.count), how: r.how, last: r.last_at }))
  }

  /** The ways out of some of this cluster's nodes. */
  async edges(ids?: string[]): Promise<IntentEdge[]> {
    return ids ? this.edgesFrom(ids) : [...this.sql.exec('SELECT * FROM edges ORDER BY count DESC')].map((r: any) => ({ from: r.from_id, to: r.to_id, scope: r.scope, count: Number(r.count), how: r.how, last: r.last_at }))
  }

  /** A question answered at a node: kept, counted, and — when it came from another node — the way taken, counted. */
  async pass(p: IntentPassage): Promise<{ passages: number }> {
    const at = p.at || new Date().toISOString()
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO passages (node, session, block, question, answer, who, at, how, from_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        p.node, p.session, p.block, p.question.slice(0, 2000), p.answer.slice(0, ANSWER_KEPT), p.who, at, p.how, p.from)
      this.sql.exec('UPDATE nodes SET passages = passages + 1 WHERE id = ?', p.node)
    })
    return { passages: Number(([...this.sql.exec('SELECT passages FROM nodes WHERE id = ?', p.node)][0] as any)?.passages ?? 0) }
  }

  /** A way from one of this cluster's nodes to another, taken (or offered): counted per scope. */
  async edge(from: string, to: string, scope: string, how: 'used' | 'proposed' = 'used'): Promise<void> {
    const at = new Date().toISOString()
    this.sql.exec(`INSERT INTO edges (from_id, to_id, scope, how, count, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(from_id, to_id, scope) DO UPDATE SET count = count + 1, last_at = excluded.last_at, how = CASE WHEN excluded.how = 'used' THEN 'used' ELSE how END`, from, to, scope, how, at, at)
  }

  /** Nodes whose linked knowledge changed: marked, never changed — looked at again later. */
  async markStale(ids: string[], why: string): Promise<number> {
    let n = 0
    for (const id of ids) { this.sql.exec('UPDATE nodes SET stale = ? WHERE id = ?', why.slice(0, 300), id); n++ }
    return n
  }
}

const passage = (r: any): IntentPassage => ({ node: r.node, session: r.session, block: r.block ?? null, question: r.question, answer: r.answer, who: r.who, at: r.at, how: r.how, from: r.from_id ?? null })
