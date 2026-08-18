export { NodeStore } from './store.js'
export type { Node, Edge, SearchHit } from './store.js'

// The intent graph — the spine.
export { ROOT, ensureRoot, ask, intentId, normalizeQuestion, pathTo, nextSteps, programCatalog } from './intent.js'
export type { IntentProps, RunOutput, Built, AskDeps, AskResult, ProgramEntry } from './intent.js'

// Basis — the evolving, per-org intent space (open-vocabulary typed-pair axes).
export { basisId, basisFromPairs, upsertBasis, linkBasis, basisOf, intentsByBasis, BASIS_SEED, ensureBasisSeed, renderVocab } from './basis.js'
export type { BasisPair } from './basis.js'

// Concepts — the semantic model as a term registry (one entity = one parameterised unit).
export { conceptId, upsertConcept, relate, bindUnit, getConcept, relationships,
  CONCEPT_ROOT, ensureConceptTree, setParent, conceptTree } from './concept.js'
export type { ConceptProps, ConceptStatus, ConceptForm, TimeSemantics, Measure, Dimension, Parameter, Cardinality, RelationProps, ConceptTreeNode } from './concept.js'

// Semantic atoms (System A) — typed knowledge units (where/how/quality), versioned on contradiction.
export { atomId, atomContentHash, putAtom, retireAtom, findAtoms, atomsFor, atomHistory } from './atom.js'
export type { AtomKind, AtomProps, AtomInput, FindAtomsOpts } from './atom.js'
