export { NodeStore } from './store.js'
export type { Node, Edge, SearchHit } from './store.js'

// The intent graph — the spine.
export { ROOT, ensureRoot, ask, intentId, normalizeQuestion, pathTo, nextSteps, programCatalog } from './intent.js'
export type { IntentProps, RunOutput, Built, AskDeps, AskResult, ProgramEntry } from './intent.js'

// Concepts — the single atomic knowledge kind, time-versioned (current row + concept_history audit).
export { conceptId, upsertConcept, getConcept, conceptHistory } from './concept.js'
export type { ConceptProps, ConceptStatus, TimeSemantics, Measure, Dimension, Parameter, Provenance, ChangeMeta, ConceptVersion } from './concept.js'

// Datasource index — a flat, full-text map of every field in every source (SOURCE.CONTAINER.FIELD).
export { ensureDataSourceIndex, putEntry, putEntries, searchDataSource, setEnabled, applyRowCounts, dataSourceStats, describeEntry, dsiKey } from './datasource-index.js'
export type { DataSourceEntry } from './datasource-index.js'

// Semantic search — GENERIC hybrid (FTS + vector) over any node kind. Swappable seams: Embedder (model),
// VectorIndex (SqliteVecIndex now / Qdrant later), rrfFuse (reranker).
export { SqliteVecIndex, rrfFuse, hybridSearch, indexText, backfillMissing } from './semantic.js'
export type { Embedder, VectorIndex, Hit } from './semantic.js'
export * from './retrieval-state.js'
