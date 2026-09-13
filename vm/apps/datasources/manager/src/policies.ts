// ── ACCESS POLICIES: WHAT THE PERSON ASKING MAY READ ────────────────────────────────────────────────────────
//
// Chosen here, applied in the SQL rewrite (sqlrewrite/worker.py) — so a restriction holds for every query to a
// source whoever wrote it: an agent, a program, a concept. The caller never sees the policies, only the result.
//
// policies.json, keyed by source:
//
//   { "F5NETSUITE": [
//       { "table": "employee", "predicate": "{t}.subsidiary IN (3, 5)", "when": { "who.groups": "nz" } },
//       { "table": "salary",   "deny": true, "reason": "pay is confidential", "when": { "who.department": "sales" } },
//       { "table": "timebill", "predicate": "{t}.isinactive = 'F'" } ] }
//
// EVERY policy that applies to the person applies — the "all" combination in the graph's rules. A more specific
// rule never loosens a general one: restrictions add up, and a denial anywhere is a denial. A policy with no
// `when` applies to everyone, including a query that says nothing about who is asking.
//
// The cache is unaffected by design: its key is the rewritten SQL, which contains the policies.

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { allThatApply, facts } from '../../../../packages/graph/src/rules.ts'

type Policy = { table?: string; predicate?: string; deny?: boolean; reason?: string; when?: Record<string, any> }

const FILE = process.env.POLICIES_FILE ?? join(process.env.DATASOURCE_DATA_DIR ?? join(import.meta.dirname, '..', '.data'), 'policies.json')
let loaded: { mtime: number; bySource: Record<string, Policy[]> } | null = null

/** Read again whenever the file changes, so a policy edit applies to the next query without a restart. */
async function load(): Promise<Record<string, Policy[]>> {
  let mtime: number
  try { mtime = (await stat(FILE)).mtimeMs } catch { return {} }
  if (!loaded || loaded.mtime !== mtime) loaded = { mtime, bySource: JSON.parse(await readFile(FILE, 'utf8')) }
  return loaded.bySource
}

export async function policiesFor(source: string, who: Record<string, unknown> | undefined): Promise<Policy[]> {
  const all = (await load())[source] ?? []
  return allThatApply(all, facts(who)).map(({ when: _when, ...policy }) => policy)
}
