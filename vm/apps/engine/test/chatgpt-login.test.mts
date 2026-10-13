// The engine's ChatGPT login (ica/chatgpt-login.ts), with the platform played by a fake: on a box of the platform the
// login comes from the vault and is held in memory, pi "renewing" it asks the vault again and never ChatGPT, nothing of
// it is written to pi's file, and where the vault has none for this project the machine's own login serves.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

Object.assign(process.env, { SUPERATOM_PLATFORM: 'example.test', ICA_PROJECT: 'p-1', ICA_KEY: 'sk-proj-test' })
const calls: string[] = []
let vault: 'login' | 'none' = 'login', n = 0
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  calls.push(String(url))
  assert.ok(!String(url).includes('auth.openai.com'), 'the engine never renews: that is the platform\'s')
  assert.equal((init?.headers as any)?.authorization, 'Bearer sk-proj-test')
  if (vault === 'none') return new Response(JSON.stringify({ error: 'no credential in the vault for openai-codex' }), { status: 503 })
  n++
  return new Response(JSON.stringify({ provider: 'openai-codex', keyId: 'gpt-a', key: `access-${n}`, accountId: 'acct-A', expiresAt: Date.now() + 9 * 86_400_000, login: true }))
}) as any

const { vaultCredentialStore } = await import('../ica/chatgpt-login.ts')

test('the vault\'s login, in memory; pi renewing it asks the vault again; nothing of it on disk', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'pi-')), 'auth.json')
  const store = vaultCredentialStore(file)
  const c = await store.read('openai-codex') as any
  assert.deepEqual({ type: c.type, access: c.access, accountId: c.accountId }, { type: 'oauth', access: 'access-1', accountId: 'acct-A' })
  assert.equal((await store.read('openai-codex') as any).access, 'access-1', 'held, not fetched again')
  assert.equal(calls.length, 1)
  const renewed = await store.modify('openai-codex', async () => { throw new Error('pi must not renew it itself') }) as any
  assert.equal(renewed.access, 'access-2')
  assert.ok(calls.every((u) => u === 'https://proxy.example.test/p/p-1/_key/openai-codex'))
  assert.ok(!existsSync(file) || !readFileSync(file, 'utf8').includes('access-'), 'never written to pi\'s file')
})

test('where the vault has none for this project, the machine\'s own login serves; other providers are pi\'s file', async () => {
  vault = 'none'
  const { vaultCredentialStore: fresh } = await import(`../ica/chatgpt-login.ts?none`)
  const file = join(mkdtempSync(join(tmpdir(), 'pi-')), 'auth.json')
  writeFileSync(file, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'own', refresh: 'own-r', expires: Date.now() + 86_400_000 }, anthropic: { type: 'api_key', key: 'k' } }))
  const store = fresh(file)
  assert.equal((await store.read('openai-codex') as any).access, 'own')
  assert.equal((await store.read('anthropic') as any).key, 'k')
  assert.deepEqual((await store.list()).map((x: any) => x.providerId).sort(), ['anthropic', 'openai-codex'])
})
