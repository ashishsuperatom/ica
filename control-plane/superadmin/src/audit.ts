// ── The audit history, as the project's Durable Object records it ────────────────────────────────────────────────────
//
// Every action that passes through the project — a question, an intent, a change made in the admin console, an agent
// connecting or being refused — is one AuditEvent (vm/packages/platform-types). It is written here first, append-only,
// in the DO's SQLite (immediate, and kept if the stream fails), then sent to the platform's audit stream (Basin
// Pipelines → an Iceberg table, read with Basin SQL) and counted in Analytics Engine, when those are bound.

import { AsyncLocalStorage } from 'node:async_hooks'
import type { AuditEvent } from '../../../vm/packages/platform-types/src/index.js'
import { checkAuditEvent } from '../../../vm/packages/platform-types/src/index.js'

export interface AuditSinks {
  /** Basin Pipelines stream binding: `send(records)`. */
  stream?: { send(records: unknown[]): Promise<void> }
  /** Analytics Engine dataset binding. */
  metrics?: { writeDataPoint(p: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void }
  /** Somewhere to say a send failed (the event is already kept here). */
  warn?: (msg: string) => void
}

type Sql = { exec(q: string, ...p: unknown[]): Iterable<Record<string, unknown>> }

/** The request being handled, so the DO's one gate knows whether a handler already recorded what the call meant. */
export const auditScope = new AsyncLocalStorage<{ recorded: boolean }>()

export class AuditLog {
  constructor(private sql: Sql, private project: () => string, private sinks: AuditSinks = {}) {}

  /** Record one event. Returns it as kept, or throws if it is malformed (a bug in the caller, never silently dropped). */
  record(e: Omit<AuditEvent, 'id' | 'at' | 'project'> & { at?: string; id?: string }): AuditEvent {
    const event: AuditEvent = { id: e.id ?? crypto.randomUUID(), at: e.at ?? new Date().toISOString(), project: this.project(), actor: e.actor, via: e.via, action: e.action, ...(e.target ? { target: e.target } : {}), outcome: e.outcome, ...(e.detail ? { detail: e.detail } : {}) }
    const bad = checkAuditEvent(event)
    if (bad.length) throw new Error(`audit event refused: ${bad.join('; ')}`)
    const scope = auditScope.getStore()
    if (scope) scope.recorded = true
    this.sql.exec('INSERT OR IGNORE INTO audit_log (id, at, actor_kind, actor_id, actor_email, via, action, target, outcome, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      event.id, event.at, event.actor.kind, event.actor.id, event.actor.email ?? null, event.via, event.action, event.target ?? null, event.outcome, event.detail ? JSON.stringify(event.detail) : null)
    const row = { ...event, actor_kind: event.actor.kind, actor_id: event.actor.id, actor_email: event.actor.email ?? null, detail: event.detail ? JSON.stringify(event.detail) : null }
    if (this.sinks.stream) this.sinks.stream.send([row]).catch((err) => this.sinks.warn?.(`audit stream send failed for ${event.id}: ${err?.message ?? err}`))
    try { this.sinks.metrics?.writeDataPoint({ indexes: [event.project], blobs: [event.action, event.outcome, event.via, event.actor.kind], doubles: [1] }) } catch { /* metrics are best effort */ }
    return event
  }

  /** The newest events first, filtered; `before` pages back by time. */
  list(q: { limit?: number; before?: string; actor?: string; action?: string } = {}): AuditEvent[] {
    const where: string[] = [], args: unknown[] = []
    if (q.before) { where.push('at < ?'); args.push(q.before) }
    if (q.actor) { where.push('actor_id = ?'); args.push(q.actor) }
    if (q.action) { where.push('(action = ? OR action LIKE ?)'); args.push(q.action, `${q.action}.%`) }
    const limit = Math.min(Math.max(Number(q.limit) || 100, 1), 500)
    const rows = [...this.sql.exec(`SELECT * FROM audit_log${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, seq DESC LIMIT ${limit}`, ...args)]
    return rows.map((r) => ({ id: String(r.id), at: String(r.at), project: this.project(), actor: { kind: r.actor_kind as AuditEvent['actor']['kind'], id: String(r.actor_id), ...(r.actor_email ? { email: String(r.actor_email) } : {}) },
      via: r.via as AuditEvent['via'], action: String(r.action), ...(r.target ? { target: String(r.target) } : {}), outcome: r.outcome as AuditEvent['outcome'], ...(r.detail ? { detail: JSON.parse(String(r.detail)) } : {}) }))
  }
}
