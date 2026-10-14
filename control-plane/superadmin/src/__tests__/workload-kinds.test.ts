// The workload kinds (vm/packages/platform-types/src/workloads.ts): every capability they name is a real one; a status the
// engine sends is checked; a spec hash is the same for the same wanted thing whatever the order of its keys.
import { describe, expect, it } from 'vitest'
import { WORKLOAD_KINDS, checkWorkloadStatus, specOf } from '../../../../vm/packages/platform-types/src/index.js'
import { PROJECT_CAPABILITIES } from '../../../shared/permissions'

describe('workload kinds', () => {
  it('every capability a kind names is a project capability', () => {
    for (const [kind, k] of Object.entries(WORKLOAD_KINDS)) {
      const named = [k.see, ...Object.values(k.actions).map((a: any) => a.needs), ...Object.values(k.aspects).map((a: any) => a.needs)]
      for (const c of named) expect(c in PROJECT_CAPABILITIES, `${kind}: ${c}`).toBe(true)
    }
  })
  it('a sound status passes; a wrong kind, state, error or health is named', () => {
    expect(checkWorkloadStatus({ kind: 'connection', id: 'F5NETSUITE', state: 'ready', health: { queries: 3, ok: true } })).toEqual([])
    const bad = checkWorkloadStatus({ kind: 'robot', id: '', state: 'happy', error: 'x', health: { rows: [1] } })
    expect(bad.join(' | ')).toMatch(/kind "robot".*id is missing.*state "happy".*error must be.*health holds only/)
  })
  it('a spec hash ignores the order of keys, and changes with any value', () => {
    expect(specOf({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(specOf({ b: { d: [1, 2], c: 2 }, a: 1 }))
    expect(specOf({ a: 1 })).not.toBe(specOf({ a: 2 }))
    expect(specOf({ a: 1 })).toMatch(/^[0-9a-f]{8}$/)
  })
})
