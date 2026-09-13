// ── HOW AN ANSWER WAS REACHED ─────────────────────────────────────────────────────────────────────────────
//
// Read from memory, not reconstructed: every line is a call that happened, naming the exact program that ran.
// That is what makes an explanation trustworthy — it cannot describe a calculation other than the one performed.

import type { GraphStore } from './store.js'

export function trace(store: GraphStore, callId: string, indent = ''): string {
  const c = store.getCall(callId)
  if (!c) return `${indent}(no call ${callId})`
  const status = c.error ? `FAILED — ${c.error}` : summarise(c.output)
  const lines = [`${indent}${c.name}  ${c.hash}  ${JSON.stringify(c.request)}  → ${status}  ${c.ms}ms`]
  for (const d of c.decisions) lines.push(`${indent}   decided  ${d.label}: ${d.took ? 'yes' : 'no'} — ${d.reason}`)
  for (const v of c.verifications) lines.push(`${indent}   ${v.held ? 'held' : 'FAILED'}     ${v.label}${v.detail ? ` — ${v.detail}` : ''}`)
  for (const cv of c.caveats) lines.push(`${indent}   caveat   ${cv}`)
  for (const child of store.children(c.id)) lines.push(trace(store, child.id, indent + '   '))
  return lines.join('\n')
}

function summarise(output: unknown): string {
  if (Array.isArray(output)) return `${output.length} row(s)`
  if (output && typeof output === 'object' && (output as any).truncated) return `${(output as any).totalRows} row(s), kept 500`
  return JSON.stringify(output)
}
