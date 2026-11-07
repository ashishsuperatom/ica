// THE ENGINE'S ANSWERS TO AN AGENT'S KNOWLEDGE TOOLS (tool-socket.ts): what the data sources hold (find-schema,
// get-schema) and what the project knows (find-concept), answered here from the engine's own databases — which no agent
// opens. Each is answered for whoever the turn's ticket is: what their policies hide is not shown to them. The text is
// what the tool prints, as it always has.

import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { searchDataSource, getSchema, type DataSourceIndex } from '@superatom/datasource-index'

/** A checked ticket: whose work it is and their policies, with the ticket itself (to read the sources as them). */
export interface Checked { raw: string; /** Whose work it is (the person's id). */ principal?: string; policies: Record<string, unknown[]>; /** Which of a session's agents works the turn, when one does. */ agent?: string | null }

/** The tables a ticket's policies hide: "SOURCE.table" in lower case. */
export function hiddenBy(policies: Record<string, unknown[]>): Set<string> {
  const out = new Set<string>()
  for (const [src, list] of Object.entries(policies ?? {})) for (const x of (list ?? []) as any[]) if (x && x.deny && x.table) out.add(`${src}.${String(x.table).split('.').pop()}`.toLowerCase())
  return out
}

/** Why a session's agent may not use a tool, or null: each is given its role's tools (the graph's role concept); a ticket
 *  that names no agent (a builder, a program) is answered by its policies alone. */
export function refusedFor(tool: string, agent: string | null | undefined, toolsOf: (agent: string) => string[] | null): string | null {
  if (!agent) return null
  const mine = toolsOf(agent)
  if (!mine || mine.includes(tool)) return null
  return `${tool} is not one of the ${agent}'s tools${agent === 'composer' ? ' — hand the question to the analyst' : ''}`
}

