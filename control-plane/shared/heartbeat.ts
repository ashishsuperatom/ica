// A tab's heartbeat and its answer, exactly as sent: the person's UserDO answers it without waking (an auto-response
// matches the whole frame), and the tab treats a missing answer as a dead connection.
export const HEARTBEAT = '{"type":"heartbeat"}'
export const HEARTBEAT_REPLY = '{"type":"heartbeat:ok"}'

/** A tab's side: a heartbeat every `every` ms while the connection is open; no answer (nor anything else) heard within
 *  `grace` ms of one means the connection is dead though it looks open — `dead` is called once (the tab closes it and
 *  reconnects). `heard` is called for every frame that arrives. */
export function keepAlive(o: { beat: () => void; dead: () => void; every?: number; grace?: number }) {
  const every = o.every ?? 25_000, grace = o.grace ?? 10_000
  let waiting: ReturnType<typeof setTimeout> | null = null, over = false
  const timer = setInterval(() => {
    if (over || waiting) return
    o.beat()
    waiting = setTimeout(() => { waiting = null; if (!over) { over = true; clearInterval(timer); o.dead() } }, grace)
  }, every)
  return {
    heard() { if (waiting) { clearTimeout(waiting); waiting = null } },
    stop() { over = true; clearInterval(timer); if (waiting) clearTimeout(waiting) },
  }
}
