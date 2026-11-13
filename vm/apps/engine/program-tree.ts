// THE PROGRAMS IN THE TOOL TREE (platform-types tools.ts; docs/programs-design.md): `./inspect programs…` reads the
// project's programs the way it reads the platform's tools — a program, its functions, how each is run. Made for the
// person asking, never stored: every program's newest published build, and this person's own newer build of it (their
// draft) when they have one. A library is no program to run; it is left out.

import type { ToolCard } from '@superatom/platform-types'
import { specOf, type ProgramStore } from '@superatom/programs'

export interface CatalogueRow { hash: string; name: string; uploaded_at: string; published_at: string | null; built_by?: string }

/** Which build of each program this person reads: the newest published, or their own newer draft. */
export function buildsFor(rows: CatalogueRow[], person: string | null): { name: string; hash: string; draft: boolean }[] {
  const out = new Map<string, { name: string; hash: string; draft: boolean; at: string }>()
  for (const r of [...rows].sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))) {
    const mine = !!person && r.built_by === person && !r.published_at
    if (!r.published_at && !mine) continue
    const had = out.get(r.name)
    if (!had) out.set(r.name, { name: r.name, hash: r.hash, draft: !r.published_at, at: r.uploaded_at })
  }
  return [...out.values()].map(({ at: _at, ...x }) => x)
}

const PRODUCES: Record<string, string> = { view: 'a step: its answer, blocks and STATE', data: 'JSON, to whoever called it', action: 'a change outside STATE, once it is approved' }
const fieldWords = (f: unknown): string => typeof f === 'string' ? f : f && typeof f === 'object' ? ('nullable' in f ? `${fieldWords((f as any).nullable)}, may be left out` : 'enum' in f ? `one of ${(f as any).enum.join(', ')}` : 'list' in f ? `a list of ${fieldWords((f as any).list)}` : 'object') : String(f)
const firstLine = (doc: string) => doc.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''

/** The cards of the programs a person reads: one per program, one per function it offers. */
export function programCards(builds: { name: string; hash: string; draft: boolean }[], store: ProgramStore): ToolCard[] {
  const out: ToolCard[] = []
  for (const b of builds) {
    if (!store.has(b.hash)) continue
    const m = store.manifest(b.hash)
    const p = m.kind === 'library' ? null : specOf(store, b.hash)
    if (!p) continue
    let doc = ''
    try { doc = store.doc(b.hash) } catch { /* a build with no doc */ }
    const state = Object.entries(p.schema).map(([k, f]) => `${k} (${fieldWords(f)})`).join(', ')
    out.push({ name: `programs.${m.name}`, title: m.name, summary: `${m.summary ?? (firstLine(doc) || 'a program')}${b.draft ? ' — your draft, not published' : ''}`,
      when: doc.trim() || 'Its doc says nothing yet.',
      how: [`Its STATE (${p.owns}): ${state || 'none'}.`, ...(p.filters?.length ? [`Its filters: ${p.filters.map((f) => f.label).join(', ')}.`] : [])] })
    for (const f of p.functions) {
      const params = Object.entries(f.params ?? {})
      const example = `{${params.filter(([, t]) => !(t && typeof t === 'object' && 'nullable' in t)).map(([k]) => `"${k}":…`).join(',')}}`
      out.push({ name: `programs.${m.name}.${f.name}`, title: `${m.name}.${f.name}`, summary: f.doc ?? (f.name === 'run' ? 'its view, as it stands' : f.name),
        input: `./run-program ${m.name}.${f.name} '${example}'`, output: PRODUCES[f.produces] ?? f.produces,
        when: f.doc ?? (f.name === 'run' ? 'To show the program as it stands for the STATE given.' : `When ${f.name} is what is asked.`),
        how: params.length ? params.map(([k, t]) => `${k}: ${fieldWords(t)}`) : ['It takes no params.'] })
    }
    // What it draws (web.json): each view, where it sits, what it shows and the moves it makes.
    const w = store.views(b.hash)
    if (w?.views.length) {
      out.push({ name: `programs.${m.name}.views`, title: `${m.name}'s views`, summary: `what ${m.name} draws: ${w.views.map((v) => v.name).join(', ')}`, when: w.as === 'ui' ? 'Drawn alone, the full width: a UI of its own.' : 'Drawn in a step, with its answer.' })
      for (const v of w.views) out.push({ name: `programs.${m.name}.views.${v.name}`, title: v.name, summary: v.doc ?? v.name, input: `${v.place === 'head' ? 'above' : 'with'} the step's answer`,
        when: v.doc ?? v.name,
        how: [`It shows: ${v.reads.length ? v.reads.join(', ') : 'nothing of its STATE by name'}.`, `Its moves: ${v.sends.length ? v.sends.map((x) => ('call' in x ? `calls ${x.call}` : 'set' in x ? `sets ${x.set}` : 'add' in x ? `adds to ${x.add}` : `removes from ${x.remove}`)).join('; ') : 'none'}.`] })
    }
  }
  return out
}
