// ── THE CODE THAT DECIDES WHO GETS A KEY ─────────────────────────────────────────────────────────────────
//
// Everything tested here is a pure function with an outsized consequence: these are the paths that decide
// whether a caller is handed a credential attached to a payment card. They were the only part of the system
// with no test at all, which is the wrong way round — `decide` and `candidates` are the easiest things in the
// repo to test and the most expensive to get wrong.
//
// The routing cases exist because that fact used to be stated in four places and drifted. A test that asserts
// the DERIVATIONS is what stops it drifting back: add a provider on the wrong route and something here fails
// rather than a composer somewhere getting a 421 that reads like a broken model.

import { describe, it, expect } from 'vitest'
import { decide, providersOn, hostsOn, allHosts, boxSide, hostMatches, parsePath, bearerOf, isProjectKey,
         usageFrom, usageFromSseTail, isDisabled, disabledReason, PROVIDERS } from '../../../../vm/packages/agent-contract/contract.mjs'
import { candidates, usable, groupOf, markSpent, tidy, expiryOf, redact, type Vault } from '../proxy/vault.js'
import { seal, unseal, sealKeygen, isSealed } from '../proxy/seal.js'

// ── WHO GETS A KEY ───────────────────────────────────────────────────────────────────────────────────────

describe('decide — the one authorisation rule both proxies apply', () => {
  it('refuses to spend our key for a caller that proved nothing', () => {
    const d = decide({ projectId: 'p1', sentCredential: null, proven: false })
    expect(d.ok).toBe(false)
    expect((d as any).status).toBe(401)
  })

  it('attaches a key once the project is proven', () => {
    const d = decide({ projectId: 'p1', sentCredential: 'sk-proj-abc12345', proven: true })
    expect(d).toMatchObject({ ok: true, attachKey: true, project: 'p1' })
  })

  it('rejects a project key that does not belong to the project named in the path', () => {
    // The forged-id case. Claiming a project you cannot prove must never reach a credential.
    const d = decide({ projectId: 'someone-elses', sentCredential: 'sk-proj-abc12345', proven: false })
    expect(d.ok).toBe(false)
    expect((d as any).error).toMatch(/not valid for this project/i)
  })

  it("leaves a caller's OWN provider credential alone", () => {
    // claude-code arrives with its own subscription token. Substituting ours would bill the wrong account and
    // answer as the wrong identity, so the request is forwarded untouched.
    const d = decide({ projectId: 'p1', sentCredential: 'sk-ant-oat01-something', proven: false })
    expect(d).toMatchObject({ ok: true, attachKey: false })
  })
})

describe('isProjectKey — what counts as one of ours', () => {
  it('accepts our shape and rejects everything else', () => {
    expect(isProjectKey('sk-proj-234ba478-fac7')).toBe(true)
    expect(isProjectKey('sk-ant-oat01-abc')).toBe(false)
    expect(isProjectKey('')).toBe(false)
    expect(isProjectKey(null)).toBe(false)
  })
})

// ── WHICH KEY, FOR WHICH PROJECT ─────────────────────────────────────────────────────────────────────────

const vault = (over: Partial<Vault> = {}): Vault => ({
  entries: [], groups: {}, spent: {}, ...over,
} as Vault)

const entry = (o: Partial<any> = {}) => ({ id: 'e1', provider: 'opencode-go', value: 'k', ...o })

