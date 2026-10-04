import { describe, expect, it } from 'vitest'
import { checkPolicy, literal, resolve, type AccessPolicy } from '../access-policies'

const P = (over: Partial<AccessPolicy>): AccessPolicy => ({ id: 'p', applies_to: 'everyone', source: 'TG', table: 'trips', kind: 'row', predicate: '{t}.branch = 1', ...over } as AccessPolicy)

describe('access policies', () => {
  it('are checked in sentences', () => {
    expect(checkPolicy(P({}))).toEqual([])
    expect(checkPolicy(P({ applies_to: 'nobody' as any, predicate: 'branch = 1' }))).toEqual(['a policy applies to everyone, role:<role>, email:<address> or agent:<key id>', 'a row predicate names the table as {t} (so it applies however the query aliases it)'])
    expect(checkPolicy(P({ predicate: '{t}.a = 1; DROP TABLE x' }))).toEqual(['a row predicate is one boolean expression: no ";", no comments'])
    expect(checkPolicy(P({ kind: 'mask', column: '' }))).toEqual(['a mask policy names its column'])
    expect(checkPolicy(P({ table: 'a b' }))).toEqual(['a policy names its table (an identifier, optionally schema-qualified)'])
  })
  it('render attributes as literals, never as text pasted in', () => {
    expect(literal("O'Brien")).toBe("'O''Brien'")
    expect(literal(['HYDERABAD', 'PUNE'])).toBe("('HYDERABAD', 'PUNE')")
    expect(literal(3)).toBe('3')
    expect(() => literal({ a: 1 })).toThrow(/an attribute is a number/)
  })
  it('apply to everyone, a role, an email or an agent, for one source; an attribute the reader lacks denies the table', () => {
    const policies = [
      P({ id: '1', predicate: '{t}.branch IN {attr.branches}' }),
      P({ id: '2', applies_to: 'role:viewer', kind: 'mask', column: 'balance', predicate: null }),
      P({ id: '3', applies_to: 'email:Ana@X.io', table: 'salaries', kind: 'deny', predicate: null }),
      P({ id: '4', applies_to: 'agent:key_7', table: 'ledger', kind: 'deny', predicate: null }),
      P({ id: '5', source: 'OTHER', table: 'x', kind: 'deny', predicate: null }),
    ]
    expect(resolve(policies, 'TG', { principal: 'user:u1', email: 'ana@x.io', role: 'viewer', attributes: { branches: ['HYDERABAD'] } })).toEqual([
      { table: 'trips', predicate: "{t}.branch IN ('HYDERABAD')" },
      { table: 'trips', column: 'balance', mask: 'null' },
      { table: 'salaries', deny: true },
    ])
    expect(resolve(policies, 'TG', { principal: 'agent:key_7', attributes: {} })).toEqual([{ table: 'trips', deny: true }, { table: 'ledger', deny: true }])
  })
})
