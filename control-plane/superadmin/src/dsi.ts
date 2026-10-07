// ── Each data source's index, held by the platform — in the project's own Durable Object ─────────────────────────────
//
// The index of a source is its tables and each table's fields (docs/platform-architecture.md, "Data sources and their
// index"). It is built wherever the source's connector runs (today the engine) and kept here: every change appended to a
// log with when and by whom, so the index can be read as of any time; the current state beside it, numbered by the log,
// so an engine's replica pulls what changed after its cursor. Nothing is deleted: a table no longer in the source is
// gone, a disabled one disabled. A description is kept three ways (the source's, a person's, an AI's); the one used is
// the person's, else the source's, else the AI's.
//
// From the engine that builds it:
//   dsi:plan { source, phase, tables[], complete, fresh? } → dsi:planned { done[] }     the work list; what is done already
//   dsi:put { source, phase, table, fields[] }   one table read (a checkpoint)          dsi:failed { source, phase, table, error }
//   dsi:rows { source, counts }   row counts (phase 2, only where cheap)                dsi:finish { source, phase }
//   dsi:pull { cursor, source? } → dsi:batch { items, cursor, more, latest }   (dsi:changed tells it to pull; a big page
//                                    travels as a parcel, like every big body)
//   dsi:fingerprints → { sources: { <source>: { count, hash } } }   a replica that differs re-pulls only that source
// From people and agents (the hub checks what each needs):
//   dsi:show { source?, table?, asOf? } · dsi:stats · dsi:describe { source, table, field?, text, by: human|ai }
//   dsi:enable { source, table, field?, enabled } · dsi:build { sources?, tables?, fresh? } (asked of the engine)
//   dsi:snapshot → the whole current index as one document (a screen downloads it; it travels as a parcel)
//   dsi:failures { source } → the tables its builds could not read, and why

type Storage = DurableObjectStorage
import { fingerprintOf } from '../../../vm/packages/datasource-index/src/fingerprint.js'

export interface FieldIn { name: string; type?: string | null; description?: string | null; optional?: boolean | null; key?: boolean | null; references?: string | null }
export interface Item {
  source: string; table: string; field: string
  type: string | null; descSource: string | null; descHuman: string | null; descAi: string | null
  optional: boolean | null; key: boolean | null; references: string | null; rows: number | null
  enabled: boolean; enabledBy: 'auto' | 'person'; gone: boolean; seq: number
}
export class DsiRefusal extends Error {}

/** The description used: a person's, else the source's own, else an AI's. */
export const descriptionOf = (i: Pick<Item, 'descHuman' | 'descSource' | 'descAi'>): string => i.descHuman?.trim() || i.descSource?.trim() || i.descAi?.trim() || ''

const NAME = /^[^\u0000-\u001f]{1,300}$/
const nameOk = (v: unknown, what: string): string => { if (typeof v !== 'string' || !NAME.test(v)) throw new DsiRefusal(`${what} is a name of at most 300 characters`); return v }
const b = (v: unknown): number | null => (v === true ? 1 : v === false ? 0 : null)

