// Development environments as the project keeps them (dev-envs.ts): one attached per person, overrides checked, and
// left an hour without sacli an environment is detached — its owner sees what is published, the engine is told — but
// kept to resume; never deleted for being unused.
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { PROJECT_MIGRATIONS } from '../migrations'
import { DevEnvs, DETACH_AFTER_MS } from '../dev-envs'

const setup = () => {
  const db = new DatabaseSync(':memory:')
  db.exec(PROJECT_MIGRATIONS.find((m) => m.id === 45)!.up as string)
  const sql = { exec: (q: string, ...p: unknown[]) => db.prepare(q).all(...(p as any[])) as Record<string, unknown>[] }
  let t = 1_000_000
  const cleared: string[] = []
  return { envs: new DevEnvs(sql, (id) => cleared.push(id), () => t), cleared, tick: (ms: number) => { t += ms } }
}
const H = 'a'.repeat(64)

describe('development environments', () => {
  it('one attached per person: attaching another detaches the first and clears it on the engine', () => {
    const { envs, cleared } = setup()
    const a = envs.create('ana@x.io', 'one'), b = envs.create('ana@x.io', 'two')
    envs.attach('ana@x.io', a.id, { programs: { p: H } })
    envs.attach('ana@x.io', b.id, {})
    expect(envs.list('ana@x.io').map((e) => [e.name, e.status])).toEqual([['two', 'attached'], ['one', 'detached']])
    expect(cleared).toEqual([a.id])
    expect(() => envs.create('ana@x.io', 'two')).toThrow(/already/)
    expect(() => envs.attach('ana@x.io', b.id, { programs: { p: 'nope' } })).toThrow(/by its hash/)
  })
  it('left an hour without sacli it is detached — and kept; a ping keeps it attached', () => {
    const { envs, cleared, tick } = setup()
    const e = envs.create('ana@x.io', 'work')
    envs.attach('ana@x.io', e.id, { programs: { p: H } })
    tick(DETACH_AFTER_MS - 1000); envs.ping('ana@x.io', e.id)
    tick(DETACH_AFTER_MS - 1000)
    expect(envs.overlayFor('ana@x.io')).toMatchObject({ id: e.id, programs: { p: H } })
    tick(DETACH_AFTER_MS + 1)
    expect(envs.overlayFor('ana@x.io')).toBeNull()
    expect(cleared).toEqual([e.id])
    expect(envs.list('ana@x.io')).toEqual([expect.objectContaining({ id: e.id, status: 'detached' })])
    tick(365 * 86_400_000)
    expect(envs.list('ana@x.io')).toHaveLength(1)
  })
  it('only its owner changes it; a project admin may delete it; the list is the people\'s', () => {
    const { envs } = setup()
    const e = envs.create('ana@x.io', 'work')
    expect(() => envs.detach('bo@x.io', e.id)).toThrow(/ana@x\.io's/)
    expect(() => envs.delete('bo@x.io', e.id)).toThrow(/ana@x\.io's/)
    envs.create('bo@x.io', 'other')
    expect(envs.list(null)).toHaveLength(2)
    envs.delete('bo@x.io', e.id, true)
    expect(envs.list(null).map((x) => x.owner)).toEqual(['bo@x.io'])
  })
  it('what a person\'s browser shows: the environment they are in (with what it changes), and a notice when it ends — the hour\'s silent detach too', () => {
    const { envs, tick } = setup()
    const ended: string[] = []
    envs.onEnd = (owner) => ended.push(owner)
    const a = envs.create('ana@x.io', 'pmo')
    expect(envs.attachedOf('ana@x.io')).toBeNull()
    envs.attach('ana@x.io', a.id, { programs: { 'pmo-health': H }, agents: { revenue: { title: 'R' } } })
    expect(envs.attachedOf('ana@x.io')).toMatchObject({ name: 'pmo', status: 'attached', names: ['program pmo-health', 'agent revenue'] })
    expect(envs.attachedOf('raj@x.io')).toBeNull()
    envs.detach('ana@x.io', a.id)
    expect(ended).toEqual(['ana@x.io'])
    expect(envs.attachedOf('ana@x.io')).toBeNull()
    envs.attach('ana@x.io', a.id, {})
    tick(DETACH_AFTER_MS + 1)
    expect(envs.overlayFor('ana@x.io')).toBeNull()   // an hour without sacli: detached
    expect(ended).toEqual(['ana@x.io', 'ana@x.io'])
  })
})