describe('candidates — which credentials a project may use', () => {
  it('serves an ungrouped entry to any project', () => {
    const v = vault({ entries: [entry()] })
    expect(candidates(v, 'opencode-go', 'any-project').map(e => e.id)).toEqual(['e1'])
  })

  it('keeps groups apart, so one group cannot spend another group\'s key', () => {
    const v = vault({
      entries: [entry({ id: 'prod', groups: ['prod'] }), entry({ id: 'test', groups: ['test'] })],
      groups: { p1: 'prod' },
    })
    expect(candidates(v, 'opencode-go', 'p1').map(e => e.id)).toEqual(['prod'])
  })

  it('sends an unassigned project to the default group', () => {
    const v = vault({ entries: [entry({ groups: ['prod'] })] })
    expect(groupOf(v, 'unknown')).toBe('default')
    expect(candidates(v, 'opencode-go', 'unknown')).toEqual([])
  })

  it('skips a disabled entry', () => {
    const v = vault({ entries: [entry({ disabled: true })] })
    expect(candidates(v, 'opencode-go', 'p1')).toEqual([])
  })

  it('skips an expired entry, and serves one that has not expired', () => {
    const now = 1_000_000
    const v = vault({ entries: [entry({ id: 'old', expiresAt: now - 1 }), entry({ id: 'ok', expiresAt: now + 1 })] })
    expect(candidates(v, 'opencode-go', 'p1', now).map(e => e.id)).toEqual(['ok'])
  })

  it('skips one that is spent, and takes it back when the cooldown passes', () => {
    const now = 1_000_000
    const v = markSpent(vault({ entries: [entry()] }), 'e1', 60, now)
    expect(candidates(v, 'opencode-go', 'p1', now)).toEqual([])
    expect(candidates(v, 'opencode-go', 'p1', now + 61_000).map(e => e.id)).toEqual(['e1'])
  })

  it('never returns another provider\'s key', () => {
    const v = vault({ entries: [entry({ provider: 'openrouter' })] })
    expect(candidates(v, 'opencode-go', 'p1')).toEqual([])
  })
})

describe('tidy / usable', () => {
  it('drops spent marks that have elapsed and keeps live ones', () => {
    const now = 1_000
    const v = tidy(vault({ spent: { gone: now - 1, live: now + 5_000 } }), now)
    expect(Object.keys(v.spent!)).toEqual(['live'])
  })
  it('treats an entry with no expiry as usable forever', () => {
    expect(usable(entry() as any, Date.now())).toBe(true)
  })
})

describe('redact — values never leave the Worker', () => {
  it('strips every credential value', () => {
    const r: any = redact(vault({ entries: [entry({ value: 'super-secret' })] }))
    expect(JSON.stringify(r)).not.toContain('super-secret')
  })
})

describe('expiryOf — reading a JWT expiry without trusting it', () => {
  it('reads exp from a JWT body', () => {
    const body = Buffer.from(JSON.stringify({ exp: 2_000_000 })).toString('base64url')
    expect(expiryOf(`x.${body}.y`)).toBe(2_000_000_000)
  })
  it('says nothing for a value that is not a JWT', () => {
    expect(expiryOf('sk-ant-oat01-not-a-jwt')).toBeUndefined()
  })
})

// ── ENCRYPTION AT REST ───────────────────────────────────────────────────────────────────────────────────

describe('seal / unseal', () => {
  it('round-trips, and the ciphertext does not contain the plaintext', async () => {
    const master = sealKeygen()
    const secret = 'sk-ant-oat01-a-real-looking-token'
    const blob = await seal(secret, master)
    expect(blob).not.toContain(secret)
    expect(isSealed(blob)).toBe(true)
    expect(await unseal(blob, master)).toBe(secret)
  })

  it('produces a different ciphertext each time (fresh iv)', async () => {
    const master = sealKeygen()
    expect(await seal('same', master)).not.toBe(await seal('same', master))
  })

  it('refuses to decrypt with the wrong master key', async () => {
    const blob = await seal('secret', sealKeygen())
    await expect(unseal(blob, sealKeygen())).rejects.toThrow()
  })

  it('refuses tampered ciphertext (GCM authentication)', async () => {
    const master = sealKeygen()
    const [v, iv, ct] = (await seal('secret', master)).split('.')
    const flipped = ct.slice(0, -2) + (ct.slice(-2) === 'AA' ? 'AB' : 'AA')
    await expect(unseal([v, iv, flipped].join('.'), master)).rejects.toThrow()
  })
})

// ── ROUTING: DERIVED, NOT RESTATED ───────────────────────────────────────────────────────────────────────

