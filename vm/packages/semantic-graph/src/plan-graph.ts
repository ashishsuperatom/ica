// ── THE PLAN AS A GRAPH OF WORK, PULLED ON DEMAND ────────────────────────────────────────────────────────────
//
// Compiling a question gives a DAG of operations, and nothing runs. Each node is identified by the hash of what it
// IS — its definition and the hashes of its inputs — so the same work anywhere in the system is literally the same
// node, and a result kept against that hash is reusable by anyone who asks for it again.
//
//   read     rows from a source, for one fact, as the compiler wrote them
//   produce  rows from a program that makes a fact's rows
//   fold     a fact's rows aggregated at the question's grain
//   join     several facts put side by side on what they share
//   derive   the outputs computed from the folded measures
//
// EVALUATION IS DEMAND-DRIVEN. `pull` asks for one node; only what that node needs is computed. A program whose
// rows nothing asks for never runs; a second question that shares a subtree pays nothing for it; a correction
// invalidates exactly the nodes downstream of the definition it touched, because the hash of everything below it
// changes and nothing above it does.
//
// WHAT A MEMO IS WORTH KEEPING AGAINST. A node's result is true of a source AT A MOMENT; the store keeps the
// watermark it was read at, so freshness is a property of the memo rather than a hope.

import { createHash } from 'node:crypto'
import { canonicalJson } from './runtime.js'
import type { Plan } from './algebra.js'

export type NodeKind = 'read' | 'produce' | 'fold' | 'join' | 'derive'

export interface WorkNode {
  /** What this node IS: kind, definition and the hashes of its inputs. Two identical nodes have one hash. */
  hash: string
  kind: NodeKind
  /** In the graph's words, for a person reading a trace. */
  label: string
  inputs: string[]
  /** What the node needs to run, by kind: a statement, a program's name and span, the fold's grain. */
  body: unknown
  /** The source this node reads, when it reads one — what its freshness is measured against. */
  source?: string
}

export interface WorkGraph {
  nodes: Map<string, WorkNode>
  /** The node whose result IS the answer. */
  root: string
}

export const hashNode = (kind: NodeKind, body: unknown, inputs: string[]): string =>
  `${kind}:${createHash('sha256').update(canonicalJson({ body, inputs })).digest('hex').slice(0, 24)}`

/** Build the graph of work a plan implies. Nothing is read, nothing is run. */
export function workGraph(plan: Plan, statementsFor: (fact: string) => Array<{ source: string; sql: string; params: Record<string, unknown>; program?: string }>): WorkGraph {
  const nodes = new Map<string, WorkNode>()
  const put = (n: WorkNode) => { if (!nodes.has(n.hash)) nodes.set(n.hash, n); return n.hash }

  const folded: string[] = []
  for (const fp of plan.facts) {
    const reads = statementsFor(fp.fact).map((st) => put({
      hash: hashNode(st.program ? 'produce' : 'read', st.program ? { program: st.program, span: plan.span } : { sql: st.sql, params: st.params }, []),
      kind: st.program ? 'produce' : 'read',
      label: st.program ? `${fp.fact} from the program "${st.program}"` : `${fp.fact} from ${st.source}`,
      inputs: [], body: st.program ? { program: st.program, span: plan.span } : { sql: st.sql, params: st.params }, source: st.source,
    }))
    folded.push(put({
      hash: hashNode('fold', { fact: fp.fact, by: fp.by, where: fp.where, measures: fp.measures, span: plan.span, convert: fp.convert }, reads),
      kind: 'fold',
      label: `${fp.fact} added up by ${fp.by.length ? fp.by.map((b) => ('attribute' in b ? b.attribute : b.path.join('.'))).join(', ') : 'nothing'}`,
      inputs: reads, body: { fact: fp.fact, by: fp.by, measures: fp.measures },
    }))
  }
  const joined = folded.length > 1
    ? put({ hash: hashNode('join', { targets: plan.targets }, folded), kind: 'join', label: `${plan.facts.map((f) => f.fact).join(' and ')} side by side by ${plan.targets.join(', ') || 'nothing'}`, inputs: folded, body: { targets: plan.targets } })
    : folded[0]
  const root = put({
    hash: hashNode('derive', { outputs: plan.outputs, order: plan.order, limit: plan.limit, having: plan.having }, [joined]),
    kind: 'derive', label: `${plan.outputs.map((o) => o.name).join(', ')}`, inputs: [joined], body: { outputs: plan.outputs },
  })
  return { nodes, root }
}

/** Every node the root needs, deepest first — what would run, in the order it would run. */
export function needed(g: WorkGraph, root = g.root): WorkNode[] {
  const out: WorkNode[] = []
  const seen = new Set<string>()
  const walk = (hash: string) => {
    if (seen.has(hash)) return
    seen.add(hash)
    const n = g.nodes.get(hash)
    if (!n) return
    for (const i of n.inputs) walk(i)
    out.push(n)
  }
  walk(root)
  return out
}

// ── THE MEMO ─────────────────────────────────────────────────────────────────────────────────────────────────
// A result, kept against the hash of the work that produced it, with the moment its sources were read at. Nothing
// is invalidated by hand: a changed definition is a different hash, so its memo is simply never found again.

export interface Memo {
  get(hash: string): { value: unknown; at: number; watermark?: string } | undefined
  put(hash: string, value: unknown, watermark?: string): void
}

export function memoInMemory(): Memo {
  const held = new Map<string, { value: unknown; at: number; watermark?: string }>()
  return {
    get: (hash) => held.get(hash),
    put: (hash, value, watermark) => { held.set(hash, { value, at: Date.now(), ...(watermark ? { watermark } : {}) }) },
  }
}

export interface PullOptions {
  memo?: Memo
  /** How stale a memo may be before the work is done again; without it, a memo is always taken. */
  freshFor?: number
  onNode?: (n: WorkNode, from: 'memo' | 'work', ms: number) => void
}

/** Ask for one node. Only what it needs is computed, and only what is not already known. */
export async function pull(g: WorkGraph, hash: string, run: (n: WorkNode, inputs: unknown[]) => Promise<unknown>, o: PullOptions = {}): Promise<unknown> {
  const n = g.nodes.get(hash)
  if (!n) throw new Error(`this plan has no node ${hash}`)
  const held = o.memo?.get(hash)
  if (held && (o.freshFor === undefined || Date.now() - held.at <= o.freshFor)) { o.onNode?.(n, 'memo', 0); return held.value }
  const inputs: unknown[] = []
  for (const i of n.inputs) inputs.push(await pull(g, i, run, o))
  const started = Date.now()
  const value = await run(n, inputs)
  o.onNode?.(n, 'work', Date.now() - started)
  o.memo?.put(hash, value)
  return value
}

/** What this question would cost, given what is already known: the nodes that would have to run. */
export function coldNodes(g: WorkGraph, memo?: Memo, root = g.root): WorkNode[] {
  return needed(g, root).filter((n) => !memo?.get(n.hash))
}
