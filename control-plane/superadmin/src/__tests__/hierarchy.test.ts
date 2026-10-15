// The hierarchy, computed from capabilities (shared/permissions.ts): who is above whom follows from what each holds,
// including what it implies; equals and those apart leave each other alone.
import { describe, expect, it } from 'vitest'
import { compare, outranks, whyNot, weight, effective, ORG_ROLES, PROJECT_ROLES, ORG_CAPABILITY_GROUPS, ORG_CAPABILITIES, ALL } from '../../../shared/permissions'

const P = PROJECT_ROLES, O = ORG_ROLES
const caps = (r: { capabilities: readonly string[] }) => r.capabilities

describe('the hierarchy', () => {
  it('the built-in project roles form a ladder: admin > developer > member > viewer', () => {
    expect(compare(caps(P.admin), caps(P.developer))).toBe('above')
    expect(compare(caps(P.developer), caps(P.member))).toBe('above')   // develop, and everything a member does
    expect(compare(caps(P.member), caps(P.viewer))).toBe('above')
    expect(compare(caps(P.viewer), caps(P.admin))).toBe('below')
    expect(compare(caps(P.admin), caps(P.admin))).toBe('equal')
  })
  it('the organisation\'s: owner > admin > member; org.roles implies everything, so an owner is above any project role', () => {
    expect(compare(caps(O.owner), caps(O.admin))).toBe('above')
    expect(compare(caps(O.admin), caps(O.member))).toBe('above')
    expect(effective(['org.roles']).size).toBe(ALL.length)
    expect(outranks(caps(O.owner), caps(P.admin))).toBe(true)
    expect(compare(['org.roles'], caps(O.owner))).toBe('equal')        // a role holding org.roles is an owner, however narrow it looks
  })
  it('custom roles take their place by what they hold; two holding different things are apart', () => {
    const analyst = [...caps(P.member), 'project.data']
    expect(compare(analyst, caps(P.member))).toBe('above')
    expect(compare(caps(P.admin), analyst)).toBe('above')
    expect(compare(analyst, caps(P.developer))).toBe('apart')          // data vs develop: neither above
    expect(compare(['org.billing'], ['org.keys'])).toBe('apart')
  })
  it('a refusal says why, and who can do it', () => {
    expect(whyNot(caps(P.admin), caps(P.admin), 'revoke')).toMatch(/they hold as much as you do — someone above you both/)
    expect(whyNot(caps(P.member), caps(P.admin), 'remove')).toMatch(/they hold more than you do/)
    expect(whyNot(['org.billing'], ['org.keys'], 'revoke')).toMatch(/they hold things you do not/)
    expect(whyNot(caps(P.admin), caps(P.member), 'remove')).toBeNull()
  })
  it('the display order follows weight (heavier capabilities first); every organisation capability is in exactly one group', () => {
    const order = Object.values(P).sort((a, b) => weight(b.capabilities) - weight(a.capabilities)).map((r) => r.id)
    expect(order).toEqual(['admin', 'developer', 'member', 'viewer'])
    const grouped = ORG_CAPABILITY_GROUPS.flatMap((g) => g.capabilities)
    expect([...grouped].sort()).toEqual(Object.keys(ORG_CAPABILITIES).sort())
    expect(new Set(grouped).size).toBe(grouped.length)
  })
})
