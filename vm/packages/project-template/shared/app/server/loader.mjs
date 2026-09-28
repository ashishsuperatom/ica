// The capabilities, read from their folders and checked before any of them can be asked.
//
// A capability is one folder under capabilities/ with an index.mjs exporting `default`:
//
//   focus       its name — what a question's `focus` says
//   label       what a person calls it
//   whenToUse   one sentence for a person or a model deciding what to open
//   scenario    which root it belongs with (a thread starts at a root)
//   root        true for the three starting points
//   honours     the dimensions a question may filter by
//   by          the dimensions it may be broken down by (optional)
//   lenses      how it may be drawn (default: table)
//   window      { kind, default? } — the time it is over (optional); default may be a function of today
//   assume      { name: default } — the what-ifs it takes (optional)
//   start       { where } — the filters it opens with (optional)
//   facts       the facts (the domains' programs) it reads — every dimension it honours is carried by one of them
//   answer      async (q, ctx) => { title, blocks[], notes[] }
//   next        (q, answer) => [{ label, ops[] }]
//
// The checks at load: every focus once; every dimension named exists; every lens known; the window kind known;
// the assumptions declared with defaults; the facts it names exist and carry what it honours.

import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DIMENSION, carries } from './dimensions.mjs'
import { FACTS } from './facts.mjs'
import { WINDOWS } from './windows.mjs'

const LENSES = new Set(['table', 'bars', 'ring', 'tree', 'grid', 'tiles'])

export async function loadCapabilities(dir, ctx, { fresh = false } = {}) {
  const problems = []
  const capabilities = new Map()
  if (!existsSync(dir)) return { capabilities, problems: [`no capabilities folder at ${dir}`] }
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const file = join(dir, name, 'index.mjs')
    if (!existsSync(file)) { problems.push(`${name}: no index.mjs`); continue }
    let cap
    try { cap = (await import(`${pathToFileURL(file).href}${fresh ? `?t=${Date.now()}` : ''}`)).default }
    catch (e) { problems.push(`${name}: cannot load — ${e.message}`); continue }
    const at = (m) => problems.push(`${name}: ${m}`)
    if (!cap || typeof cap !== 'object') { at('exports no default object'); continue }
    if (cap.focus !== name) at(`its focus "${cap.focus}" is not its folder name`)
    if (capabilities.has(cap.focus)) at(`focus "${cap.focus}" is declared twice`)
    if (!cap.label) at('has no label')
    if (!cap.whenToUse) at('says nothing about when to use it')
    for (const k of cap.honours ?? []) if (!DIMENSION.has(k)) at(`honours a dimension that does not exist: "${k}"`)
    for (const k of cap.by ?? []) { if (!DIMENSION.has(k)) at(`breaks down by a dimension that does not exist: "${k}"`); else if (!DIMENSION.get(k).byOnly && !(cap.honours ?? []).includes(k)) at(`breaks down by "${k}" but does not honour it`) }
    for (const k of cap.honours ?? []) if (DIMENSION.get(k)?.byOnly) at(`honours "${k}", which is a period of the window and never a filter`)
    for (const l of cap.lenses ?? []) if (!LENSES.has(l)) at(`has a lens nobody can draw: "${l}"`)
    if (cap.window && !WINDOWS[cap.window.kind]) at(`has a window of unknown kind "${cap.window.kind}"`)
    if (cap.window?.default && typeof cap.window.default !== 'function') { const p = WINDOWS[cap.window.kind]?.check?.(cap.window.default, undefined); if (p) at(`its default window is wrong: ${p}`) }
    // A default that is a function may be async and may ask where the data is; here it is made without the programs, so only its shape is checked.
    if (typeof cap.window?.default === 'function') { try { const d = await cap.window.default(ctx?.today ?? new Date().toISOString().slice(0, 10), undefined, undefined); const p = d === undefined ? null : WINDOWS[cap.window.kind]?.check?.(d, undefined); if (p) at(`its default window is wrong: ${p}`) } catch (e) { at(`its default window cannot be made: ${e.message}`) } }
    // An assumption is a number a what-if turns (a rate, a share, a count of weeks) — never a grouping, a lens or a window option.
    for (const [k, v] of Object.entries(cap.assume ?? {})) { if (v === undefined) at(`assumption "${k}" has no default`); else if (v !== null && typeof v !== 'number') at(`assumption "${k}" is not a number: an assumption is a number a what-if turns, never a grouping, a lens or a window option`) }
    for (const f of cap.start?.where ?? []) if (!(cap.honours ?? []).includes(f.dim)) at(`starts filtered by "${f.dim}", which it does not honour`)
    // A view on the domains' programs names the facts it reads; every dimension it honours must be carried by one of them.
    {
      if (!Array.isArray(cap.facts) || !cap.facts.length) at('names no facts')
      for (const f of cap.facts ?? []) if (!FACTS[f]) at(`reads a fact that does not exist: "${f}"`)
      for (const k of cap.honours ?? []) if (DIMENSION.has(k) && !(cap.facts ?? []).some((f) => carries(k, f))) at(`honours "${k}", which none of its facts (${(cap.facts ?? []).join(', ')}) carries`)
    }
    if (typeof cap.answer !== 'function') at('has no answer()')
    if (typeof cap.next !== 'function') at('has no next()')
    capabilities.set(cap.focus, { lenses: ['table'], honours: [], by: [], ...cap })
  }
  return { capabilities, problems }
}

/** What a client needs to draw the catalog: nothing executable. */
export function catalogOf(model) {
  return {
    dimensions: [...DIMENSION.values()].map(({ key, label, plural, grain, within, means, kind, members, byOnly }) => ({ key, label, plural, grain, within, means, kind, entity: members?.list ?? members?.search, ...(byOnly ? { byOnly: true } : {}), ...(members ? { searchable: true } : {}) })),
    capabilities: [...model.capabilities.values()].map((c) => ({ focus: c.focus, label: c.label, whenToUse: c.whenToUse, scenario: c.scenario, root: !!c.root, honours: c.honours, by: c.by, lenses: c.lenses, window: c.window, assume: c.assume, start: c.start, open: c.open ?? null, facts: c.facts ?? null })),
    windows: Object.fromEntries(Object.entries(WINDOWS).map(([k, w]) => [k, { note: w.note ?? null }])),
    // The financial years a window can be set to, by name, in order.
    financialYears: (model.calendars?.FinancialYear ?? []).map((y) => y.label),
  }
}