export function projectDsi(storage: Storage) {
  const sql = storage.sql
  const toItem = (r: any): Item => ({ source: r.source, table: r.tbl, field: r.field, type: r.type ?? null, descSource: r.desc_source ?? null, descHuman: r.desc_human ?? null,
    descAi: r.desc_ai ?? null, optional: r.optional == null ? null : !!r.optional, key: r.is_key == null ? null : !!r.is_key, references: r.refs ?? null,
    rows: r.rows == null ? null : Number(r.rows), enabled: !!r.enabled, enabledBy: r.enabled_by === 'person' ? 'person' : 'auto', gone: !!r.gone, seq: Number(r.seq) })
  const current = (source: string, table: string, field: string): Item | null => { const [r] = [...sql.exec('SELECT * FROM dsi_items WHERE source = ? AND tbl = ? AND field = ?', source, table, field)]; return r ? toItem(r) : null }
  const same = (a: Item, x: Omit<Item, 'seq'>) => JSON.stringify({ ...a, seq: 0 }) === JSON.stringify({ ...x, seq: 0 })

  /** Write an item as it now is — only when it changed: appended to the log, then the current state at that log entry. */
  function write(next: Omit<Item, 'seq'>, op: string, by: string): boolean {
    const was = current(next.source, next.table, next.field)
    if (was && same(was, next)) return false
    const at = new Date().toISOString()
    const [{ seq }] = [...sql.exec('INSERT INTO dsi_log (at, by, source, tbl, field, op, item) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING seq', at, by, next.source, next.table, next.field, op, JSON.stringify(next))] as any[]
    sql.exec(`INSERT INTO dsi_items (source, tbl, field, type, desc_source, desc_human, desc_ai, optional, is_key, refs, rows, enabled, enabled_by, gone, seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (source, tbl, field) DO UPDATE SET type = excluded.type, desc_source = excluded.desc_source,
      desc_human = excluded.desc_human, desc_ai = excluded.desc_ai, optional = excluded.optional, is_key = excluded.is_key, refs = excluded.refs, rows = excluded.rows,
      enabled = excluded.enabled, enabled_by = excluded.enabled_by, gone = excluded.gone, seq = excluded.seq`,
      next.source, next.table, next.field, next.type, next.descSource, next.descHuman, next.descAi, b(next.optional), b(next.key), next.references, next.rows,
      next.enabled ? 1 : 0, next.enabledBy, next.gone ? 1 : 0, Number(seq))
    return true
  }
  const blank = (source: string, table: string, field: string): Omit<Item, 'seq'> => ({ source, table, field, type: null, descSource: null, descHuman: null, descAi: null,
    optional: null, key: null, references: null, rows: null, enabled: true, enabledBy: 'auto', gone: false })
  const strip = ({ seq, ...rest }: Item): Omit<Item, 'seq'> => rest
  const markGone = (source: string, table: string, field: string | null, by: string) => {
    let n = 0
    const rows = field === null ? [...sql.exec('SELECT * FROM dsi_items WHERE source = ? AND tbl = ? AND gone = 0', source, table)] : [...sql.exec('SELECT * FROM dsi_items WHERE source = ? AND tbl = ? AND field = ? AND gone = 0', source, table, field)]
    for (const r of rows) if (write({ ...strip(toItem(r)), gone: true }, 'gone', by)) n++
    return n
  }
  const tx = <T,>(f: () => T): T => storage.transactionSync(f)

  return {
    cursor: (): number => Number([...sql.exec('SELECT MAX(seq) AS v FROM dsi_log')][0]?.v ?? 0),

    /** The engine's work list for one source and phase. A complete list (the source's whole catalog, read without error)
     *  also marks gone the tables it no longer has; a partial one changes nothing. fresh starts the phase over. Replies
     *  with the tables already done in this phase (the checkpoints a resume skips). */
    plan(p: { source: unknown; phase: unknown; tables: unknown; complete?: unknown; fresh?: unknown }, by: string): { done: string[]; gone: number } {
      const source = nameOk(p.source, 'a source'), phase = Number(p.phase)
      if (phase !== 1 && phase !== 2) throw new DsiRefusal('a phase is 1 or 2')
      const tables = Array.isArray(p.tables) ? [...new Set(p.tables.map((t) => nameOk(t, 'a table')))] : null
      if (!tables) throw new DsiRefusal('a plan lists its tables')
      return tx(() => {
        if (p.fresh) sql.exec('DELETE FROM dsi_progress WHERE source = ? AND phase = ?', source, phase)
        let gone = 0
        if (p.complete === true) {
          const have = new Set(tables)
          for (const r of [...sql.exec("SELECT tbl FROM dsi_items WHERE source = ? AND field = '' AND gone = 0", source)] as any[]) if (!have.has(String(r.tbl))) gone += markGone(source, String(r.tbl), null, by)
        }
        sql.exec('INSERT INTO dsi_plan (source, phase, tables, complete, planned_at, finished_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT (source, phase) DO UPDATE SET tables = excluded.tables, complete = excluded.complete, planned_at = excluded.planned_at, finished_at = NULL',
          source, phase, tables.length, p.complete === true ? 1 : 0, new Date().toISOString())
        const done = ([...sql.exec("SELECT tbl FROM dsi_progress WHERE source = ? AND phase = ? AND state = 'done'", source, phase)] as any[]).map((r) => String(r.tbl)).filter((t) => tables.includes(t))
        return { done, gone }
      })
    },

    /** One table as the source has it now: the table, its fields (what is new or changed is logged; a field it no longer
     *  has is gone; a person's or an AI's description and a person's enabling are never overwritten). A checkpoint. */
    put(p: { source: unknown; phase?: unknown; table: unknown; fields: unknown }, by: string): { changed: number } {
      const source = nameOk(p.source, 'a source'), table = nameOk(p.table, 'a table')
      const fields = Array.isArray(p.fields) ? (p.fields as FieldIn[]) : null
      if (!fields) throw new DsiRefusal('a table comes with its fields')
      return tx(() => {
        let changed = 0
        const t = current(source, table, '')
        if (write({ ...(t ? strip(t) : blank(source, table, '')), gone: false }, t ? 'seen' : 'add', by)) changed++
        const seen = new Set<string>()
        for (const f of fields) {
          const name = nameOk(f?.name, 'a field')
          if (seen.has(name)) continue
          seen.add(name)
          const was = current(source, table, name)
          const next = { ...(was ? strip(was) : blank(source, table, name)), type: f.type ? String(f.type).slice(0, 200) : null,
            descSource: f.description ? String(f.description).slice(0, 4000) : null, optional: f.optional ?? null, key: f.key ?? null,
            references: f.references ? String(f.references).slice(0, 600) : null, gone: false }
          if (write(next, was ? 'change' : 'add', by)) changed++
        }
        for (const r of [...sql.exec("SELECT field FROM dsi_items WHERE source = ? AND tbl = ? AND field != '' AND gone = 0", source, table)] as any[]) if (!seen.has(String(r.field))) changed += markGone(source, table, String(r.field), by)
        sql.exec("INSERT INTO dsi_progress (source, phase, tbl, state, error, at) VALUES (?, ?, ?, 'done', NULL, ?) ON CONFLICT (source, phase, tbl) DO UPDATE SET state = 'done', error = NULL, at = excluded.at",
          source, Number(p.phase) || 1, table, new Date().toISOString())
        return { changed }
      })
    },

    /** A table that could not be read: recorded as such (never as empty), retried by the next build. */
    failed(p: { source: unknown; phase?: unknown; table: unknown; error?: unknown }) {
      const source = nameOk(p.source, 'a source'), table = nameOk(p.table, 'a table')
      sql.exec("INSERT INTO dsi_progress (source, phase, tbl, state, error, at) VALUES (?, ?, ?, 'failed', ?, ?) ON CONFLICT (source, phase, tbl) DO UPDATE SET state = 'failed', error = excluded.error, at = excluded.at",
        source, Number(p.phase) || 1, table, String(p.error ?? '').slice(0, 1000), new Date().toISOString())
    },

    /** Row counts the source gave definitively (phase 2). An empty table is disabled by the build — unless a person set
     *  it; a table that has rows again is enabled again if the build had disabled it. */
    rows(p: { source: unknown; counts: unknown }, by: string): { changed: number } {
      const source = nameOk(p.source, 'a source')
      const counts = p.counts && typeof p.counts === 'object' ? (p.counts as Record<string, unknown>) : {}
      return tx(() => {
        let changed = 0
        for (const [table, raw] of Object.entries(counts)) {
          const n = Number(raw)
          if (!Number.isFinite(n) || n < 0) continue
          const t = current(source, table, '')
          if (!t || t.gone) continue
          const next = { ...strip(t), rows: n }
          if (t.enabledBy === 'auto') next.enabled = n > 0
          if (write(next, 'rows', by)) changed++
          sql.exec("INSERT INTO dsi_progress (source, phase, tbl, state, error, at) VALUES (?, 2, ?, 'done', NULL, ?) ON CONFLICT (source, phase, tbl) DO UPDATE SET state = 'done', at = excluded.at", source, table, new Date().toISOString())
        }
        return { changed }
      })
    },

    finish(p: { source: unknown; phase: unknown }) {
      sql.exec('UPDATE dsi_plan SET finished_at = ? WHERE source = ? AND phase = ?', new Date().toISOString(), nameOk(p.source, 'a source'), Number(p.phase))
    },

    /** A person's change: a description (said to be a person's or an AI's), or enabling and disabling a table or field. */
    describe(p: { source: unknown; table: unknown; field?: unknown; text: unknown; by: unknown }, who: string): Item {
      const source = nameOk(p.source, 'a source'), table = nameOk(p.table, 'a table'), field = p.field ? nameOk(p.field, 'a field') : ''
      if (p.by !== 'human' && p.by !== 'ai') throw new DsiRefusal('say who wrote the description: by "human" or "ai"')
      const i = current(source, table, field)
      if (!i) throw new DsiRefusal(`${[source, table, field].filter(Boolean).join('.')} is not in the index`)
      const text = typeof p.text === 'string' && p.text.trim() ? p.text.trim().slice(0, 4000) : null
      tx(() => write({ ...strip(i), ...(p.by === 'human' ? { descHuman: text } : { descAi: text }) }, p.by === 'human' ? 'describe' : 'describe-ai', who))
      return current(source, table, field)!
    },
    enable(p: { source: unknown; table: unknown; field?: unknown; enabled: unknown }, who: string): Item {
      const source = nameOk(p.source, 'a source'), table = nameOk(p.table, 'a table'), field = p.field ? nameOk(p.field, 'a field') : ''
      if (typeof p.enabled !== 'boolean') throw new DsiRefusal('enabled is true or false')
      const i = current(source, table, field)
      if (!i) throw new DsiRefusal(`${[source, table, field].filter(Boolean).join('.')} is not in the index`)
      tx(() => write({ ...strip(i), enabled: p.enabled as boolean, enabledBy: 'person' }, p.enabled ? 'enable' : 'disable', who))
      return current(source, table, field)!
    },

    /** What changed after a cursor (the current state of each item changed, in order) — an engine's replica pulls it. */
    pull(after: unknown, source?: unknown, limit = 10_000): { items: Item[]; cursor: number; more: boolean; latest: number } {
      const from = Math.max(0, Number(after) || 0)
      const rows = ((source ? [...sql.exec('SELECT * FROM dsi_items WHERE source = ? AND seq > ? ORDER BY seq LIMIT ?', nameOk(source, 'a source'), from, limit + 1)]
        : [...sql.exec('SELECT * FROM dsi_items WHERE seq > ? ORDER BY seq LIMIT ?', from, limit + 1)]) as any[]).map(toItem)
      const items = rows.slice(0, limit)
      const latest = Number([...sql.exec('SELECT MAX(seq) AS v FROM dsi_log')][0]?.v ?? 0)
      return { items, cursor: items.length ? items[items.length - 1].seq : Math.min(from, latest), more: rows.length > limit, latest }
    },

    /** Each source's fingerprint (fingerprint.ts): what a replica compares with its own. */
    async fingerprints(): Promise<Record<string, { count: number; hash: string }>> {
      const by = new Map<string, Item[]>()
      for (const i of ([...sql.exec('SELECT * FROM dsi_items')] as any[]).map(toItem)) (by.get(i.source) ?? by.set(i.source, []).get(i.source)!).push(i)
      const out: Record<string, { count: number; hash: string }> = {}
      for (const [s, items] of by) out[s] = await fingerprintOf(items)
      return out
    },

    /** The index of a source (or one table, or every source's tables) — now, or as it was at a time. */
    show(p: { source?: unknown; table?: unknown; asOf?: unknown } = {}): Item[] {
      const source = p.source ? nameOk(p.source, 'a source') : null, table = p.table ? nameOk(p.table, 'a table') : null
      const where = [source ? 'source = ?' : '', table ? 'tbl = ?' : ''].filter(Boolean)
      const bind = [...(source ? [source] : []), ...(table ? [table] : [])]
      if (!p.asOf) return ([...sql.exec(`SELECT * FROM dsi_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY source, tbl, field LIMIT 20000`, ...bind)] as any[]).map(toItem)
      const at = new Date(String(p.asOf))
      if (Number.isNaN(at.getTime())) throw new DsiRefusal('asOf is a time (ISO 8601)')
      const rows = [...sql.exec(`SELECT l.seq, l.item FROM dsi_log l JOIN (SELECT source, tbl, field, MAX(seq) AS seq FROM dsi_log WHERE at <= ? ${where.length ? 'AND ' + where.join(' AND ') : ''} GROUP BY source, tbl, field) m ON m.seq = l.seq ORDER BY l.source, l.tbl, l.field LIMIT 20000`, at.toISOString(), ...bind)] as any[]
      return rows.map((r) => ({ ...JSON.parse(String(r.item)), seq: Number(r.seq) }))
    },

    /** Each source: its tables and fields (and how many are disabled or gone), and where its builds stand. */
    stats() {
      const counts = [...sql.exec(`SELECT source, SUM(field = '' AND gone = 0) AS tables, SUM(field != '' AND gone = 0) AS fields,
        SUM(gone = 0 AND enabled = 0 AND field = '') AS tables_disabled, SUM(gone = 0 AND enabled = 0 AND field != '') AS fields_disabled, SUM(gone = 1 AND field = '') AS tables_gone
        FROM dsi_items GROUP BY source ORDER BY source`)] as any[]
      const plans = [...sql.exec(`SELECT p.source, p.phase, p.tables, p.complete, p.planned_at, p.finished_at,
        (SELECT COUNT(*) FROM dsi_progress g WHERE g.source = p.source AND g.phase = p.phase AND g.state = 'done') AS done,
        (SELECT COUNT(*) FROM dsi_progress g WHERE g.source = p.source AND g.phase = p.phase AND g.state = 'failed') AS failed
        FROM dsi_plan p ORDER BY p.source, p.phase`)] as any[]
      const bySource = new Map<string, any>()
      for (const c of counts) bySource.set(c.source, { source: c.source, tables: Number(c.tables), fields: Number(c.fields), tablesDisabled: Number(c.tables_disabled), fieldsDisabled: Number(c.fields_disabled), tablesGone: Number(c.tables_gone), phases: [] })
      for (const p of plans) (bySource.get(p.source) ?? bySource.set(p.source, { source: p.source, tables: 0, fields: 0, tablesDisabled: 0, fieldsDisabled: 0, tablesGone: 0, phases: [] }).get(p.source)).phases.push({
        phase: Number(p.phase), planned: Number(p.tables), done: Number(p.done), failed: Number(p.failed), complete: !!p.complete, plannedAt: p.planned_at, finishedAt: p.finished_at ?? null })
      return { cursor: Number([...sql.exec('SELECT MAX(seq) AS v FROM dsi_log')][0]?.v ?? 0), sources: [...bySource.values()] }
    },

    /** The tables of a source its last builds could not read, with why (retried by the next build, or a targeted one). */
    failures(p: { source: unknown }): { table: string; phase: number; error: string | null; at: string }[] {
      const source = nameOk(p.source, 'a source')
      return ([...sql.exec("SELECT tbl, phase, error, at FROM dsi_progress WHERE source = ? AND state = 'failed' ORDER BY tbl LIMIT 5000", source)] as any[])
        .map((r) => ({ table: String(r.tbl), phase: Number(r.phase), error: r.error ?? null, at: String(r.at) }))
    },

    /** Sources whose build is not finished (planned, not done) or never ran — what a returning engine should resume. */
    unfinished(sources: string[]): string[] {
      const finished = new Set(([...sql.exec("SELECT source FROM dsi_plan WHERE phase = 1 AND finished_at IS NOT NULL")] as any[]).map((r) => String(r.source)))
      return sources.filter((s) => !finished.has(s))
    },

    /** The current index as one document (sources → tables → fields), for a screen to download whole. */
    document() {
      const out = new Map<string, { source: string; tables: Map<string, any> }>()
      for (const i of ([...sql.exec('SELECT * FROM dsi_items ORDER BY source, tbl, field')] as any[]).map(toItem)) {
        const s = out.get(i.source) ?? out.set(i.source, { source: i.source, tables: new Map() }).get(i.source)!
        const t = s.tables.get(i.table) ?? s.tables.set(i.table, { table: i.table, fields: [] as any[] }).get(i.table)
        const shown = { description: descriptionOf(i), descSource: i.descSource, descHuman: i.descHuman, descAi: i.descAi, enabled: i.enabled, enabledBy: i.enabledBy, gone: i.gone }
        if (i.field === '') Object.assign(t, { rows: i.rows, ...shown })
        else t.fields.push({ field: i.field, type: i.type, optional: i.optional, key: i.key, references: i.references, ...shown })
      }
      return [...out.values()].map((s) => ({ source: s.source, tables: [...s.tables.values()] }))
    },
  }
}

