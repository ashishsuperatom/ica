// ── The transport: whole messages in, whole messages out ─────────────────────────────────────────────────────
//
// Everything above this line — the engine's handle(), a project's application, the web client, iOS, Teams —
// sends and receives WHOLE messages. What the wire does to carry them is this module's business and nobody
// else's: a message too large for one frame goes beside the wire as a PARCEL (a body in the object store,
// named by its hash, fetched with a signed ticket), and when no store is at hand it goes as PARTS (numbered
// slices joined at the other end). Both ends use this same module, in either direction.
//
//   const out = sender({ limit, send, parcels? })      out.send(message)        → frames on the socket
//   const inn = receiver({ deliver, parcels? })        inn.receive(frame)       → whole messages delivered
//
// Order at the send point: measure · under the limit → whole · over → parcel (summary + pointer, whole) · a
// parcel that cannot be made → parts. The receiver joins parts and resolves parcels, then delivers the whole
// message; it never delivers a `part` or a message still carrying a `parcel` pointer.
//
// Pure: no sockets, no fetch, no crypto of its own — the store and the socket are given in. So it runs in Node,
// in a browser, and reads the same in Swift when the time comes.

export interface Parcel { hash: string; bytes: number; ticket: string; expires?: number }

/** Where a body goes when it does not fit the wire. `put` is the sender's side, `get` the receiver's. */
export interface ParcelStore {
  put?: (body: string) => Promise<Parcel>
  get?: (parcel: Parcel) => Promise<string>
}

/** One slice of a message too large for one frame. `id` is the message's own id; parts are 0..of-1. */
export interface Part { t: 'part'; id: string; part: number; of: number; data: string }

/** A message carrying its body beside the wire. Everything but the body travels; the body is the parcel. */
export interface Parcelled { t: string; id: string; parcel: Parcel; summary?: Record<string, unknown>; [k: string]: unknown }

export const isPart = (x: unknown): x is Part =>
  !!x && typeof x === 'object' && (x as Part).t === 'part' && typeof (x as Part).id === 'string' && Number.isInteger((x as Part).part) && Number.isInteger((x as Part).of) && typeof (x as Part).data === 'string'

export const isParcelled = (x: unknown): x is Parcelled => {
  const p = x && typeof x === 'object' ? (x as Parcelled).parcel : undefined
  return !!p && typeof p === 'object' && typeof p.hash === 'string' && typeof p.ticket === 'string'
}

/** What may travel through the hub in one frame. The hub's own ceiling is 1 MiB; this is lower by choice — a message a person reads, never a table — so the
 * Durable Object carries messages and never bulk: above it a body goes beside the wire as a parcel. */
export const FRAME_LIMIT = 128_000
export const PART_BYTES = 480_000

// Bytes of a string as UTF-8, counted without Node or the DOM: what the hub measures.
const byteLength = (s: string) => { let n = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); n += c < 0x80 ? 1 : c < 0x800 ? 2 : c >= 0xd800 && c <= 0xdbff ? (i++, 4) : 3 } return n }

/** A message's id: its own `reqId` or `id`, else one made here. */
const idOf = (msg: Record<string, unknown>, make: () => string) => String(msg.reqId ?? msg.id ?? make())

const defaultId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)

/** Which fields of a large message still travel when its body goes as a parcel: the routing and the summary. */
export function summaryOf(msg: Record<string, unknown>): Record<string, unknown> {
  const keep = ['t', 'type', 'reqId', 'id', 'to', 'from', 'focus', 'label', 'title', 'words', 'said', 'today', 'ms', 'used', 'notes']
  const out: Record<string, unknown> = {}
  for (const k of keep) if (k in msg) out[k] = msg[k]
  return out
}

export interface SenderOptions {
  send: (frame: unknown) => void
  parcels?: ParcelStore
  limit?: number
  partBytes?: number
  makeId?: () => string
  /** Told when a parcel could not be made and parts were used instead — for a log line, never for behaviour. */
  onFallback?: (why: string) => void
}

export function sender(o: SenderOptions) {
  const limit = o.limit ?? FRAME_LIMIT, partBytes = o.partBytes ?? PART_BYTES, makeId = o.makeId ?? defaultId
  const asParts = (text: string, id: string) => {
    const of = Math.ceil(text.length / partBytes)
    for (let part = 0; part < of; part++) o.send({ t: 'part', id, part, of, data: text.slice(part * partBytes, (part + 1) * partBytes) } satisfies Part)
  }
  return {
    async send(msg: Record<string, unknown>): Promise<'whole' | 'parcel' | 'parts'> {
      const text = JSON.stringify(msg)
      if (byteLength(text) <= limit) { o.send(msg); return 'whole' }
      const id = idOf(msg, makeId)
      if (o.parcels?.put) {
        try {
          const parcel = await o.parcels.put(text)
          const pointer: Parcelled = { ...summaryOf(msg), t: String(msg.t), id, parcel }
          if (byteLength(JSON.stringify(pointer)) <= limit) { o.send(pointer); return 'parcel' }
          o.onFallback?.('the summary itself is over the limit')
        } catch (e: any) { o.onFallback?.(e?.message ?? String(e)) }
      }
      asParts(text, id)
      return 'parts'
    },
  }
}

export interface ReceiverOptions {
  deliver: (msg: Record<string, unknown>) => void
  parcels?: ParcelStore
  /** Told when a parcel could not be fetched; the pointer is then delivered as it is, with `parcelError` set. */
  onError?: (why: string, msg: Record<string, unknown>) => void
}

export function receiver(o: ReceiverOptions) {
  const held = new Map<string, { of: number; parts: Map<number, string> }>()
  const whole = async (msg: Record<string, unknown>) => {
    if (isParcelled(msg) && o.parcels?.get) {
      try {
        const body = JSON.parse(await o.parcels.get(msg.parcel))
        o.deliver({ ...body, ...(msg.reqId !== undefined ? { reqId: msg.reqId } : {}) })
        return
      } catch (e: any) { o.onError?.(e?.message ?? String(e), msg); o.deliver({ ...msg, parcelError: e?.message ?? String(e) }); return }
    }
    o.deliver(msg)
  }
  return {
    /** Feed every frame here. Whole messages are delivered at once; parts are held until the last arrives. */
    async receive(frame: unknown): Promise<void> {
      if (!frame || typeof frame !== 'object') return
      if (!isPart(frame)) { await whole(frame as Record<string, unknown>); return }
      const h = held.get(frame.id) ?? { of: frame.of, parts: new Map<number, string>() }
      h.parts.set(frame.part, frame.data)
      held.set(frame.id, h)
      if (h.parts.size < h.of) return
      held.delete(frame.id)
      let msg: unknown
      try { msg = JSON.parse(Array.from({ length: h.of }, (_, i) => h.parts.get(i) ?? '').join('')) } catch { return }
      if (msg && typeof msg === 'object') await whole(msg as Record<string, unknown>)
    },
    /** How many messages are still arriving, for a status line. */
    pending: () => held.size,
    /** Forget everything half-arrived — when the socket that was sending it is gone. */
    reset: () => held.clear(),
  }
}
