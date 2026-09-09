// ── RETIRE A SUPERSEDED CONCEPT ───────────────────────────────────────────────────────────────────────────
//
//   tsx tools/retire-concept.mts <project.sqlite> <old>=<new> [<old>=<new> …] [--apply]
//
// A concept that has been rewritten leaves the original behind, and the original still owns every NAME people
// search it by. Deleting it would take those names with it: 'linked projects' and 'projects for this
// customer' would stop resolving, and the replacement — which answers both — would be findable only under
// whatever it happens to be called now.
//
// So retirement REPOINTS rather than deletes. Every name the old concept owns is moved to the new one, which
// leaves the old body in place, unnamed and unreachable by search, exactly as a superseded version already
// is. The index is bitemporal, so each move closes the old pointing's window instead of overwriting it and
// 'what did this name mean before' stays answerable.
//
// IT REFUSES TO RETIRE ONTO SOMETHING NO BETTER. The replacement must be runnable — the whole reason to
// retire prose is that something executable now covers it — and it must not be the concept being retired.
//
// Nothing here is specific to any dataset: which concept supersedes which is a judgement, and it is passed in
// on the command line rather than encoded here.

import { NodeStore } from '@superatom/node-store'
import { putIndex, namesFor, resolveConcept } from '@superatom/node-store'

const [dbPath, ...rest] = process.argv.slice(2)
const APPLY = rest.includes('--apply')
const pairs = rest.filter((a) => a !== '--apply').map((a) => {
  const i = a.indexOf('=')
  if (i < 1) { console.error(`not a pair: ${a} — expected <old>=<new>`); process.exit(1) }
  return [a.slice(0, i), a.slice(i + 1)] as const
})
if (!dbPath || !pairs.length) {
  console.error('usage: tsx tools/retire-concept.mts <project.sqlite> <old>=<new> [...] [--apply]')
  process.exit(1)
}

const store = new NodeStore(dbPath)
const RUNNABLE = (c: any) => /export\s+default/.test(String(c?.compute ?? ''))
let moved = 0, refused = 0

for (const [oldName, newName] of pairs) {
  const from = resolveConcept(store, oldName)
  const to = resolveConcept(store, newName)
  if (!from) { console.log(`✗ ${oldName} — no such concept`); refused++; continue }
  if (!to) { console.log(`✗ ${oldName} → ${newName} — replacement not found`); refused++; continue }
  if (from.id === to.id) { console.log(`✗ ${oldName} → ${newName} — already the same concept`); refused++; continue }
  if (!RUNNABLE(to.props)) {
    console.log(`✗ ${oldName} → ${newName} — the replacement is not runnable, so this is not an improvement`)
    refused++; continue
  }
  const names = namesFor(store, from.id)
  console.log(`${APPLY ? '→' : '·'} ${oldName} → ${newName}  (${names.length} name${names.length === 1 ? '' : 's'}: ${names.join(', ')})`)
  if (APPLY) {
    // A PERSON RUNS THIS, from a shell, naming both concepts. That is what `human:` means here, and it is why
    // retiring may move a name the write path would refuse to move on an agent's say-so.
    for (const n of names) putIndex(store, n, to.id, { changedBy: 'human:retire-concept', reason: `superseded by ${newName}` })
    moved += names.length
  }
}

console.log(APPLY
  ? `\n${moved} name${moved === 1 ? '' : 's'} repointed, ${refused} refused. The old bodies remain, unnamed.`
  : `\n${pairs.length - refused} concept(s) would be retired, ${refused} refused — dry run, pass --apply.`)
store.close()
