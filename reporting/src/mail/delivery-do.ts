// ── The per-project delivery ledger ──────────────────────────────────────────
// One Durable Object per project (the DO name is the project in the registry).
// SQLite is used only for coordination: a key, `sending`/`sent`, a timestamp and
// Cloudflare's message id. No recipient, subject, body or attachment is stored.
//
// The DO is also where send() happens, so the claim and the send are serialised
// by the same object. Two simultaneous requests for the same key cannot both
// claim it.

import { DurableObject } from 'cloudflare:workers'
import type { Claim, DeliverResult, DeliveryLedger, MailEnv, OutboundEmail } from './types.js'
import { DELIVERY_TTL_MS, deliverWith } from './delivery.js'
import { sendMail } from './transport.js'

const ALARM_INTERVAL_MS = 24 * 60 * 60 * 1000

export class MailDelivery extends DurableObject<MailEnv> {
  constructor(ctx: DurableObjectState, env: MailEnv) {
    super(ctx, env)
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS deliveries (
        key TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('sending', 'sent')),
        at INTEGER NOT NULL,
        message_id TEXT
      )
    `)
  }

  async deliver(key: string, email: OutboundEmail): Promise<DeliverResult> {
    const now = Date.now()
    const ledger: DeliveryLedger = {
      prune: (before) => this.prune(before),
      claim: (value, at) => this.claim(value, at),
      markSent: (value, messageId, at) => this.markSent(value, messageId, at),
      release: (value) => this.release(value),
    }

    const result = await deliverWith(ledger, key, () => sendMail(this.env, email), now)

    // Keep the table bounded even if no request arrives for a while.
    const alarm = await this.ctx.storage.getAlarm()
    if (alarm === null) await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS)

    return result
  }

  async alarm(): Promise<void> {
    const now = Date.now()
    await this.prune(now - DELIVERY_TTL_MS)
    const row = this.ctx.storage.sql
      .exec('SELECT COUNT(*) AS n FROM deliveries')
      .one() as { n: number }
    if (row.n > 0) await this.ctx.storage.setAlarm(now + ALARM_INTERVAL_MS)
  }

  private async prune(before: number): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM deliveries WHERE at < ?', before)
  }

  private async claim(key: string, at: number): Promise<Claim> {
    const inserted = this.ctx.storage.sql
      .exec(
        `INSERT INTO deliveries (key, status, at) VALUES (?, 'sending', ?)
         ON CONFLICT(key) DO NOTHING`,
        key,
        at,
      )
      .rowsWritten

    if (inserted > 0) return { state: 'claimed' }

    const row = this.ctx.storage.sql
      .exec('SELECT status, message_id FROM deliveries WHERE key = ?', key)
      .one() as { status?: string; message_id?: string | null }

    if (row.status === 'sent') {
      return { state: 'sent', messageId: row.message_id ?? undefined }
    }
    return { state: 'pending' }
  }

  private async markSent(key: string, messageId: string, at: number): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE deliveries SET status = 'sent', at = ?, message_id = ? WHERE key = ?`,
      at,
      messageId,
      key,
    )
  }

  private async release(key: string): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM deliveries WHERE key = ? AND status = 'sending'`, key)
  }
}
