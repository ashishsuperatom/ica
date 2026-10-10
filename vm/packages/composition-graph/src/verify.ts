// ── Verify: the graph holds together, and holds what the project wrote ──────────────────────────────────────────
//
// What a graph must be for an agent composed from it to work, checked without running anything:
//   · every domain names concepts, files and settings the graph holds, of the right kind, and composes;
//   · every file a domain places imports only files placed beside it (or the data seam, data/…), and no two files a
//     domain places share a name;
//   · every setting a file reads is one its domain gives it (a program stops on a missing setting);
//   · nothing is left over that no domain uses (a warning: it may be on its way in or out).
// Against the project's written knowledge (knowledge/index.mts), the graph must be exactly what importing it gives:
// a node that differs, or one the knowledge no longer writes, is the graph and the files disagreeing.

import { Store } from './store.js'
import { compose, conceptsOf, isComposed, EXAMPLES_SECTION, type ConceptBody, type DomainBody, type FileBody } from './compose.js'
import { importDomains, type WrittenDomain, type WrittenSetting } from './import.js'

export interface Finding { level: 'fail' | 'warn'; check: string; subject: string; says: string }

const base = (n: string) => n.slice(n.lastIndexOf('/') + 1)

export function verifyGraph(store: Store): Finding[] {
  const out: Finding[] = []
  const fail = (check: string, subject: string, says: string) => out.push({ level: 'fail', check, subject, says })
  const warn = (check: string, subject: string, says: string) => out.push({ level: 'warn', check, subject, says })
  const all = store.names()
  const kindOf = new Map(all.map((n) => [n.name, n.kind]))
  const settingNames = all.filter((n) => n.kind === 'setting').map((n) => n.name)
  const used = new Set<string>()
  const domains = all.filter((n) => n.kind === 'domain')
  if (!domains.length) fail('domains', '(graph)', 'the graph holds no domain')
  for (const d of domains) {
    const body = store.get<DomainBody>(d.name)!.body
    if (!body.description?.trim()) warn('described', d.name, 'the domain says nothing about what it is for')
    if (!body.intents?.length) warn('routed', d.name, 'the domain has no intents: only its text can route a question to it')
    for (const [list, kind] of [[conceptsOf(body), 'concept'], [body.files ?? [], 'file'], [body.settings ?? [], 'setting']] as const) {
      for (const n of list) {
        used.add(n)
        if (!kindOf.has(n)) fail('links', d.name, `names ${kind} "${n}", which the graph does not hold`)
        else if (kindOf.get(n) !== kind) fail('links', d.name, `names "${n}" as a ${kind}; it is a ${kindOf.get(n)}`)
      }
    }
    try { compose(store, d.name) } catch (e) { fail('composes', d.name, `does not compose: ${(e as Error).message}`) }
    // The files as they are placed in an agent's folder: by file name, beside each other and the data seam.
    const files = (body.files ?? []).map((n) => ({ node: n, file: store.get<FileBody>(n)?.body })).filter((x) => x.file)
    const names = new Map<string, string>()
    for (const { node, file } of files) {
      const b = base(file!.name)
      if (names.has(b)) fail('placed', d.name, `places two files named ${b}: "${names.get(b)}" and "${node}"`)
      names.set(b, node)
    }
    for (const { node, file } of files) {
      for (const m of file!.text.matchAll(/(?:from|import)\s*\(?\s*['"]\.\/([^'"]+)['"]/g)) {
        const target = m[1]
        if (target.startsWith('data/') || target.startsWith('grounding/')) continue
        if (!names.has(base(target))) fail('imports', d.name, `${base(node)} imports ./${target}, which the domain does not place`)
      }
      for (const s of settingNames) {
        if (!new RegExp(`['"\`]${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(file!.text)) continue
        if (!(body.settings ?? []).includes(s)) fail('settings', d.name, `${base(node)} reads the setting "${s}", which the domain does not give it`)
      }
    }
  }
  for (const n of all) if (n.kind !== 'domain' && !used.has(n.name)) warn('used', n.name, `a ${n.kind} no domain uses`)
  out.push(...conceptRules(store, domains.map((d) => d.name)))
  return out
}

// ── The rules for writing concepts (guide.ts), as far as they can be checked without reading for meaning ──
const INSTANCE = [
  /\b[A-Z]{2,}-\d{2,}\b/,                    // an id: CODE-0012
  /\b(?:19|20)\d{2}-\d{2}-\d{2}\b/,          // a date
  /[₹$€£]\s?\d/,                              // an amount
  /\b\d{1,3}(?:,\d{2,3}){1,}\b|\b\d{5,}\b/,   // a large number
]
const FULL_QUERY = /\bselect\b[\s\S]{1,400}?\bfrom\b/i
const said = (t: string) => t.toLowerCase().replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim()

/** What a concept says outside its examples, line by line. */
function linesOf(b: ConceptBody): string[] {
  switch (b.form) {
    case 'sections': return b.sections.filter((x) => x.name.toLowerCase() !== EXAMPLES_SECTION).flatMap((x) => [...(x.text ?? '').split('\n'), ...(x.items ?? [])])
    case 'text': return b.text.split('\n')
    case 'bullets': case 'numbered': return b.items
    default: return []   // worked examples are examples; a composed concept says nothing of its own
  }
}

function conceptRules(store: Store, domains: string[]): Finding[] {
  const out: Finding[] = []
  const warn = (check: string, subject: string, says: string) => out.push({ level: 'warn', check, subject, says })
  const concepts = store.names('concept').map((n) => ({ name: n.name, body: store.get<ConceptBody>(n.name)!.body }))
  const byName = new Map(concepts.map((c) => [c.name, c.body]))
  const where = new Map<string, string[]>()   // a line said, and the concepts that say it
  for (const c of concepts) {
    const lines = linesOf(c.body)
    const hit = lines.find((l) => INSTANCE.some((r) => r.test(l)))
    if (hit) warn('generic', c.name, `holds an instance outside its examples — say it generically: "${hit.trim().slice(0, 80)}"`)
    if (FULL_QUERY.test(lines.join('\n'))) warn('logic', c.name, 'holds a full query — write the logic as a pseudo-query')
    for (const l of new Set(lines.map(said).filter((l) => l.length >= 40))) where.set(l, [...(where.get(l) ?? []), c.name])
    if (c.body.form === 'sections') for (const u of c.body.uses ?? []) if (!byName.has(u)) out.push({ level: 'fail', check: 'uses', subject: c.name, says: `builds on "${u}", which the graph does not hold` })
  }
  for (const [l, names] of where) if (names.length > 1) warn('atomic', names.join(', '), `say it once, in one concept the others use: "${l.slice(0, 80)}"`)
  for (const d of domains) {
    const body = store.get<DomainBody>(d)!.body
    const top = conceptsOf(body)
    const composed = top.flatMap((n) => { const b = byName.get(n); return b && isComposed(b) ? [n, ...b.concepts] : [n] })
    const mapped = composed.some((n) => { const b = byName.get(n); return b?.form === 'sections' && b.sections.some((x) => x.name.toLowerCase() === 'entity map') })
    if (!mapped) warn('mapped', d, 'no concept it composes draws an entity map')
    for (const n of composed) {
      const b = byName.get(n)
      if (b?.form === 'sections') for (const u of b.uses ?? []) if (byName.has(u) && !composed.includes(u)) warn('uses', d, `composes "${n}" without "${u}", which it builds on`)
    }
  }
  return out
}

/** The graph against the project's written knowledge: every node importing it would write must be there, the same. */
export function verifyAgainst(store: Store, domains: WrittenDomain[], readFile: (domain: string, file: string) => string, settings: WrittenSetting[] = [], scratch: () => Store): Finding[] {
  const out: Finding[] = []
  const written = scratch()
  try {
    let imported
    try { imported = importDomains(written, domains, readFile, { by: 'verify' }, settings) }
    catch (e) { return [{ level: 'fail', check: 'written', subject: '(knowledge)', says: `the written knowledge does not import: ${(e as Error).message}` }] }
    const names = new Set(imported.map((x) => x.name))
    for (const x of imported) {
      const held = store.get(x.name)
      if (!held) out.push({ level: 'fail', check: 'in sync', subject: x.name, says: `the knowledge writes this ${x.kind}; the graph does not hold it — import the knowledge` })
      else if (held.hash !== x.hash) out.push({ level: 'fail', check: 'in sync', subject: x.name, says: `the graph holds ${held.hash.slice(0, 10)}, the knowledge writes ${x.hash.slice(0, 10)} — import the knowledge, or the graph was changed by hand` })
    }
    for (const n of store.names()) if (!names.has(n.name)) out.push({ level: 'warn', check: 'in sync', subject: n.name, says: `the graph holds this ${n.kind}; the knowledge no longer writes it — remove it, or write it again` })
  } finally { written.close() }
  return out
}