export function agentTools(d: { index: DataSourceIndex; graphFile: string; manager: string }) {
  /** The data sources, as the manager says them to this reader. */
  const sourcesFor = async (t: Checked): Promise<any[]> => {
    const r = await fetch(`${d.manager}/sources`, { headers: { 'x-sa-ticket': t.raw } })
    const b: any = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(b?.error ?? `the sources could not be read (${r.status})`)
    return b.sources ?? []
  }
  const argv = (a: unknown): string[] => (Array.isArray(a) ? a.map(String) : [])
  // ONE CONNECTION to the knowledge, kept open between questions — opened again only when the replica's file is a new
  // one (it is set aside and rebuilt when it disagrees with the platform's).
  let graph: { db: DatabaseSync; ino: number } | null = null
  const graphDb = (): DatabaseSync | null => {
    let ino: number
    try { ino = statSync(d.graphFile).ino } catch { return null }
    if (graph && graph.ino === ino) return graph.db
    try { graph?.db.close() } catch { /* already closed */ }
    try { graph = { db: new DatabaseSync(d.graphFile, { readOnly: true }), ino } } catch { graph = null }
    return graph?.db ?? null
  }

  async function findSchema(args: unknown, t: Checked): Promise<string> {
    const a = argv(args)
    const full = a.includes('--full')
    const si = a.indexOf('--source')
    const source = si >= 0 ? a[si + 1] : undefined
    const skip = si >= 0 ? si + 1 : -1
    const q = a.filter((x, i) => x !== '--full' && x !== '--source' && i !== skip).join(' ').trim()
    if (!q) return JSON.stringify({ hint: 'find-schema "<term>" [--source <SOURCE>] [--full] — search every datasource for a field/table by name, type, or description' })
    const r = searchDataSource(d.index, q, { source, limit: full ? 40 : 60 })
    // What this reader may not read is not shown to them (their ticket's policies).
    const hidden = hiddenBy(t.policies)
    if (hidden.size) {
      const keep = (e: any) => { const [s, tb] = String(e.key).split('.'); return !hidden.has(`${s}.${tb}`.toLowerCase()) }
      const gone = r.entries.filter((e: any) => !keep(e))
      r.entries = r.entries.filter(keep); r.shown -= gone.length; r.matched -= gone.length
      for (const e of gone) { const s = String((e as any).key).split('.')[0]; if (r.bySource[s]) r.bySource[s]--; if (!r.bySource[s]) delete r.bySource[s] }
    }
    const view = (e: any) => (full ? e : `${e.key} : ${e.type || '?'}${e.isKey ? ' [PK]' : ''}${e.references ? ` → ${e.references}` : ''}`)
    // THE SOURCES COME FIRST: a field is written against a source, in its own language — which they are, and what kind.
    const known = await sourcesFor(t).catch(() => [])
    const sources = Object.keys(r.bySource).map((id) => { const k: any = known.find((x: any) => x.id === id) ?? {}; return { source: id, kind: k.kind, dialect: k.dialect, fields: r.bySource[id], about: k.description } })
    // SAY WHAT WAS NOT SHOWN: a bounded slice must read as one.
    const spread = Object.entries(r.bySource).map(([s, n]) => `${s}:${n}`).join(' · ')
    return JSON.stringify({ sources, fields: r.entries.map(view), shown: r.shown, matched: r.matched, bySource: r.bySource,
      note: r.shown < r.matched ? `showing ${r.shown} of ${r.matched} matching fields (${spread}) — narrow the term, or scope with --source <SOURCE>` : `all ${r.matched} matching fields` }, null, 2)
  }

  async function getSchemaOf(args: unknown, t: Checked): Promise<string> {
    const [source, table] = argv(args)
    const hidden = hiddenBy(t.policies)
    if (source && table && hidden.has(`${source}.${String(table).split('.').pop()}`.toLowerCase())) throw new Error(`you are not allowed to read ${table}`)
    const out: any = getSchema(d.index, source, table)
    if (source && !table && hidden.size && Array.isArray(out.tables)) out.tables = out.tables.filter((x: any) => !hidden.has(`${source}.${String(x.table).split('.').pop()}`.toLowerCase()))
    // A source read with each person's own key: its index was built with a shared account, so its row counts are not theirs.
    const perUser = new Set((await sourcesFor(t).catch(() => [])).filter((x: any) => x.perUser).map((x: any) => x.id))
    if (source && perUser.has(source)) {
      if (Array.isArray(out.tables)) for (const x of out.tables) x.rows = null
      if ('rows' in out) out.rows = null
      out.note = `${source} reads with each person's own key: its row counts are not shown here — count with a query`
    }
    return JSON.stringify(out, null, 2)
  }

  /** The project's written knowledge, every domain's concepts, at the version the session reads (`graph`: its pin). */
  async function findConcept(args: unknown): Promise<string> {
    const a: any = args && typeof args === 'object' && !Array.isArray(args) ? args : { words: argv(args).join(' ') }
    const q = String(a.words ?? '').trim()
    if (!q) return JSON.stringify({ hint: "find-concept '<words>' — search every domain's concepts when your own do not cover the question" })
    const db = graphDb()
    if (!db) return JSON.stringify({ concepts: [], note: 'the knowledge is not here yet' })
    {
      const pin = typeof a.graph === 'string' && a.graph ? a.graph : null
      const upto = pin === 'draft' ? null
        : pin ? ((db.prepare('SELECT upto FROM version WHERE name = ?').get(pin) as any)?.upto ?? null)
        : ((db.prepare('SELECT upto FROM version ORDER BY upto DESC, id DESC LIMIT 1').get() as any)?.upto ?? null)
      const rows: any[] = upto === null
        ? db.prepare("SELECT n.name, c.body FROM name n JOIN content c ON c.hash = n.hash WHERE n.kind = 'concept' AND COALESCE(n.scope, 'global') = 'global'").all()
        : db.prepare("SELECT ch.name, c.body FROM change ch JOIN content c ON c.hash = ch.to_hash WHERE ch.kind = 'concept' AND COALESCE(ch.scope, 'global') = 'global' AND ch.id = (SELECT max(id) FROM change WHERE name = ch.name AND id <= ?)").all(upto)
      const words = (s: string) => String(s).toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []
      const docs = rows.map((r) => {
        let b: any = {}; try { b = JSON.parse(String(r.body)) } catch { /* not a body */ }
        const text = [b.title, ...(Array.isArray(b.uses) && b.uses.length ? [`Builds on: ${b.uses.join(', ')}`] : []), b.text, ...(Array.isArray(b.items) ? b.items : []),
          ...(Array.isArray(b.sections) ? b.sections.flatMap((x: any) => [`[${x.name}]`, x.text, ...(Array.isArray(x.items) ? x.items : [])]) : [])].filter(Boolean).join('\n')
        return { name: String(r.name), title: b.title ?? r.name, text, bag: new Set(words(`${r.name} ${text}`)) }
      })
      // A word in few concepts says more about which one is meant than a word in many.
      const terms = [...new Set(words(q))]
      const idf = Object.fromEntries(terms.map((w) => [w, Math.log(1 + docs.length / (1 + docs.filter((x) => x.bag.has(w)).length))]))
      const ranked = docs.map((x) => ({ x, score: terms.reduce((s, w) => s + (x.bag.has(w) ? idf[w] : 0), 0) })).filter((r) => r.score > 0).sort((p, q2) => q2.score - p.score).slice(0, 6)
      return JSON.stringify({ concepts: ranked.map(({ x, score }) => ({ name: x.name, title: x.title, score: +score.toFixed(2), text: x.text })),
        note: ranked.length ? `the best ${ranked.length} of ${docs.length} concepts for these words` : 'no concept matches these words' }, null, 2)
    }
  }

  return { 'find-schema': findSchema, 'get-schema': getSchemaOf, 'find-concept': findConcept }
}
