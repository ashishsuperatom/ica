// Local test of semantic atoms — write, lookup-by-name, and the temporal-provenance rule: a CONTRADICTION
// versions the atom (old archived + retired + timestamped, new live, linked), never a silent overwrite.
//   Run:  cd vm && pnpm exec tsx packages/node-store/src/atom.test.ts
import { NodeStore } from './store.js'
import { putAtom, atomsFor, findAtoms, atomHistory, atomId, atomContentHash } from './atom.js'

let pass = 0, fail = 0
const ok = (name: string, cond: boolean, detail = '') => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}  ${detail}`) } }

const s = new NodeStore(':memory:')

console.log('[write + lookup by entity name]')
putAtom(s, { atomKind: 'where-to-find', subject: 'broker', location: 'operation.BrokerId', evidence: 'populated 98%', confidence: 0.9, provenance: 'q1' })
putAtom(s, { atomKind: 'data-quality', subject: 'broker', location: 'vehicleplacement.VehicleBrokerId', coverage: 0.69, note: 'sparse — prefer the operation path', evidence: '69% populated', provenance: 'q1' })
const brokerAtoms = atomsFor(s, 'broker')
ok('two atoms found for "broker"', brokerAtoms.length === 2, `got ${brokerAtoms.length}`)
ok('kinds are where-to-find + data-quality', new Set(brokerAtoms.map((a: any) => a.props.atomKind)).size === 2)
ok('data-quality atom carries coverage', (brokerAtoms.find((a: any) => a.props.atomKind === 'data-quality')!.props as any).coverage === 0.69)
ok('every atom has a content hash', brokerAtoms.every((a: any) => !!a.props.hash))

console.log('\n[idempotent — identical re-emit does NOT version]')
const before = atomHistory(s, atomId('broker', 'data-quality')).length
putAtom(s, { atomKind: 'data-quality', subject: 'broker', location: 'vehicleplacement.VehicleBrokerId', coverage: 0.69, note: 'sparse — prefer the operation path', evidence: '69% populated', provenance: 'q2-different-provenance' })
ok('same definition (diff provenance) → no new version', atomHistory(s, atomId('broker', 'data-quality')).length === before)

console.log('\n[contradiction — changed content VERSIONS it (old kept, new live)]')
const id = atomId('broker', 'data-quality')
putAtom(s, { atomKind: 'data-quality', subject: 'broker', location: 'vehicleplacement.VehicleBrokerId', coverage: 0.81, note: 'coverage improved after backfill', evidence: '81% populated', provenance: 'q3' })
const live = s.getNode(id)!
ok('live atom now reflects the NEW coverage (0.81)', (live.props as any).coverage === 0.81)
ok('live atom is not retired', live.valid_to == null)
const hist = atomHistory(s, id)
ok('history has 2 versions (old + new)', hist.length === 2, `got ${hist.length}`)
const archived = hist.find((n: any) => n.id !== id)!
ok('the OLD version is preserved with coverage 0.69', (archived.props as any).coverage === 0.69)
ok('the OLD version is retired (has valid_to)', archived.valid_to != null)
ok('lookup returns only the LIVE version (not the archived)', atomsFor(s, 'broker').filter((a: any) => a.props.atomKind === 'data-quality').length === 1)
// (neighbors() hides retired nodes, so check the provenance edge directly in the edges table)
ok('a supersedes edge links live → archived', s.db.prepare(`SELECT 1 FROM edges WHERE from_id=? AND to_id=? AND type='supersedes'`).get(id, archived.id) != null)

console.log('\n[hash detects the change]')
ok('new hash differs from old hash', (live.props as any).hash !== (archived.props as any).hash)
ok('atomContentHash ignores provenance', atomContentHash({ atomKind: 'data-quality', subject: 'broker', coverage: 0.5, provenance: 'a' } as any) === atomContentHash({ atomKind: 'data-quality', subject: 'broker', coverage: 0.5, provenance: 'b' } as any))

console.log('\n[free-text find]')
ok('findAtoms(q="operation") reaches the where-to-find atom', findAtoms(s, { q: 'operation' }).length >= 1)

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
