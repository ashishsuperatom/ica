// Ground-truth history — the LABELED input the deterministic alias validator (and later §6 closure) need.
//
// Derived from concept PROVENANCE: each concept records the {question, program} pairs it was minted/used for,
// so inverting it gives, per past question, the concept(s) that question actually produced. No LLM — pure data.
//
// REPLACEABLE segment: if we later record the correct concept set more directly (e.g. the composer reports which
// concepts it actually used to build the answer), swap this module's body and nothing else in retrieval changes.
import type { NodeStore } from '@superatom/node-store'

export type LabeledQuestion = { question: string; correct: Set<string> }

export function labeledHistory(store: NodeStore): LabeledQuestion[] {
  const byQuestion = new Map<string, Set<string>>()
  for (const c of store.listKind('concept') as any[]) {
    const props = typeof c.props === 'string' ? JSON.parse(c.props || '{}') : (c.props || {})
    const prov = Array.isArray(props.provenance) ? props.provenance : []
    for (const p of prov) {
      const q = String(p?.question || '').trim()
      if (!q) continue
      ;(byQuestion.get(q) ?? byQuestion.set(q, new Set<string>()).get(q)!).add(c.label)
    }
  }
  return [...byQuestion.entries()].map(([question, correct]) => ({ question, correct }))
}
