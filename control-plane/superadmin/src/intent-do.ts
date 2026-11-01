// ── IntentDO — one intent node (docs/intent-graph.md) ───────────────────────────────────────────────────────────────
//
// Every node has a Durable Object of its own, `intent:<project>:<node id>`, independent of every other: any node can be
// reached from any node, so none sits inside another. It keeps:
//
//   node       the node (its intent, canonical form, agent, who may be answered here) — every version kept
//   variants   what is learnt about answering it, per person (user:<id>): concepts by name, the way, how it is shown,
//              its sub-paths — every version kept; a wrong one deprecated, never deleted
//   approvals  the project's way, approved from everyone's variants; with none, the most represented is used, unverified
//   edges      the ways out to the next intents, per person: asked, or suggested (with a check: an option function)
//   passages   every question answered here: the input, its values, the answer, who answered it
//
// The project's ProjectDO is the only caller (intents.ts); it keeps the index every node is found in.

import { DurableObject } from 'cloudflare:workers'
import { migrate as runMigrations, durableObjectDb } from '../../../vm/packages/migrate/src/index.js'
import { INTENT_MIGRATIONS } from './migrations.js'
import { checkIntentBody, checkVariantBody, currentGlobal, type IntentEdge, type IntentNode, type IntentNodeBody, type IntentPassage, type IntentVariant, type IntentVariantBody } from '../../../vm/packages/platform-types/src/intent.js'

/** How much of an answer a passage keeps: enough to read what was said, never the whole report. */
const ANSWER_KEPT = 4000

export function intentStub(env: any, project: string, node: string) {
  return env.INTENT.get(env.INTENT.idFromName(`intent:${project}:${node}`)) as unknown as IntentDO
}

export interface NodeRead {
  node: IntentNode
  /** Every owner's variants, the latest of each first (history after). */
  variants: IntentVariant[]
  approved: { owner: string; version: number; by: string; at: string } | null
  /** The project's view: the approved variant, else the most represented. */
  global: { variant: IntentVariant | null; verified: boolean; agreeing: number; kinds: number }
  edges: IntentEdge[]
  versions: { version: number; by: string; why: string; at: string }[]
  passages: IntentPassage[]
}

