// HubCore — pure logic for the WebSocket hub message relay
// Extracted from ProjectDO for testability. No CF runtime dependencies.

export interface ConnInfo {
  wsId: string
  type: string       // "code-engine" | "user"
  userId?: string
  orgRole?: string
}

export interface Envelope {
  to?: { id: string; type: string }
  from: { id: string; type: string; userId?: string }
  payload: unknown
}

type OutgoingFn = (wsId: string, msg: Envelope) => void

export class HubCore {
  // wsId → ConnInfo
  private byId = new Map<string, ConnInfo>()
  // role → wsId (at most one connection per role)
  private roleReg = new Map<string, string>()

  private send: OutgoingFn

  constructor(send: OutgoingFn) {
    this.send = send
  }

  // ── Registration ──────────────────────────────────────────────────────────

  register(wsId: string, type: string, userId?: string, orgRole?: string): Envelope {
    // Evict previous holder of this role
    if (this.roleReg.has(type)) {
      const oldId = this.roleReg.get(type)!
      this.send(oldId, {
        from: { id: 'hub', type: 'hub' },
        to: { id: oldId, type },
        payload: { t: 'evicted', reason: 'Another connection took your role' },
      })
      this.byId.delete(oldId)
    }

    const info: ConnInfo = { wsId, type, userId, orgRole }
    this.byId.set(wsId, info)
    this.roleReg.set(type, wsId)

    // Welcome envelope
    return {
      from: { id: 'hub', type: 'hub' },
      to: { id: wsId, type },
      payload: { t: 'welcome', wsId, type },
    }
  }

  disconnect(wsId: string): { others: Envelope[]; wasRole: string | null } {
    const info = this.byId.get(wsId)
    if (!info) return { others: [], wasRole: null }

    this.byId.delete(wsId)
    let wasRole: string | null = null
    if (this.roleReg.get(info.type) === wsId) {
      this.roleReg.delete(info.type)
      wasRole = info.type
    }

    const leaveMsg: Envelope = {
      from: { id: 'hub', type: 'hub' },
      payload: { t: 'connection:leave', wsId: info.wsId, type: info.type },
    }
    const others = [...this.byId.values()].map(c => leaveMsg)

    return { others, wasRole }
  }

  // ── Relay ─────────────────────────────────────────────────────────────────

  relay(senderWsId: string, msg: { to?: { id?: string; type?: string }; payload: unknown }): {
    out: Array<{ targetWsId: string; envelope: Envelope }>
    errors: Envelope[]
  } {
    const sender = this.byId.get(senderWsId)
    if (!sender) {
      return { out: [], errors: [] }
    }

    const envelope: Envelope = {
      // Stamp the AUTHENTICATED userId (from the verified JWT, tracked on the connection) alongside the
      // wsId — never trust a client-supplied userId. Only user connections carry one.
      from: { id: sender.wsId, type: sender.type, userId: sender.userId },
      payload: msg.payload,
    }

    const out: Array<{ targetWsId: string; envelope: Envelope }> = []
    const errors: Envelope[] = []

    const to = msg.to

    // ── Broadcast (no `to`) ─────────────────────────────────────────────────
    if (!to) {
      for (const conn of this.byId.values()) {
        if (conn.wsId === senderWsId) continue
        out.push({
          targetWsId: conn.wsId,
          envelope: { ...envelope, to: { id: conn.wsId, type: conn.type } },
        })
      }
      return { out, errors }
    }

    // ── Role-based routing ──────────────────────────────────────────────────
    if (to.type && !to.id) {
      const targetWsId = this.roleReg.get(to.type)
      if (!targetWsId || !this.byId.has(targetWsId)) {
        this.roleReg.delete(to.type)
        errors.push({
          from: { id: 'hub', type: 'hub' },
          to: { id: senderWsId, type: sender.type },
          payload: { t: 'error', reason: `No connection for role: ${to.type}` },
        })
        return { out, errors }
      }
      const target = this.byId.get(targetWsId)!
      out.push({
        targetWsId: target.wsId,
        envelope: { ...envelope, to: { id: target.wsId, type: target.type } },
      })
      return { out, errors }
    }

    // ── Direct wsId routing ─────────────────────────────────────────────────
    if (to.id) {
      const targetWsId = to.id
      if (!this.byId.has(targetWsId)) {
        errors.push({
          from: { id: 'hub', type: 'hub' },
          to: { id: senderWsId, type: sender.type },
          payload: { t: 'error', reason: `Connection not found: ${targetWsId}` },
        })
        return { out, errors }
      }
      const target = this.byId.get(targetWsId)!
      out.push({
        targetWsId: target.wsId,
        envelope: { ...envelope, to: { id: target.wsId, type: target.type } },
      })
      return { out, errors }
    }

    // to.type is falsy and to.id is falsy — same as broadcast
    for (const conn of this.byId.values()) {
      if (conn.wsId === senderWsId) continue
      out.push({
        targetWsId: conn.wsId,
        envelope: { ...envelope, to: { id: conn.wsId, type: conn.type } },
      })
    }
    return { out, errors }
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  getByRole(role: string): ConnInfo | undefined {
    const wsId = this.roleReg.get(role)
    return wsId ? this.byId.get(wsId) : undefined
  }

  getById(wsId: string): ConnInfo | undefined {
    return this.byId.get(wsId)
  }

  getAll(): ConnInfo[] {
    return [...this.byId.values()]
  }

  has(wsId: string): boolean {
    return this.byId.has(wsId)
  }
}
