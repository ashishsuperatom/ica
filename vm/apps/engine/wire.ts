// WHAT THE WIRE DOES WITH A LARGE MESSAGE IS THE TRANSPORT'S BUSINESS (clients/transport.ts), the same module at
// both ends: a body over the frame limit goes beside the wire as a parcel when a store is at hand, else as parts,
// and comes back whole. Nothing that sends or handles a message sees either. One sender per addressee, one
// receiver per sender, made on first use. The engine's own messages TO THE PLATFORM (its index puts, session sync, its
// replicas' requests — `type` messages the hub answers) go through toHub: the same sender, so a big one goes as a parcel
// too, its pointer keeping the message's type and reqId. This file is the only place on the engine that packs a parcel,
// and the receiver the only place that opens one.
import { sender, receiver, type ParcelStore } from '../../../clients/transport.js'

export function createWire(o: { emit: (to: any, frame: any) => void; handle: (whole: any, from: any) => void; parcels?: ParcelStore; raw?: () => { send: (text: string) => void } | null }) {
  const toWire = new Map<string, ReturnType<typeof sender>>()
  const fromWire = new Map<string, ReturnType<typeof receiver>>()
  const senderFor = (to: any) => {
    // One sender per ADDRESS — a connection, a log channel, the chat channel — each sending to its own `to`.
    const key = JSON.stringify([to?.id ?? null, to?.type ?? null, to?.channel ?? null])
    let s = toWire.get(key)
    if (!s) { s = sender({ send: (frame) => o.emit(to, frame), parcels: o.parcels, onFallback: (why) => console.warn(`[wire] parcel not made (${why}); sent as parts`) }); toWire.set(key, s) }
    return s
  }
  const receiverFor = (from: any) => {
    const key = String(from?.id ?? '?')
    let r = fromWire.get(key)
    if (!r) { r = receiver({ deliver: (whole) => o.handle(whole, from), parcels: o.parcels }); fromWire.set(key, r) }
    return r
  }
  // To the platform: one ordered sender. A pointer keeps the message's type and reqId; a body that could not be made a
  // parcel goes whole (the hub takes no parts of its own messages).
  let hubLine: Promise<unknown> = Promise.resolve()
  const toPlatform = sender({
    send: (frame: any) => {
      const sock = o.raw?.(); if (!sock) return
      if (frame?.t === 'part') { if (frame.part === 0) pendingWhole = []; pendingWhole.push(frame.data); if (frame.part === frame.of - 1) sock.send(pendingWhole.join('')); return }
      sock.send(JSON.stringify(frame))
    },
    parcels: o.parcels, partBytes: Number.MAX_SAFE_INTEGER, onFallback: (why) => console.warn(`[wire] a message to the platform went whole (${why})`),
  })
  let pendingWhole: string[] = []
  return {
    /** A message to the platform itself (`type`): sent in order; true when the socket is open to take it. */
    toHub: (msg: Record<string, unknown>): boolean => {
      if (!o.raw?.()) return false
      hubLine = hubLine.then(() => toPlatform.send({ ...msg, t: String(msg.type) }).then(() => {}, (e) => console.error(`[wire] ${String(msg.type)} was not sent: ${e?.message ?? e}`)))
      return true
    },
    /** Send a whole message; the wire decides how it travels. */
    send: (to: any, msg: Record<string, unknown>) => {
      senderFor(to).send(msg).then((how) => { if (how !== 'whole') console.log(`[wire] ${String(msg.t)} went as ${how}`) }, (e) => console.error(`[wire] ${String(msg.t)} was not sent: ${e?.message ?? e}`))
    },
    /** Whether this frame is the wire's own (a part, or a parcel pointer) and has been taken in. */
    receive: (frame: any, from: any): boolean => {
      if (frame?.t === 'part' || (frame && typeof frame === 'object' && 'parcel' in frame)) { void receiverFor(from).receive(frame); return true }
      return false
    },
  }
}
