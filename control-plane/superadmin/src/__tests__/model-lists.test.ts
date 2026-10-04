// One model, many names: switching the account an agent runs through must never mean retyping its model, and a
// profile that cannot run must be refused when it is saved.
import { describe, it, expect } from 'vitest'
import { modelOn, modelKey, nearModels } from '../../../../vm/packages/agent-contract/contract.mjs'
import { checkProfile } from '../model-lists.js'

const OR = ['anthropic/claude-haiku-4.5', 'anthropic/claude-sonnet-5', 'openai/gpt-6-luna', 'deepseek/deepseek-v4.1-flash', 'qwen/qwen3.5-35b-a3b']
const lists = { openrouter: OR, 'claude-code': ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], 'opencode-go': ['gpt-6-luna', 'deepseek-v4.1-flash'] }

describe('modelOn — the same model in another account\'s spelling', () => {
  it('translates both ways', () => {
    expect(modelOn('claude-haiku-4-5', OR)).toBe('anthropic/claude-haiku-4.5')
    expect(modelOn('anthropic/claude-haiku-4.5', lists['claude-code'])).toBe('claude-haiku-4-5')
    expect(modelOn('gpt-6-luna', OR)).toBe('openai/gpt-6-luna')
    expect(modelOn('openai/gpt-6-luna', lists['opencode-go'])).toBe('gpt-6-luna')
  })
  it('never picks an alias or a variant, and refuses an ambiguous name', () => {
    expect(modelOn('gpt-6-luna', ['openai/gpt-6-luna:batch', '~openai/gpt-6-luna'])).toBe(null)
    expect(modelOn('m-1', ['a/m-1', 'b/m.1'])).toBe(null)
  })
  it('does not stretch a name into a different model', () => {
    expect(modelOn('claude-haiku-4', OR)).toBe(null)
    expect(modelOn('qwen3.5-35b', OR)).toBe(null)
    expect(modelKey('qwen/qwen3.5-35b-a3b')).toBe('qwen3-5-35b-a3b')
  })
  it('suggests what was probably meant', () => {
    expect(nearModels('claude-haiku-4', OR)[0]).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('checkProfile — refused on save, translated when it can run', () => {
  it('keeps the model when the account changes, in the new spelling', () => {
    const { profile, problems } = checkProfile({ agents: { analyst: { harness: 'claude-code-pty', provider: 'openrouter', model: 'claude-sonnet-5' } } }, lists)
    expect(problems).toEqual([])
    expect(profile.agents.analyst.model).toBe('anthropic/claude-sonnet-5')
    const back = checkProfile({ agents: { analyst: { ...profile.agents.analyst, provider: 'claude-code' } } }, lists)
    expect(back.profile.agents.analyst.model).toBe('claude-sonnet-5')
  })
  it('refuses a model the account does not serve, naming the nearest', () => {
    const { problems } = checkProfile({ agents: { composer: { harness: 'pi', provider: 'openrouter', model: 'claude-haiku-4' } } }, lists)
    expect(problems[0]).toMatch(/does not serve claude-haiku-4 — did you mean anthropic\/claude-haiku-4.5/)
  })
  it('refuses an account the harness cannot use, and an unknown account', () => {
    expect(checkProfile({ agents: { a: { harness: 'claude-code-pty', provider: 'opencode-go', model: 'gpt-6-luna' } } }, lists).problems[0]).toMatch(/cannot use/)
    expect(checkProfile({ agents: { a: { harness: 'pi', provider: 'nope', model: 'x' } } }, lists).problems[0]).toMatch(/no account named/)
  })
  it('leaves an incomplete agent to the engine default', () => {
    const { profile, problems } = checkProfile({ agents: { narrator: { harness: 'pi' } } }, lists)
    expect(problems).toEqual([]); expect(profile.agents.narrator).toEqual({ harness: 'pi' })
  })
})
