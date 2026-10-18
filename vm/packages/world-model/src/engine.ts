import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { AttractorTree, type Who, type DecideResult } from './attractor.js'
import { DecisionLog } from './log.js'
import { saveSnapshot, loadSnapshot } from './snapshot.js'

export interface EngineConfig {
  dataDir: string
  snapshotIntervalMs?: number
  minConfidentN?: number
  maxConfidentWidth?: number
}

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
  decide(fingerprint: string, actions: string[], who?: Who, overrideAction?: string | null, activeSignalIds?: string[]): DecideReturn
  recordOutcome(decisionId: string, outcome: boolean | 0 | 1): void
  snapshotNow(): void
  close(): void
  tree: AttractorTree
  log: DecisionLog
}

export function createEngine({
  dataDir,
  snapshotIntervalMs = 5000,
  minConfidentN = 5,
  maxConfidentWidth = 0.3,
}: EngineConfig): Engine {
  mkdirSync(dataDir, { recursive: true })
  const logPath = join(dataDir, 'log.jsonl')
  const snapPath = join(dataDir, 'snapshot.json')

  const snap = loadSnapshot(snapPath)
  const tree = snap ? AttractorTree.fromJSON(snap.tree as never) : new AttractorTree()
  let processedLines = snap ? snap.processedLines : 0

  const log = new DecisionLog(logPath)

  // Replay only the tail of the log written after the last snapshot --
  // the snapshot's whole job is to avoid re-reading the entire history.
  const pending = new Map<string, PendingDecision>()
  const allLines = log.readAllLines()
  for (let i = processedLines; i < allLines.length; i++) {
    const line = allLines[i]
    if (line.type === 'decision') {
      pending.set(line.decisionId, { fingerprint: line.fingerprint, action: line.action, who: line.who })
    } else if (line.type === 'outcome') {
      const p = pending.get(line.decisionId)
      if (p) {
        applyOutcome(tree, p, line.outcome)
        pending.delete(line.decisionId)
      }
    }
  }
  processedLines = allLines.length

  let decisionCounter = 0

  // overrideAction: used by a bootstrap/exploration phase (e.g. an LLM agent
  // trying both actions) to force a choice instead of trusting current stats.
  // The engine still records it exactly like any other decision.
  function decide(
    fingerprint: string,
    actions: string[],
    who: Who = {},
    overrideAction: string | null = null,
    activeSignalIds?: string[],
  ): DecideReturn {
    const decisionId = `d${Date.now()}_${++decisionCounter}`
    const result = tree.decide(fingerprint, actions, who)
    const action = overrideAction ?? result.action
    pending.set(decisionId, { fingerprint, action, who })
    log.appendDecision({ decisionId, fingerprint, action, who, ts: Date.now(), activeSignalIds })
    processedLines += 1
    // "Confident" means the level actually used for the winning action has
    // enough of its OWN evidence and a tight enough interval -- not just that
    // an action was computable. This is what lets a caller route low-
    // confidence decisions to a human instead of silently acting on a guess.
    const winning = result.detail[result.action]
    const confident = winning.sourceN >= minConfidentN && winning.sourceCredibleWidth <= maxConfidentWidth
    return { decisionId, ...result, action, confident }
  }

  function recordOutcome(decisionId: string, outcome: boolean | 0 | 1): void {
    const p = pending.get(decisionId)
    if (!p) throw new Error(`unknown decisionId: ${decisionId}`)
    applyOutcome(tree, p, outcome)
    log.appendOutcome({ decisionId, outcome, ts: Date.now() })
    processedLines += 1
    pending.delete(decisionId)
  }

  function snapshotNow(): void {
    saveSnapshot(snapPath, { tree: tree.toJSON(), processedLines })
  }

  const timer = setInterval(snapshotNow, snapshotIntervalMs)

  function close(): void {
    clearInterval(timer)
    snapshotNow()
  }

  return { decide, recordOutcome, snapshotNow, close, tree, log }
}

function applyOutcome(tree: AttractorTree, pending: PendingDecision, outcome: boolean | 0 | 1): void {
  tree.record('org', pending.fingerprint, pending.action, outcome)
  if (pending.who.group) tree.record(pending.who.group, pending.fingerprint, pending.action, outcome)
  if (pending.who.user) tree.record(pending.who.user, pending.fingerprint, pending.action, outcome)
}
