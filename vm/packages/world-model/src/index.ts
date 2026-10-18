// Public API. Everything a consuming system needs, nothing it shouldn't
// reach into -- internals (discovery.ts, log.ts, snapshot.ts) stay unexported.

export { createEngine, type Engine, type EngineConfig, type DecideReturn } from './engine.js'
export { computeState, type State, type Activation, type Bucket } from './state.js'
export { SignalRegistry, signalId, type SignalSpec, type EvalResult } from './signal.js'
export { AttractorTree, BetaStat, type Who, type ActionDetail, type DecideResult } from './attractor.js'
export { findCoOccurrenceCandidates, episodesFromLog, promote, type CoOccurrenceCandidate, type PromotionResult } from './promotion.js'
export { adjustWeight } from './weights.js'
