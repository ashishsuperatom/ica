// ── IDENTITY IS CONTENT ───────────────────────────────────────────────────────────────────────────────────
//
// A program is its body and its contract. Change either and it is a different program, with a different hash,
// by construction — immutability is arithmetic rather than a rule anyone has to keep.
//
// The NAME is left out. A name is a pointer to a program, and the same program reached by two names is one
// program. Folding the name in would make a rename mint a new program, which is exactly the fork the concept
// store suffered when naming lived inside identity.

import { createHash } from 'node:crypto'
import type { Contract } from './contract.js'

/** Key order must not change a hash, or the same contract written twice would be two programs. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function programHash(body: string, contract: Contract): string {
  const { name: _name, ...meaning } = contract
  return 'prog:' + createHash('sha256').update(canonical({ body, contract: meaning })).digest('hex').slice(0, 16)
}
