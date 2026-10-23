// The settings programs read, kept whole: the catalogue says which settings the programs everyone runs declare (each
// name's newest published build), and a knowledge version that would take one away is refused, naming it.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { PROJECT_MIGRATIONS } from '../migrations'
import { ProgramCatalogue } from '../program-catalogue'
import { settingsLost } from '../graph'

describe('settings in use', () => {
  it('the catalogue: each program\'s newest published build, by what its manifest declares — drafts and older builds do not count', () => {
    const db = new DatabaseSync(':memory:')
    const m = PROJECT_MIGRATIONS.find((x) => /CREATE TABLE IF NOT EXISTS programs/.test(String(x.up)))!
    db.exec(m.up as string)
    const sql = { exec: (q: string, ...p: unknown[]) => db.prepare(q).all(...(p as any[])) as Record<string, unknown>[] }
    const row = (hash: string, name: string, at: string, published: boolean, settings?: string[]) =>
      db.prepare('INSERT INTO programs (hash, name, version, scope, owner, manifest, bytes, built_by, uploaded_at, published_at) VALUES (?, ?, 1, ?, ?, ?, 1, ?, ?, ?)')
        .run(hash, name, 'global', 'u', JSON.stringify({ name, ...(settings ? { settings } : {}) }), 'u', at, published ? at : null)
    row('a1', 'views', '2026-10-01', true, ['reporting-currency-code'])
    row('a2', 'views', '2026-10-20', true, ['a-floor'])      // the newest published: it counts
    row('a3', 'views', '2026-10-22', false, ['something-new'])              // a draft: not yet
    row('b1', 'pmo', '2026-10-20', true)                                     // reads none
    const c = new ProgramCatalogue(sql as any, {} as any, () => 'p', () => ({}) as any)
    expect(c.settingsInUse()).toEqual([{ program: 'views', settings: ['a-floor'] }])
  })
  it('a version that takes a setting away is refused, naming it and its program; one that keeps them all is not', () => {
    const inUse = [{ program: 'views', settings: ['a-floor', 'a-threshold'] }]
    expect(settingsLost(['a-floor', 'a-threshold', 'other'], inUse)).toBeNull()
    expect(settingsLost(['a-floor'], inUse)).toBe('this version would take away a setting a published program reads: "a-threshold" (views reads it) — keep it in the knowledge, or publish the program without it first')
  })
})
