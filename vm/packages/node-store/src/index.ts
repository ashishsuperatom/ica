export { NodeStore } from './store.js'
export type { Node, Edge, SearchHit } from './store.js'

// The intent graph — the spine.
export { ROOT, ensureRoot, ask, intentId, normalizeQuestion, pathTo, nextSteps, programCatalog } from './intent.js'
export type { IntentProps, RunOutput, Built, AskDeps, AskResult, ProgramEntry } from './intent.js'

// Concepts — the single atomic knowledge kind, time-versioned (current row + concept_history audit).
export { upsertConcept, getConcept, conceptHash, indexId, putIndex, resolveConcept, resolveConceptAsOf,
         indexHistory, namesFor, type IndexPointing } from './concept.js'
export type { ConceptProps, ConceptStatus, TimeSemantics, Measure, Dimension, Parameter, Provenance, ChangeMeta } from './concept.js'

// Datasource index — a flat, full-text map of every field in every source (SOURCE.CONTAINER.FIELD).
export { ensureDataSourceIndex, putEntry, putEntries, searchDataSource, setEnabled, applyRowCounts, dataSourceStats, describeEntry, dsiKey } from './datasource-index.js'
export type { DataSourceEntry } from './datasource-index.js'

// Semantic search — GENERIC hybrid (FTS + vector) over any node kind. Swappable seams: Embedder (model),
// VectorIndex (SqliteVecIndex now / Qdrant later), rrfFuse (reranker).
export { SqliteVecIndex, rrfFuse, hybridSearch, indexText, backfillMissing } from './semantic.js'
export type { Embedder, VectorIndex, Hit } from './semantic.js'
export * from './retrieval-state.js'

// Concept RUN records — the scratch trail that makes "saved == verified" checkable (see concept-run.ts).
export { CONCEPT_RUN_SCHEMA, runId, sourceHash, putRun, getRun, runsBySource, pruneRuns } from './concept-run.js'
export type { ConceptRunRecord } from './concept-run.js'
