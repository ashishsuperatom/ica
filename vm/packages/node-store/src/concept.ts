// CONCEPTS — the semantic model as a term registry, on the same node-store.
//
// One entity = one concept (kind='concept') bound to ONE big parameterised unit;
// its measures / dimensions / filters are PARAMETERS to that unit (pass different
// params, get a different view — no splitting by code size for now). The concept
// carries the facets borrowed from the benchmark: status ("green"), grain, time +
// asOf (freshness), measures, dimensions, parameters, rules, identity, source.
//
// Relationships are edges (`relates`) carrying cardinality + coverage (the green/
// weak badge). Concepts are mutable identities over IMMUTABLE units — the modeler
// rearranges this layer (merge/split/rebind/promote); units never change.

import type { NodeStore, Node } from './store.js'

export type ConceptStatus = 'verified' | 'candidate' | 'blocked'   // ← the "green" idea
export type TimeSemantics = 'snapshot' | 'during' | 'trailing'
export type ConceptForm = 'simple' | 'composite'   // simple = one unit; composite = built from sub-concepts
export type Measure = { name: string; additive?: boolean; stock?: boolean; note?: string }
export type Dimension = { name: string; values?: string[] }
export type Parameter = { name: string; default?: unknown; learned?: boolean }

export type ConceptProps = {
  status: ConceptStatus
  form?: ConceptForm         // simple (bound to one unit) | composite (has sub-concepts)
  grain?: string             // "one open bill"
  time?: TimeSemantics       // how it's read in time
  asOf?: string              // the snapshot / freshness stamp
  population?: string        // "44,610 bills · 1,103 customers"
  measures?: Measure[]       // views of the one unit (params)
  dimensions?: Dimension[]   // slice-by axes (params)
  parameters?: Parameter[]   // free / learned values
  rules?: string[]           // tribal-knowledge corrections
  identity?: string          // entity resolution
  source?: string            // table / binding
  unit?: string              // THE one big parameterised unit (unit node id)
}

export type Cardinality = 'N:1' | '1:1' | 'N:N'
export type RelationProps = { via: string; cardinality: Cardinality; coverage?: number; ok?: boolean }

export function conceptId(name: string): string {
  return 'concept:' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

// ── The concept TREE ──────────────────────────────────────────────────────────
// Concepts hang in a tree under one root (the semantic model). The tree edge is
// `belongs_to` (child → parent), matching the store's tree convention. A concept is
// a child of a composite parent, or — until the modeler groups it — of the root.
// Each concept still points DOWN to its one unit via the `uses` edge (bindUnit).
export const CONCEPT_ROOT = 'concept:root'

/** Ensure the tree root exists and no concept floats outside it (orphans → root). Structural only. */
export function ensureConceptTree(store: NodeStore): string {
  if (!store.getNode(CONCEPT_ROOT))
    store.putNode({ id: CONCEPT_ROOT, kind: 'concept', label: 'semantic model', summary: 'concept tree root',
      props: { status: 'verified', form: 'composite' } })
  for (const c of store.listKind('concept')) {
    if (c.id === CONCEPT_ROOT) continue
    if (store.neighbors(c.id, { type: 'belongs_to', direction: 'out' }).length === 0)
      store.putEdge({ from: c.id, to: CONCEPT_ROOT, type: 'belongs_to' })
  }
  return CONCEPT_ROOT
}

/** Place a concept under a parent (single-parent: replaces any existing parent). No/`'root'` parent → the root. */
export function setParent(store: NodeStore, childName: string, parentName?: string): void {
  ensureConceptTree(store)
  const child = conceptId(childName)
  const parent = !parentName || parentName === 'root' ? CONCEPT_ROOT : conceptId(parentName)
  if (child === parent) return
  store.db.prepare(`DELETE FROM edges WHERE from_id=? AND type='belongs_to'`).run(child)
  store.putEdge({ from: child, to: parent, type: 'belongs_to' })
}

export type ConceptTreeNode = { id: string; label: string; depth: number; form?: ConceptForm; unit?: string; parameters?: Parameter[] }
/** The tree, flattened depth-first from the root (root excluded), for inspection. */
export function conceptTree(store: NodeStore): ConceptTreeNode[] {
  ensureConceptTree(store)
  return store.walk(CONCEPT_ROOT, { type: 'belongs_to', direction: 'in' }).map((n) => {
    const p = (n.props ?? {}) as ConceptProps
    return { id: n.id, label: n.label, depth: n.depth, form: p.form, unit: p.unit, parameters: p.parameters }
  })
}

/** Create or update a concept with its facets. New concepts are auto-placed under the tree root. */
export function upsertConcept(store: NodeStore, name: string, props: ConceptProps, summary?: string): Node {
  const node = store.putNode({ id: conceptId(name), kind: 'concept', label: name, summary, props })
  if (node.id !== CONCEPT_ROOT && store.neighbors(node.id, { type: 'belongs_to', direction: 'out' }).length === 0)
    setParent(store, name)   // land under root until the modeler re-parents it
  return node
}

/** A typed relationship between two concepts — carries cardinality + coverage (green/weak). */
export function relate(store: NodeStore, fromName: string, toName: string, rel: RelationProps): void {
  store.putEdge({ from: conceptId(fromName), to: conceptId(toName), type: 'relates', props: rel })
}

/** Bind a concept to its one big parameterised unit (records the id + a `uses` edge). */
export function bindUnit(store: NodeStore, name: string, unitId: string): void {
  const id = conceptId(name)
  const n = store.getNode(id)
  if (n) store.putNode({ ...n, props: { ...(n.props as ConceptProps), unit: unitId } })
  store.putEdge({ from: id, to: unitId, type: 'uses' })
}

export function getConcept(store: NodeStore, name: string): Node | undefined {
  return store.getNode(conceptId(name))
}

export function relationships(store: NodeStore, name: string): Node[] {
  return store.neighbors(conceptId(name), { type: 'relates', direction: 'out' })
}
