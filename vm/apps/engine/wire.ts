// WHAT THE WIRE DOES WITH A LARGE MESSAGE IS THE TRANSPORT'S BUSINESS (clients/transport.ts), the same module at
// both ends: a body over the frame limit goes beside the wire as a parcel when a store is at hand, else as parts,
// and comes back whole. Nothing that sends or handles a message sees either. One sender per addressee, one
// receiver per sender, made on first use.
import { sender, receiver, type ParcelStore } from '../../../clients/transport.js'

export function createWire(o: { emit: (to: any, frame: any) => void; handle: (whole: any, from: any) => void; parcels?: ParcelStore }) {
  const toWire = new Map<string, ReturnType<typeof sender>>()
  const fromWire = new Map<string, ReturnType<typeof receiver>>()
  const senderFor = (to: any) => {
    const key = String(to?.id ?? 'broadcast')
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
  return {
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
