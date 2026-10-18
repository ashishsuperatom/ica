// Public API. Everything a consuming system needs, nothing it shouldn't
// reach into -- internals (discovery.ts) stay unexported. Files for standalone Node use: ./node.ts.

export { createEngine, type Engine, type EngineConfig, type DecideReturn, type DecisionData, type OutcomeData } from './engine.js'
export { memoryJournal, memoryCache, systemClock, readAll, type Journal, type Cache, type Clock, type Entry, type NewEntry } from './ports.js'
export { computeState, type State, type Activation, type Bucket } from './state.js'
export { SignalRegistry, signalId, type SignalSpec, type EvalResult } from './signal.js'
export { AttractorTree, BetaStat, type Who, type ActionDetail, type DecideResult } from './attractor.js'
export { findCoOccurrenceCandidates, episodesFromJournal, promote, type CoOccurrenceCandidate, type PromotionResult } from './promotion.js'
export { adjustWeight } from './weights.js'
