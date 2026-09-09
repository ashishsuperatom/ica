// ── WHAT THE STORE HAS WRITTEN MORE THAN ONCE ─────────────────────────────────────────────────────────────
//
//   tsx tools/concept-clusters.mts <project.sqlite>
//
// Concepts that share a SQL core, grouped, with the value each last produced beside it. Two independent
// signals — structure and answer — and the reading depends on how they line up:
//
//   same structure, same value          a DUPLICATE: one measure written twice
//   same structure, different values    a PARAMETER: one measure asked over different windows or subjects
//   same structure, different axes      ONE MEASURE, SEVERAL AXES: the same thing grouped different ways
//
// The case this cannot see is the interesting one: two bodies computing the same thing by different routes
// share no core, so they never cluster. High precision, low recall, by design.
//
// REPORTING ONLY. Nothing is merged, and nothing should be: which of two concepts survives is a judgement
// about what people mean, and the store has no way to make it.

import { NodeStore, signatureClusters, clusterVerdict, getSample, namesFor } from '@superatom/node-store'

const [dbPath] = process.argv.slice(2)
if (!dbPath) { console.error('usage: tsx tools/concept-clusters.mts <project.sqlite>'); process.exit(1) }

const store = new NodeStore(dbPath)
const clusters = signatureClusters(store.db).filter((c) => c.members.length > 1)

if (!clusters.length) console.log('No two live concepts share a SQL core.')

for (const c of clusters) {
  const members = c.members.map((m) => {
    const sample = getSample(store.db, m.conceptId)
    return { ...m, value: sample?.value, rows: sample?.rows, names: namesFor(store, m.conceptId) }
  })
  const verdict = clusterVerdict(members)
  console.log(`\n${verdict.toUpperCase()}  · core ${c.coreHash} · ${members.length} concepts`)
  for (const m of members) {
    const axis = m.dimension?.length ? `by ${m.dimension.join(', ')}` : 'no grouping'
    const value = m.value === undefined ? 'never run' : typeof m.value === 'number'
      ? m.value.toLocaleString(undefined, { maximumFractionDigits: Number.isInteger(m.value) ? 0 : 4 })
      : JSON.stringify(m.value)
    console.log(`   ${(m.name ?? m.conceptId).padEnd(34)} ${value.padStart(16)}  ${axis}${m.degraded ? '  [signature degraded]' : ''}`)
    if (m.names.length > 1) console.log(`   ${' '.repeat(34)} also called: ${m.names.filter((n) => n !== m.name).join(', ')}`)
  }
}

const degraded = clusters.flatMap((c) => c.members).filter((m) => m.degraded).length
if (degraded) console.log(`\n${degraded} member(s) have a degraded signature — part of their SQL could not be parsed, so they will not cluster with an equivalent query written differently.`)
store.close()
