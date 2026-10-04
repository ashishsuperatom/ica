// ── The platform's own warehouse: one recorder for everything every Durable Object keeps ─────────────────────────────
//
// Each DO keeps its own data (a project's audit and usage, a session's log, a graph's records, an organisation's
// credits) — and nothing can be asked across them. So every record a DO keeps is also sent here, once, to the platform's
// warehouse: one stream (platform_records) → Iceberg tables in the platform's Basin Catalog, read with Basin SQL — for
// analysis, and for training agents on what actually happened. One recorder, one stream, every kind of record.
//
// A send that fails is logged and never breaks the work: the DO has already kept the record itself.

export interface PlatformRecord {
  id: string
  at: string
  /** What it is: audit, usage, activity, program, session.entry, graph.change, graph.suggestion, graph.decision, credit, chat.answer … */
  kind: string
  project: string
  /** Its key within its kind (an audit id, a session and sequence number, a graph change number …). */
  key: string
  /** The record itself, as JSON. */
  data: string
}

type Stream = { send(records: unknown[]): Promise<void> }

export function createRecorder(stream: Stream | undefined, project: () => string) {
  return function record(kind: string, key: string, data: unknown, at?: string): void {
    if (!stream) return
    const rec: PlatformRecord = { id: crypto.randomUUID(), at: at ?? new Date().toISOString(), kind, project: project() || 'platform', key: String(key), data: JSON.stringify(data ?? null) }
    stream.send([rec]).catch((e: any) => console.warn(`[records] ${kind} ${key} not sent to the warehouse: ${e?.message ?? e}`))
  }
}
export type Recorder = ReturnType<typeof createRecorder>
