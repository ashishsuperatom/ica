// WHAT A PERSON'S CELL MAY ASK OF THE PROJECT (user-cell.ts links it; the ProjectDO hands it each message here): the
// replicas every engine keeps — the graph and each source's index — and, of what is per person, only its own person's:
// the connections it may hold (those read with each person's own key, without the project's secrets; and the person's
// own), that person's key to one, and that person's access. Anything else is refused, saying so — never acted on as if
// an engine had sent it. The cell's person is the one its link was admitted for, never what a message says.

/** What a cell may ask, by message type — and the reply each is answered with (an engine waits for that one). */
const REPLY: Record<string, string> = { 'graph:pull': 'graph:batch', 'graph:fingerprint': 'graph:fingerprint', 'dsi:pull': 'dsi:batch', 'dsi:fingerprints': 'dsi:fingerprints',
  'connections:pull': 'connections:list', 'connection:person-key': 'connection:person-key', 'access:resolve': 'access:resolved' }
export const CELL_ASKS = new Set(Object.keys(REPLY))

/** The replicas' news an engine is sent that each cell is sent too (a person's key: only that person's cells). */
export const CELL_SIGNALS = new Set(['graph:changed', 'dsi:changed', 'connections:changed', 'connections:person-key-changed'])

/** What the project answers a cell with — the same answers an engine gets, the per-person ones for this person only. */
export interface CellDoor {
  /** The cell's person: their email and their id (`user:<id>` inside the project). */
  person: { email: string; id: string }
  reply(payload: Record<string, unknown>): void
  graphPull(cursor: unknown): unknown
  graphFingerprint(): Promise<Record<string, unknown>>
  dsiPull(cursor: unknown, source?: string): Record<string, unknown>
  dsiFingerprints(): Promise<Record<string, unknown>>
  /** The connections this person's cell holds. */
  connections(email: string): Promise<unknown[]>
  /** A person's own key to a connection, as the engine is answered. */
  personKey(name: string, email: string): Promise<Record<string, unknown>>
  policies(principal: string, email: string, source: string): { policies: unknown; version: number }
}

export async function cellAsks(msg: any, d: CellDoor): Promise<void> {
  const t = String(msg?.type ?? '')
  const reqId = msg?.reqId
  if (t === 'ready' || t === 'not_ready') return   // its own self-check, said as every engine says it: nothing to answer
  if (!CELL_ASKS.has(t)) { d.reply({ t: 'cell:refused', reqId, reason: `${t || 'that'} is not a cell's to ask` }); return }
  const theirs = (email: unknown) => String(email ?? '').toLowerCase() === d.person.email
  try {
    switch (t) {
      case 'graph:pull': d.reply({ t: 'graph:batch', ...(d.graphPull(msg.cursor ?? {}) as object) }); return
      case 'graph:fingerprint': d.reply({ t: 'graph:fingerprint', reqId, ...(await d.graphFingerprint()) }); return
      case 'dsi:pull': d.reply({ t: 'dsi:batch', reqId, source: msg.source ?? null, ...d.dsiPull(msg.cursor, msg.source || undefined) }); return
      case 'dsi:fingerprints': d.reply({ t: 'dsi:fingerprints', reqId, ...(await d.dsiFingerprints()) }); return
      case 'connections:pull': d.reply({ t: 'connections:list', reqId, connections: await d.connections(d.person.email) }); return
      case 'connection:person-key':
        if (!theirs(msg.email)) { d.reply({ t: 'connection:person-key', reqId, error: "a cell asks only for its own person's key" }); return }
        d.reply({ t: 'connection:person-key', reqId, ...(await d.personKey(String(msg.name ?? ''), d.person.email)) }); return
      case 'access:resolve':
        if (!theirs(msg.email) || String(msg.principal ?? '') !== `user:${d.person.id}`) { d.reply({ t: 'access:resolved', reqId, principal: msg.principal, source: msg.source, error: "a cell reads only its own person's access" }); return }
        d.reply({ t: 'access:resolved', reqId, principal: msg.principal, source: msg.source, ...d.policies(String(msg.principal), d.person.email, String(msg.source ?? '')) }); return
    }
  } catch (e: any) { d.reply({ t: REPLY[t], reqId, error: e?.message ?? String(e) }) }
}
