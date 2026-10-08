// ── LINEAGE: a map of how the data flows, kept by the platform ──────────────────────────────────────────────────────────
//
// Not a pipeline — the pipelines run elsewhere; this is what they (and the sources, people, agents and our own reads)
// tell us about them: datasets, and "made from" edges between them, each with how and who said so. Read as a whole map
// (lineage:map) or around one dataset. An edge is never changed: one that stops being true is removed (when, by whom).
//
// A dataset's id says what it is:
//   source:<SOURCE>/<table>        a connected source's table (the data source index names them)
//   warehouse:<namespace>.<table>  a table of the organisation's warehouse
//   ol:<namespace>/<name>          a dataset a pipeline named (OpenLineage), until it is matched to one of ours
//   job:<namespace>/<name>         a pipeline's job (OpenLineage): what turns its inputs into its outputs
//   program:<name> · agent:<name>  what reads the data here
//
// Who said an edge (said_by): pipeline (an OpenLineage event) · source (read from it: a view's definition) · person ·
// agent · usage (our own reads, recorded by the datasource manager). Filled in now: a person's or agent's word and
// pipelines' events; the source's views and our own reads are planned, and land here the same way.
//
//   lineage:map {}                                 → { datasets, edges }
//   lineage:declare { edges: [{ from, to, how? }] } → { added }       (a person or an agent)
//   lineage:remove { id }                          → { removed }
//   POST /lineage/openlineage   an OpenLineage RunEvent (a pipeline, with a project key)

type Storage = DurableObjectStorage

export class LineageRefusal extends Error {}

export const DATASET_KINDS = ['source', 'warehouse', 'ol', 'job', 'program', 'agent'] as const
export const SAID_BY = ['pipeline', 'source', 'person', 'agent', 'usage'] as const
type SaidBy = (typeof SAID_BY)[number]

/** A dataset id as this map names it, or a refusal saying why it is not one. */
export function datasetId(raw: unknown): { id: string; kind: string } {
  const id = String(raw ?? '').trim()
  const m = /^([a-z]+):(.{1,300})$/.exec(id)
  if (!m || !(DATASET_KINDS as readonly string[]).includes(m[1]!)) throw new LineageRefusal(`"${id.slice(0, 80)}" is not a dataset: name it ${DATASET_KINDS.map((k) => `${k}:…`).join(', ')}`)
  return { id, kind: m[1]! }
}

export function projectLineage(storage: Storage, now: () => number = Date.now) {
  const sql = storage.sql
  const iso = () => new Date(now()).toISOString()
  const seen = (id: string, kind: string, title?: string) => {
    sql.exec('INSERT INTO lineage_datasets (id, kind, title, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET last_seen = excluded.last_seen, title = COALESCE(excluded.title, lineage_datasets.title)',
      id, kind, title ?? null, iso(), iso())
  }
  /** An edge said again only freshens it; a new one is added. */
  function edge(from: string, to: string, how: string | null, saidBy: SaidBy, who: string | null): boolean {
    const [live] = [...sql.exec('SELECT id FROM lineage_edges WHERE from_ds = ? AND to_ds = ? AND said_by = ? AND removed_at IS NULL', from, to, saidBy)] as any[]
    if (live) { sql.exec('UPDATE lineage_edges SET last_seen = ?, how = COALESCE(?, how) WHERE id = ?', iso(), how, live.id); return false }
    sql.exec('INSERT INTO lineage_edges (from_ds, to_ds, how, said_by, who, at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)', from, to, how, saidBy, who, iso(), iso())
    return true
  }

  return {
    /** The whole map as it is now. */
    map(): { datasets: unknown[]; edges: unknown[] } {
      const datasets = [...sql.exec('SELECT id, kind, title, first_seen AS firstSeen, last_seen AS lastSeen FROM lineage_datasets ORDER BY id')]
      const edges = [...sql.exec('SELECT id, from_ds AS "from", to_ds AS "to", how, said_by AS saidBy, who, at, last_seen AS lastSeen FROM lineage_edges WHERE removed_at IS NULL ORDER BY id')]
      return { datasets, edges }
    },

    /** Edges a person or an agent says are true. */
    declare(p: { edges?: unknown }, who: string, saidBy: 'person' | 'agent'): { added: number } {
      const list = Array.isArray(p.edges) ? p.edges : []
      if (!list.length || list.length > 200) throw new LineageRefusal('declare 1–200 edges: [{ from, to, how? }]')
      let added = 0
      storage.transactionSync(() => {
        for (const e of list as any[]) {
          const from = datasetId(e?.from), to = datasetId(e?.to)
          if (from.id === to.id) throw new LineageRefusal(`${from.id} cannot be made from itself`)
          seen(from.id, from.kind); seen(to.id, to.kind)
          if (edge(from.id, to.id, typeof e?.how === 'string' ? e.how.slice(0, 500) : null, saidBy, who)) added++
        }
      })
      return { added }
    },

    /** One edge, no longer true. */
    remove(p: { id?: unknown }, who: string): { removed: number } {
      const id = Number(p.id)
      const [r] = [...sql.exec('SELECT removed_at FROM lineage_edges WHERE id = ?', id)] as any[]
      if (!r) throw new LineageRefusal(`there is no edge ${p.id}`)
      if (r.removed_at) throw new LineageRefusal(`edge ${id} was already removed`)
      sql.exec('UPDATE lineage_edges SET removed_at = ?, removed_by = ? WHERE id = ?', iso(), who, id)
      return { removed: id }
    },

    /** An OpenLineage RunEvent: the job, and each input → job → output it names. Events of a run that has not completed
     *  say what it reads and writes too, so any event counts. */
    openLineage(ev: any, who: string): { job: string; added: number } {
      const jobNs = String(ev?.job?.namespace ?? ''), jobName = String(ev?.job?.name ?? '')
      if (!jobNs || !jobName) throw new LineageRefusal('an OpenLineage event names its job: { job: { namespace, name } }')
      const ds = (d: any) => { const ns = String(d?.namespace ?? ''), name = String(d?.name ?? ''); if (!ns || !name) throw new LineageRefusal('each input and output names its namespace and name'); return `ol:${ns}/${name}` }
      const inputs = (Array.isArray(ev?.inputs) ? ev.inputs : []).map(ds), outputs = (Array.isArray(ev?.outputs) ? ev.outputs : []).map(ds)
      if (inputs.length + outputs.length > 500) throw new LineageRefusal('an event names at most 500 datasets')
      const job = `job:${jobNs}/${jobName}`
      let added = 0
      storage.transactionSync(() => {
        seen(job, 'job', jobName)
        for (const i of inputs) { seen(i, 'ol'); if (edge(i, job, null, 'pipeline', who)) added++ }
        for (const o of outputs) { seen(o, 'ol'); if (edge(job, o, null, 'pipeline', who)) added++ }
      })
      return { job, added }
    },
  }
}
