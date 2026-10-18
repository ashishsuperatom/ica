import { AttractorTree, type Who, type DecideResult } from './attractor.js'
import { readAll, systemClock, type Cache, type Clock, type Journal } from './ports.js'

/** One model's engine, over the host's journal (the truth) and cache (what is computed from it). */
export interface EngineConfig {
  /** The model's name: its entries in the journal carry it, and only its own are read. */
  model: string
  journal: Journal
  cache: Cache
  clock?: Clock
  minConfidentN?: number
  maxConfidentWidth?: number
}

/** A decision as the journal keeps it. */
export interface DecisionData { decisionId: string; fingerprint: string; action: string; who: Who; activeSignalIds?: string[] }
/** An outcome as the journal keeps it — it may arrive long after its decision, or never. */
export interface OutcomeData { decisionId: string; outcome: boolean | 0 | 1 }

interface PendingDecision {
  fingerprint: string
  action: string
  who: Who
}

export interface DecideReturn extends DecideResult {
  decisionId: string
  confident: boolean
}

export interface Engine {
  /** Choose — returned once the decision is stored in the journal (nothing is shown before its entry is kept). */
  decide(fingerprint: string, actions: string[], who?: Who, overrideAction?: string | null, activeSignalIds?: string[]): Promise<DecideReturn>
  /** How a decision turned out — stored, then learned from. */
  recordOutcome(decisionId: string, outcome: boolean | 0 | 1): Promise<void>
  /** Keep what is computed (the statistics and how far into the journal they reach) in the cache. The host says when. */
  saveCache(): Promise<void>
  tree: AttractorTree
}

const CACHE_KEY = (model: string) => `${model}.attractor`

/** Open a model's engine: what the cache holds, then every entry of the journal after it — the cache is only a shortcut. */
export async function createEngine({
  model,
  journal,
  cache,
  clock = systemClock,
  minConfidentN = 5,
  maxConfidentWidth = 0.3,
}: EngineConfig): Promise<Engine> {
  const cached = await cache.get<{ tree: unknown; cursor: number; pending: [string, PendingDecision][] }>(CACHE_KEY(model))
  const tree = cached ? AttractorTree.fromJSON(cached.tree as never) : new AttractorTree()
  const pending = new Map<string, PendingDecision>(cached?.pending ?? [])
  let cursor = cached?.cursor ?? 0

  // the journal after the cache: decisions opened, outcomes learned
  for await (const e of readAll(journal, cursor)) {
    cursor = e.seq
    if (e.model !== model) continue
    if (e.kind === 'decision') { const d = e.data as DecisionData; pending.set(d.decisionId, { fingerprint: d.fingerprint, action: d.action, who: d.who }) }
    else if (e.kind === 'outcome') { const o = e.data as OutcomeData; const p = pending.get(o.decisionId); if (p) { applyOutcome(tree, p, o.outcome); pending.delete(o.decisionId) } }
  }

  let decisionCounter = 0

  // overrideAction: used by a bootstrap/exploration phase (e.g. an LLM agent
  // trying both actions) to force a choice instead of trusting current stats.
  // The engine still records it exactly like any other decision.
  async function decide(
    fingerprint: string,
    actions: string[],
    who: Who = {},
    overrideAction: string | null = null,
    activeSignalIds?: string[],
  ): Promise<DecideReturn> {
    const decisionId = `d${clock.now()}_${++decisionCounter}`
    const result = tree.decide(fingerprint, actions, who)
    const action = overrideAction ?? result.action
    const data: DecisionData = { decisionId, fingerprint, action, who, ...(activeSignalIds ? { activeSignalIds } : {}) }
    cursor = await journal.append([{ at: clock.now(), model, kind: 'decision', data }])
    pending.set(decisionId, { fingerprint, action, who })
    // "Confident" means the level actually used for the winning action has
    // enough of its OWN evidence and a tight enough interval -- not just that
    // an action was computable. This is what lets a caller route low-
    // confidence decisions to a human instead of silently acting on a guess.
    const winning = result.detail[result.action]
    const confident = winning.sourceN >= minConfidentN && winning.sourceCredibleWidth <= maxConfidentWidth
    return { decisionId, ...result, action, confident }
  }

  async function recordOutcome(decisionId: string, outcome: boolean | 0 | 1): Promise<void> {
    const p = pending.get(decisionId)
    if (!p) throw new Error(`unknown decisionId: ${decisionId}`)
    const data: OutcomeData = { decisionId, outcome }
    cursor = await journal.append([{ at: clock.now(), model, kind: 'outcome', data }])
    applyOutcome(tree, p, outcome)
    pending.delete(decisionId)
  }

  async function saveCache(): Promise<void> {
    await cache.put(CACHE_KEY(model), { tree: tree.toJSON(), cursor, pending: [...pending] })
  }

  return { decide, recordOutcome, saveCache, tree }
}

function applyOutcome(tree: AttractorTree, pending: PendingDecision, outcome: boolean | 0 | 1): void {
  tree.record('org', pending.fingerprint, pending.action, outcome)
  if (pending.who.group) tree.record(pending.who.group, pending.fingerprint, pending.action, outcome)
  if (pending.who.user) tree.record(pending.who.user, pending.fingerprint, pending.action, outcome)
}
