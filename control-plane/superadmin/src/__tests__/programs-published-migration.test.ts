// Migration 44: from now on a program runs its newest PUBLISHED build, so once, the build each program ran until now
// (its newest) is published where no published build is as new — nothing anyone sees changes on the day.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { PROJECT_MIGRATIONS } from '../migrations'

const up = (id: number) => PROJECT_MIGRATIONS.find((m) => m.id === id)!.up as string

describe('what each program ran, published', () => {
  it('publishes the newest build of a name only when nothing published is as new; never touches the rest', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(up(16))
    const add = (hash: string, name: string, at: string, published: string | null = null) =>
      db.prepare("INSERT INTO programs (hash, name, version, scope, owner, manifest, bytes, built_by, uploaded_at, published_at, published_by) VALUES (?, ?, 1, 'global', 'u', '{}', 1, 'u', ?, ?, ?)").run(hash, name, at, published, published ? 'u' : null)
    add('a1', 'never-published', '2026-10-01'); add('a2', 'never-published', '2026-10-05')
    add('b1', 'published-is-newest', '2026-10-01', '2026-10-02'); add('b0', 'published-is-newest', '2026-09-01')
    add('c1', 'newer-than-published', '2026-10-01', '2026-10-01'); add('c2', 'newer-than-published', '2026-10-09')
    db.exec(up(44))
    const pub = (h: string) => (db.prepare('SELECT published_at FROM programs WHERE hash = ?').get(h) as any).published_at
    expect([pub('a1'), !!pub('a2')]).toEqual([null, true])
    expect([pub('b1'), pub('b0')]).toEqual(['2026-10-02', null])
    expect([pub('c1'), !!pub('c2')]).toEqual(['2026-10-01', true])
  })
})