export class IntentDO extends DurableObject<Env> {
  private sql: SqlStorage
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.ctx.blockConcurrencyWhile(async () => { runMigrations(durableObjectDb(this.ctx.storage), INTENT_MIGRATIONS, { name: 'intent' }) })
  }

  private mark(key: string): string | null { return ([...this.sql.exec('SELECT value FROM marks WHERE key = ?', key)][0] as any)?.value ?? null }
  private setMark(key: string, value: string | null) { this.sql.exec('INSERT INTO marks (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value) }

  private current(): IntentNode | null {
    const r = [...this.sql.exec('SELECT * FROM node ORDER BY version DESC LIMIT 1')][0] as any
    if (!r) return null
    const first = [...this.sql.exec('SELECT by, at FROM node ORDER BY version LIMIT 1')][0] as any
    return { id: r.id, version: Number(r.version), ...JSON.parse(String(r.body)), stale: this.mark('stale'), by: first.by, at: first.at, passages: Number(this.mark('passages') ?? 0) }
  }

  /** The node written: made (version 1) or changed (the next version); every version kept. */
  async write(id: string, body: IntentNodeBody, by: string, why: string): Promise<IntentNode> {
    const bad = checkIntentBody(body); if (bad) throw new Error(bad)
    const was = this.current()
    if (was && was.id !== id) throw new Error(`this Durable Object holds ${was.id}, not ${id}`)
    const json = JSON.stringify({ title: body.title.trim(), intent: body.intent.trim(), asked: body.asked, canonical: body.canonical, params: body.params, agent: body.agent ?? null, needs: body.needs ?? null, ...(body.system ? { system: true } : {}) })
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO node (version, id, body, by, why, at) VALUES (?, ?, ?, ?, ?, ?)', (was?.version ?? 0) + 1, id, json, by, why, new Date().toISOString())
      if (was) this.setMark('stale', null)
    })
    return this.current()!
  }

  private variantsAll(): IntentVariant[] {
    return [...this.sql.exec('SELECT * FROM variants ORDER BY owner, version DESC')].map((r: any) => ({ owner: r.owner, version: Number(r.version), ...JSON.parse(String(r.body)), by: r.by, why: r.why, at: r.at, ...(r.deprecated ? { deprecated: true } : {}) }))
  }
  /** Each owner's latest variant that is not deprecated. */
  private latest(): IntentVariant[] {
    const seen = new Set<string>(), out: IntentVariant[] = []
    for (const v of this.variantsAll()) if (!v.deprecated && !seen.has(v.owner)) { seen.add(v.owner); out.push(v) }
    return out
  }
  private approvedNow() { const r = [...this.sql.exec('SELECT * FROM approvals ORDER BY seq DESC LIMIT 1')][0] as any; return r ? { owner: r.owner, version: Number(r.version), by: r.by, at: r.at } : null }

  /** The variant a person answers with: their own, else the project's (approved, else the most represented). */
  async variantFor(owner: string): Promise<{ variant: IntentVariant | null; whose: 'mine' | 'project' | null; verified: boolean }> {
    const own = this.latest().find((v) => v.owner === owner)
    if (own) return { variant: own, whose: 'mine', verified: false }
    const g = currentGlobal(this.latest(), this.approvedNow())
    return { variant: g.variant, whose: g.variant ? 'project' : null, verified: g.verified }
  }

  /** A person's variant written (its next version); unchanged from their latest, nothing is written. */
  async putVariant(owner: string, body: IntentVariantBody, by: string, why: string): Promise<{ variant: IntentVariant; changed: boolean }> {
    const bad = checkVariantBody(body); if (bad) throw new Error(bad)
    if (!/^user:\S+$/.test(owner)) throw new Error('a variant is a person\'s (user:<id>); the project\'s is approved from them')
    const json = JSON.stringify({ concepts: [...new Set(body.concepts.map((c) => c.trim()))], process: body.process.trim(), show: body.show.trim(), paths: body.paths, ...(body.about ? { about: body.about } : {}) })
    const was = [...this.sql.exec('SELECT version, body FROM variants WHERE owner = ? ORDER BY version DESC LIMIT 1', owner)][0] as any
    if (was && String(was.body) === json) return { variant: this.variantsAll().find((v) => v.owner === owner && v.version === Number(was.version))!, changed: false }
    const version = (Number(was?.version) || 0) + 1
    this.sql.exec('INSERT INTO variants (owner, version, body, by, why, at) VALUES (?, ?, ?, ?, ?, ?)', owner, version, json, by, why.slice(0, 500), new Date().toISOString())
    return { variant: this.variantsAll().find((v) => v.owner === owner && v.version === version)!, changed: true }
  }

  /** A variant kept but no longer used. */
  async deprecate(owner: string, version: number, by: string, why: string): Promise<void> {
    this.sql.exec('UPDATE variants SET deprecated = ? WHERE owner = ? AND version = ?', `${by}: ${why}`.slice(0, 300), owner, version)
  }

  /** One of everyone's variants approved as the project's way. */
  async approve(owner: string, version: number, by: string, why: string): Promise<void> {
    const v = this.variantsAll().find((x) => x.owner === owner && x.version === version)
    if (!v) throw new Error(`there is no variant ${owner} v${version} at this node`)
    if (v.deprecated) throw new Error('a deprecated variant is not approved')
    this.sql.exec('INSERT INTO approvals (owner, version, by, why, at) VALUES (?, ?, ?, ?, ?)', owner, version, by, why.slice(0, 500), new Date().toISOString())
  }

  async read(o: { passages?: number } = {}): Promise<NodeRead | null> {
    const node = this.current()
    if (!node) return null
    const latest = this.latest(), approved = this.approvedNow()
    const all = this.variantsAll()
    return {
      node,
      variants: [...latest, ...all.filter((v) => !latest.includes(v) && !latest.some((l) => l.owner === v.owner && l.version === v.version))],
      approved,
      global: currentGlobal(latest, approved),
      edges: this.edgesAll(),
      versions: [...this.sql.exec('SELECT version, by, why, at FROM node ORDER BY version DESC')].map((r: any) => ({ version: Number(r.version), by: r.by, why: r.why, at: r.at })),
      passages: [...this.sql.exec('SELECT * FROM passages ORDER BY seq DESC LIMIT ?', o.passages ?? 20)].map((r: any) => passage(node.id, r)),
    }
  }

  private edgesAll(): IntentEdge[] {
    const id = this.current()?.id ?? ''
    return [...this.sql.exec('SELECT * FROM edges ORDER BY count DESC, last_at DESC')].map((r: any) => ({ from: id, to: r.to_id, owner: r.owner, tag: r.tag, count: Number(r.count), label: r.label, check: r.check_src ?? null, last: r.last_at }))
  }
  async edges(): Promise<IntentEdge[]> { return this.edgesAll() }

  /** A question answered here: kept, counted. */
  async pass(p: IntentPassage): Promise<{ passages: number }> {
    const at = p.at || new Date().toISOString()
    let n = 0
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('INSERT INTO passages (session, block, question, params, answer, who, agent, at, how, from_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        p.session, p.block, p.question.slice(0, 2000), JSON.stringify(p.params ?? []), p.answer.slice(0, ANSWER_KEPT), p.who, p.agent, at, p.how, p.from)
      n = Number(this.mark('passages') ?? 0) + 1
      this.setMark('passages', String(n))
    })
    return { passages: n }
  }

  /** A way out to another node, for an owner: taken (counted), or offered (kept, with its check). */
  async edge(e: { to: string; owner: string; tag: 'asked' | 'suggested'; label: string; check?: string | null; taken?: boolean }): Promise<IntentEdge> {
    const at = new Date().toISOString()
    this.sql.exec(`INSERT INTO edges (to_id, owner, tag, count, label, check_src, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(to_id, owner, tag) DO UPDATE SET count = count + excluded.count, last_at = excluded.last_at,
        label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE label END, check_src = COALESCE(excluded.check_src, check_src)`,
      e.to, e.owner, e.tag, e.taken ? 1 : 0, e.label.slice(0, 200), e.check ?? null, at, at)
    return this.edgesAll().find((x) => x.to === e.to && x.owner === e.owner && x.tag === e.tag)!
  }

  /** Something a variant uses changed: marked, never changed — looked at again later. */
  async markStale(why: string): Promise<void> { this.setMark('stale', why.slice(0, 300)) }
}

const passage = (node: string, r: any): IntentPassage => ({ node, session: r.session, block: r.block ?? null, question: r.question, params: JSON.parse(String(r.params ?? '[]')), answer: r.answer, who: r.who, agent: r.agent, at: r.at, how: r.how, from: r.from_id ?? null })
