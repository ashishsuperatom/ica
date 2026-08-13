// Smoke test for the intent-graph spine + concept registry (in-memory, stubbed ICA).
//   pnpm exec tsx packages/node-store/src/intent.smoke.ts
import { NodeStore } from './store.js'
import { ROOT, ensureRoot, ask, pathTo, nextSteps, type AskDeps } from './intent.js'
import { upsertConcept, relate, bindUnit, getConcept, relationships, type ConceptProps } from './concept.js'

const ok = (c: boolean, m: string) => { if (!c) { console.error('FAIL:', m); process.exit(1) } }

async function main() {
  const s = new NodeStore()          // :memory:
  ensureRoot(s)

  // Stub the two injected dependencies. `ica` only fires on a MISS.
  let built = 0, ran = 0
  const deps: AskDeps = {
    ica: async () => { built++; return { program: `prog:${built}`, rawAnalysis: 'explored the source…', terms: ['project', 'running-late'] } },
    runProgram: async () => { ran++; return { data: [{ n: 42 }], ui: { kind: 'number' }, explanation: 'derived from BALANCE', shapeHash: 'shp1' } },
  }

  // Q1 from root → miss → ICA builds, then run
  const q1 = await ask(s, ROOT, 'How much do we get owed?', deps)
  ok(!q1.reused && built === 1 && ran === 1, 'Q1 should build via ICA and run')

  // Q1 again at the same position → HIT → reuse program, no new build
  const q1b = await ask(s, ROOT, 'how much do we get owed', deps)   // different casing/punct
  ok(q1b.reused && built === 1 && ran === 2, 'Q1 re-ask should hit + reuse (normalised match)')
  ok(q1b.node.id === q1.node.id, 'same question at same position ⇒ same node id')

  // Follow-up under Q1 → new child node
  const q2 = await ask(s, q1.node.id, 'Who owes the most?', deps)
  ok(!q2.reused && built === 2, 'follow-up under Q1 should build a new node')

  // Same surface question at a DIFFERENT position ⇒ different node (context = position)
  const q2root = await ask(s, ROOT, 'Who owes the most?', deps)
  ok(q2root.node.id !== q2.node.id && built === 3, 'same words, different position ⇒ different node')

  // Structure
  const path = pathTo(s, q2.node.id)
  ok(path.length === 2 && path[0].id === q1.node.id, 'path root→Q1→Q2 is [Q1, Q2]')
  ok(nextSteps(s, q1.node.id).length === 1, 'Q1 has exactly one travelled next step')

  // Concept with the borrowed benchmark facets + one big parameterised unit
  const recv: ConceptProps = {
    status: 'verified', grain: 'one open bill', time: 'snapshot', asOf: '2026-06-03',
    population: '44,610 bills · 1,103 customers',
    measures: [{ name: 'outstanding', additive: true, stock: true, note: 'SUM(BALANCE), floors advances' },
               { name: 'overdue', additive: true, stock: true }],
    dimensions: [{ name: 'branch' }, { name: 'ageing_bucket', values: ['1-30', '31-60', '61-90'] }],
    parameters: [{ name: 'credit_days', learned: true }],
    rules: ['sum BALANCE not CurrentBal (−₹23.4 Cr)', 'age by AgeingDays'],
    identity: 'SubLedger', source: 'dbo.rpt_db_outstanding_debtor',
  }
  upsertConcept(s, 'Receivables', recv)
  upsertConcept(s, 'Branch', { status: 'verified', grain: 'one location' })
  relate(s, 'Receivables', 'Branch', { via: 'LocationId', cardinality: 'N:1', coverage: 1, ok: true })
  bindUnit(s, 'Receivables', 'unit:abc123')

  const c = getConcept(s, 'Receivables')!
  const cp = c.props as ConceptProps
  ok(cp.status === 'verified' && cp.unit === 'unit:abc123', 'concept stores status(green) + one unit')
  ok((cp.measures?.length ?? 0) === 2 && cp.asOf === '2026-06-03', 'concept stores measures + freshness')
  ok(relationships(s, 'Receivables').length === 1, 'Receivables → Branch relationship recorded')

  console.log(`intent+concept smoke: OK`)
  console.log(`  built=${built} ran=${ran}  path: ${path.map(n => n.label).join(' → ')}`)
  console.log(`  concepts: ${s.listKind('concept').map(n => n.label).join(', ')}`)
  console.log(`  intents:  ${s.listKind('intent').filter(n => n.id !== ROOT).length} nodes`)
  s.close()
}
main().catch(e => { console.error(e); process.exit(1) })
