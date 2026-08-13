// The INTENT GRAPH — the new spine, layered on the same node-store.
//
// A conversation is a tree of intent nodes (kind='intent') linked by `follow_up`
// edges. Position IS context: you ask from where you are; a root thread asks from
// ROOT. Matching is positional and deterministic — the node id is a hash of
// (parent, normalised question), so re-asking the same thing at the same place is
// the SAME node (exact re-run, no ICA). A miss hands off to the ICA to build.
//
// The intent node does NOT cache an answer. The PROGRAM is the artifact: running it
// yields { data, explanation, ui }. The only thing stored here that a re-run can't
// reproduce is `rawAnalysis` — the ICA's exploration that built the program.

import { createHash } from 'node:crypto'
import type { NodeStore, Node } from './store.js'

export type IntentProps = {
  question: string           // normalised text — the v0 match key
  raw?: string               // the original utterance
  terms?: string[]           // extracted, but NOT matched yet (raw material for v1)
  program?: string           // program node id; run() → data + explanation + ui
  rawAnalysis?: string       // the ICA exploration that BUILT the program (not re-derivable)
  lastShapeHash?: string     // shape-cache: same shape → reuse UI; changed → regenerate
  contextConsumed?: string[] // bindings pulled from the parent; empty ⇒ a root thread
}

export const ROOT = 'intent:root'

export function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?.!]+$/, '')
}

export function ensureRoot(store: NodeStore): string {
  if (!store.getNode(ROOT)) store.putNode({ id: ROOT, kind: 'intent', label: '(root)', summary: 'conversation root' })
  return ROOT
}

/** Deterministic id: the same question at the same position is the same node. */
export function intentId(parentId: string, question: string): string {
  const h = createHash('sha1').update(parentId + '|' + normalizeQuestion(question)).digest('hex')
  return 'intent:' + h.slice(0, 16)
}

// The program run yields the answer's live parts; shapeHash drives UI reuse.
export type RunOutput = { data: unknown; explanation?: unknown; ui?: unknown; shapeHash?: string }
// What the ICA returns when it builds a new node.
export type Built = { program: string; rawAnalysis?: string; terms?: string[]; contextConsumed?: string[] }

export type AskDeps = {
  runProgram: (programId: string) => Promise<RunOutput>
  ica: (utterance: string, ctx: { position: string; path: Node[]; store: NodeStore }) => Promise<Built>
}
export type AskResult = RunOutput & { node: Node; reused: boolean }

/**
 * The spine. Match the utterance into the intent graph at `position`:
 *   hit  → re-run the node's program (SYS-1 fast path, no ICA)
 *   miss → ICA builds a program + node, then run it
 */
export async function ask(store: NodeStore, position: string, utterance: string, deps: AskDeps): Promise<AskResult> {
  const id = intentId(position, utterance)
  const hit = store.getNode(id)
  const hitProps = hit?.props as IntentProps | undefined
  if (hit && hitProps?.program) {
    const out = await deps.runProgram(hitProps.program)
    store.putNode({ ...hit, props: { ...hitProps, lastShapeHash: out.shapeHash ?? hitProps.lastShapeHash } })
    return { node: hit, ...out, reused: true }
  }
  const built = await deps.ica(utterance, { position, path: pathTo(store, position), store })
  const props: IntentProps = {
    question: normalizeQuestion(utterance), raw: utterance,
    terms: built.terms, program: built.program, rawAnalysis: built.rawAnalysis,
    contextConsumed: built.contextConsumed,
  }
  const node = store.putNode({ id, kind: 'intent', label: utterance.slice(0, 80), summary: utterance, props })
  store.putEdge({ from: position, to: id, type: 'follow_up' })
  const out = await deps.runProgram(built.program)
  store.putNode({ ...node, props: { ...props, lastShapeHash: out.shapeHash } })
  return { node, ...out, reused: false }
}

/** The thread from root to a node — the conversation path (context). */
export function pathTo(store: NodeStore, id: string): Node[] {
  const path: Node[] = []
  let cur: string | undefined = id
  const seen = new Set<string>()
  while (cur && cur !== ROOT && !seen.has(cur)) {
    seen.add(cur)
    const n = store.getNode(cur); if (!n) break
    path.unshift(n)
    cur = store.neighbors(cur, { type: 'follow_up', direction: 'in' })[0]?.id
  }
  return path
}

/** Children already travelled under a node — the suggestible next steps. */
export function nextSteps(store: NodeStore, id: string): Node[] {
  return store.neighbors(id, { type: 'follow_up', direction: 'out' })
}

/** One entry in the program catalog: an existing program the reflex agent can consider running. */
export type ProgramEntry = { intentId: string; question: string; program: string; params: Record<string, unknown> }

/**
 * The PROGRAM CATALOG — every intent that has a built program, straight from the DB (the single source of
 * truth). This is what the reflex agent READS to decide "does a program that answers this already exist?".
 * We hand it the questions + each program's param shape so it can pick a match and fill in this question's
 * values. Deliberately a plain list (small today); a basis/vector RETRIEVAL pre-filter goes here when it grows.
 */
export function programCatalog(store: NodeStore): ProgramEntry[] {
  return store.nodesByKind('intent')
    .filter(n => (n.props as any)?.program)
    .map(n => { const p = n.props as any
      return { intentId: n.id, question: p.question ?? n.summary ?? n.label ?? '', program: p.program as string, params: (p.params ?? {}) as Record<string, unknown> } })
}