describe('routing derivations — the fact that used to live in four places', () => {
  it('puts the ChatGPT backend on the tunnel, because it refuses to be relayed', () => {
    expect(providersOn('tunnel')).toContain('openai-codex')
    expect(PROVIDERS['openai-codex'].base).toBeUndefined()
  })

  it('puts claude-code on the box, because it will not make a request without a local login', () => {
    expect(boxSide()).toEqual([{ provider: 'claude-code', envVar: 'CLAUDE_CODE_OAUTH_TOKEN' }])
  })

  it('gives every relayed provider a base URL and a header (a relay without one 401s)', () => {
    for (const name of providersOn('relay')) {
      expect(PROVIDERS[name].base, `${name} base`).toBeTruthy()
      expect(typeof PROVIDERS[name].header, `${name} header`).toBe('function')
    }
  })

  it('tunnels the hosts of tunnel-route providers, including the token endpoint', () => {
    // Carrying chatgpt.com but not auth.openai.com fails at renewal, hours later, looking like an expiry.
    expect(hostsOn('tunnel')).toEqual(expect.arrayContaining(['chatgpt.com', 'auth.openai.com']))
  })

  it('allows every provider host through CONNECT and nothing else', () => {
    const all = allHosts()
    for (const p of Object.values(PROVIDERS)) for (const h of p.hosts ?? []) expect(all).toContain(h)
    expect(all).not.toContain('169.254.169.254')
  })

  it('matches subdomains but not lookalike domains', () => {
    expect(hostMatches('api.chatgpt.com', ['chatgpt.com'])).toBe(true)
    expect(hostMatches('chatgpt.com', ['chatgpt.com'])).toBe(true)
    expect(hostMatches('CHATGPT.COM', ['chatgpt.com'])).toBe(true)
    expect(hostMatches('evil-chatgpt.com', ['chatgpt.com'])).toBe(false)
    expect(hostMatches('chatgpt.com.evil.net', ['chatgpt.com'])).toBe(false)
  })
})

describe('disabled providers — a decision both proxies enforce', () => {
  it('marks openrouter off, with a reason', () => {
    expect(isDisabled('openrouter')).toBe(true)
    expect(disabledReason('openrouter')).toBeTruthy()
  })

  it('leaves the providers we actually use enabled', () => {
    for (const p of ['opencode-go', 'openai-codex', 'claude-code']) expect(isDisabled(p)).toBe(false)
  })

  it('says nothing is disabled for an unknown provider rather than throwing', () => {
    expect(isDisabled('does-not-exist')).toBe(false)
    expect(disabledReason('does-not-exist')).toBe(null)
  })
})

describe('parsePath / bearerOf', () => {
  it('splits a provider call', () => {
    expect(parsePath('/p/proj-1/opencode-go/chat/completions')).toMatchObject({
      projectId: 'proj-1', provider: 'opencode-go', rest: 'chat/completions', service: null,
    })
  })
  it('recognises our own service routes', () => {
    expect(parsePath('/p/proj-1/_key/claude-code')).toMatchObject({
      projectId: 'proj-1', service: '_key', arg: 'claude-code', provider: null,
    })
  })
  it('reads a credential from either header', () => {
    expect(bearerOf((h) => (h === 'authorization' ? 'Bearer abc' : null))).toBe('abc')
    expect(bearerOf((h) => (h === 'x-api-key' ? 'xyz' : null))).toBe('xyz')
    expect(bearerOf(() => null)).toBe(null)
  })
})

describe('usage parsing', () => {
  it('reads both provider spellings', () => {
    expect(usageFrom({ usage: { prompt_tokens: 3, completion_tokens: 4 } })).toEqual({ in: 3, out: 4 })
    expect(usageFrom({ usage: { input_tokens: 5, output_tokens: 6 } })).toEqual({ in: 5, out: 6 })
  })
  it('reports nothing rather than a wrong number', () => {
    expect(usageFrom({})).toBe(null)
    expect(usageFrom({ usage: {} })).toBe(null)
  })
  it('takes the last usage frame from an SSE tail and survives a partial frame', () => {
    const tail = 'data: {"usage":{"input_tokens":1,"output_tokens":1}}\ndata: {"usage":{"input_tokens":9,"output_tokens":2}}\ndata: {"par'
    expect(usageFromSseTail(tail)).toEqual({ in: 9, out: 2 })
  })
})
