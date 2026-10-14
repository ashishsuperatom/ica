// THE READER TICKET — who a read is for, and what they may read, in a form only the engine can make.
//
// The datasource manager has two ways in (docs/connectors-plan.md, step 1): the engine's own work, which holds the
// manager's key (`x-sa-system`), and whatever runs FOR someone — agents, programs — which holds a ticket (`x-sa-ticket`).
// The engine signs a ticket with the same key after the platform has resolved that person's data access policies;
// whoever holds the ticket can read it but cannot change or forge it, since the key is never given to a child process.
// The policies the manager applies come from the ticket alone.
//
//   v1.<payload, base64url JSON>.<HMAC-SHA256 of "v1.<payload>", base64url>

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface Ticket {
  /** The reader: `user:<id>` or `agent:<name>`. */
  principal: string
  email?: string | null
  /** The resolved policies, per source id (what the rewrite applies). A source absent here has none. */
  policies: Record<string, unknown[]>
  session?: string | null
  /** The access version the policies were resolved at: an access change makes older tickets void. */
  access: number
  /** Expiry, epoch ms. */
  exp: number
}

/** Longest a ticket may live: one turn. */
export const TICKET_MAX_MS = 15 * 60_000

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const mac = (key: string, body: string) => createHmac('sha256', key).update(body).digest()

/** Sign a ticket (the engine). Its expiry is capped at TICKET_MAX_MS from now. */
export function signTicket(key: string, t: Omit<Ticket, 'exp'> & { exp?: number }): string {
  const exp = Math.min(t.exp ?? Date.now() + TICKET_MAX_MS, Date.now() + TICKET_MAX_MS)
  const body = `v1.${b64(JSON.stringify({ ...t, exp }))}`
  return `${body}.${b64(mac(key, body))}`
}

/** Why a ticket was refused — said to the reader plainly. */
export class TicketRefusal extends Error {}

/** Check a ticket (the manager): signed with this key, not expired, not older than the current access version. */
export function verifyTicket(key: string, ticket: string, accessVersion: number, now = Date.now()): Ticket {
  const parts = String(ticket ?? '').split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') throw new TicketRefusal('no valid data access ticket — nothing was read')
  const body = `${parts[0]}.${parts[1]}`
  const given = Buffer.from(parts[2], 'base64url'), want = mac(key, body)
  if (given.length !== want.length || !timingSafeEqual(given, want)) throw new TicketRefusal('no valid data access ticket — nothing was read')
  let t: Ticket
  try { t = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) } catch { throw new TicketRefusal('no valid data access ticket — nothing was read') }
  if (typeof t.exp !== 'number' || t.exp < now) throw new TicketRefusal('your data access ticket has expired — ask again')
  if (typeof t.access !== 'number' || t.access < accessVersion) throw new TicketRefusal('your data access changed — ask again')
  if (typeof t.principal !== 'string' || !t.principal) throw new TicketRefusal('no valid data access ticket — nothing was read')
  return { ...t, policies: t.policies && typeof t.policies === 'object' ? t.policies : {} }
}

/** Does this header hold the manager's key? (constant time) */
export function isSystem(key: string, given: string | undefined | null): boolean {
  if (!given) return false
  const a = Buffer.from(String(given)), b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}
