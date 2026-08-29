// Smoke test for the intent-graph spine + concept registry (in-memory, stubbed ICA).
//   pnpm exec tsx packages/node-store/src/intent.smoke.ts
import { NodeStore } from './store.js'
import { ROOT, ensureRoot, ask, pathTo, nextSteps, type AskDeps } from './intent.js'
import { upsertConcept, getConcept, conceptHistory, conceptId, type ConceptProps } from './concept.js'

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

  // A concept with the lean core + the optional data-model block (Receivables genuinely is an entity).
  // Compute recipes are ALWAYS PRQL, never SQL — the datasource seam compiles PRQL to the source's dialect.
  const recv: ConceptProps = {
    value: 'Open receivables — one row per open bill.', status: 'verified',
    grain: 'one open bill', time: 'snapshot', keying: 'id = SubLedger', source: 'totalgroup',
    find: 'the outstanding-debtor report table',
    measures: [{ name: 'outstanding', additive: true, stock: true, compute: 'aggregate {outstanding = sum balance}', note: 'floors advances' },
               { name: 'overdue', additive: true, stock: true }],
    dimensions: [{ name: 'branch', via: 'location_id', coverage: 1 }, { name: 'ageing_bucket', note: '1-30 / 31-60 / 61-90' }],
    parameters: [{ name: 'credit_days', learned: true }],
    rules: ['sum balance, not the running-balance column (−₹23.4 Cr)', 'age by the ageing-days column'],
    requires: ['branch'], verifiedAt: '2026-06-03',
  }
  upsertConcept(s, 'Receivables', recv, { changedBy: 'human:test', reason: 'seed' })
  upsertConcept(s, 'Branch', { value: 'A location.', status: 'verified', grain: 'one location' }, { changedBy: 'human:test' })

  const c = getConcept(s, 'Receivables')!
  const cp = c.props as ConceptProps
  ok(cp.status === 'verified' && cp._v?.version === 1, 'concept stores status + version 1')
  ok((cp.measures?.length ?? 0) === 2 && cp.verifiedAt === '2026-06-03', 'concept stores measures + freshness')
  ok((cp.requires ?? []).includes('branch'), 'Receivables requires branch')

  // Time-versioning (SCD-2): control v1's valid_from so the as-of window is deterministic (no same-ms race).
  const T0 = 1_700_000_000_000
  s.db.prepare(`UPDATE nodes SET valid_from=? WHERE id=?`).run(T0, conceptId('Receivables'))
  upsertConcept(s, 'Receivables', { ...recv, status: 'corroborated' }, { changedBy: 'consolidator', reason: 're-corroborated' })
  const now = getConcept(s, 'Receivables')!.props as ConceptProps
  const past = getConcept(s, 'Receivables', T0)!.props as ConceptProps         // rewind into v1's window
  ok(now.status === 'corroborated' && now._v?.version === 2, 'change bumped to version 2 (live)')
  ok(past.status === 'verified' && past._v?.version === 1, 'get(asOf) rewinds to archived version 1')
  ok(conceptHistory(s, 'Receivables').length === 2, 'timeline has 2 versions (archived + live)')

  console.log(`intent+concept smoke: OK`)
  console.log(`  built=${built} ran=${ran}  path: ${path.map(n => n.label).join(' → ')}`)
  console.log(`  concepts: ${s.listKind('concept').map(n => n.label).join(', ')}`)
  console.log(`  intents:  ${s.listKind('intent').filter(n => n.id !== ROOT).length} nodes`)
  s.close()
}
main().catch(e => { console.error(e); process.exit(1) })
