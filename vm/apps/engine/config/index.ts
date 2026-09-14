// ── THE ENGINE PROFILE — one place that decides which brain each agent runs on ────────────────────────────
//
// WHAT THIS REPLACES. Every agent's harness, provider and model used to be decided by a `?? process.env.X ??
// 'literal'` chain written wherever the agent happened to be constructed — thirteen of them, across six
// files, in two contradictory directions: engine.ts inferred a MODEL FROM THE HARNESS, while ica/providers.ts
// inferred a PROVIDER FROM THE MODEL by matching the model's NAME against regexes.
//
// That is not a tidiness complaint. Two of those chains computed the SAME value from DIFFERENT literals: the
// composer ran `pi/gpt-5.6-luna` while the provenance stored for the program it authored said
// `opencode/deepseek-v4-flash`. Both read ICA_COMPOSER_*; they disagreed only when it was unset, which is the
// case on every fleet box. And the regex router's failure mode was worse: asking for a model whose account had
// no credential SILENTLY moved to a different account, which is how a composer ran for weeks on a provider
// nobody had chosen.
//
// THREE PARTS, ALWAYS ALL THREE. An agent names its harness (how we drive it), its provider (whose account
// pays) and its model (what runs) — including where a provider has no alternative, because a column that is
// sometimes absent is a column nobody can read at a glance. Nothing is inferred from anything else.
//
// TWO LAYERS, and no third:
//
//   1. default.json     — shipped in git. What a project gets when nothing is configured for it.
//   2. the project's profile — written from superadmin into ProjectDO, delivered in the engine's welcome and
//                         pushed on every change, cached here so an unreachable control plane costs nothing.
//
// THERE IS NO ENVIRONMENT LAYER. ICA_COMPOSER_MODEL and its dozen relatives are gone deliberately: an
// override that lives on one box is invisible from the place the configuration is edited, which is exactly
// how a machine ends up running something nobody can account for. Identity still comes from the environment —
// ICA_PROJECT, ICA_KEY, ICA_HUB, SUPERATOM_PLATFORM — because a box must know who it is before it can be told
// anything else. Configuration does not.
//
// NO CREDENTIALS LIVE HERE. A profile is logged, cached to disk, diffed between versions and rendered in a
// UI — four places a secret must never be. The profile says which providers a box uses; the values come from
// the vault, per provider, already audited.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Harness } from '../ica/index.js'
import { harnessCanUse, providersForHarness } from '../../../packages/agent-contract/contract.mjs'

export type AgentName = 'analyst' | 'connector' | 'grounding' | 'composer' | 'narrator'

/** All three, always.
 *
 *  `harness` is HOW we drive it — 'claude-code-pty' scrapes the CLI through a pseudo-terminal; a JSON/SDK
 *  driver for the same product would be a different harness with different cost and failure modes.
 *  `provider` is WHOSE ACCOUNT PAYS, and is a name from the agent contract — 'claude-code' there is the
 *  subscription, which is why the harness could not keep that name too.
 *  `model` is what runs.
 *
 *  All present on every agent, including where a provider has no alternative: a column that is sometimes
 *  absent is a column nobody can read at a glance. */
export interface AgentProfile {
  harness: Harness
  provider: string
  model: string
}

export interface Profile {
  version: number
  agents: Record<AgentName, AgentProfile>
  // Cautions the EDITOR renders, declared here rather than written into a React file — so adding one later is
  // a data change. Nothing in the engine reads them; they travel with the profile because the editor is seeded
  // from what the engine reports it is running, and must not invent a document of its own.
  harnessNotes?: Record<string, Record<string, { level: 'warn' | 'info'; text: string }>>
}

/** A per-construction override of an agent's profile. Six agent files each declared this inline, in three
 *  slightly different shapes — two of them missing `provider`, which is how an agent could be constructed with
 *  a model from one account and a provider from another. One declaration, next to the thing it overrides. */
export type AgentOverride = Partial<AgentProfile> & { resumeId?: string; baseUrl?: string }

const HERE = dirname(fileURLToPath(import.meta.url))
const BAKED: Profile = JSON.parse(readFileSync(join(HERE, 'default.json'), 'utf8'))

let active: Profile = BAKED
let source = 'default.json'

/** Adopt a profile. Merged PER AGENT over the baked default, so a profile naming only `composer` still gets
 *  every other agent — a partial profile is a partial override, never a replacement that silently drops what
 *  it does not mention. */
function adopt(p: Partial<Profile>, from: string): void {
  const agents = { ...BAKED.agents }
  for (const [name, a] of Object.entries(p.agents ?? {})) {
    agents[name as AgentName] = { ...agents[name as AgentName], ...(a as AgentProfile) }
  }
  active = { version: p.version ?? BAKED.version, agents, harnessNotes: p.harnessNotes ?? BAKED.harnessNotes }
  source = from
}

export const profile = (): Profile => active
export const profileSource = (): string => source

/** What this agent runs on. Every field is present, and every field came from one place. */
export function agentConfig(agent: AgentName): AgentProfile {
  const a = active.agents[agent]
  if (!a) throw new Error(`config: no agent named "${agent}" in the profile (${source})`)
  return a
}

const AGENTS: AgentName[] = ['analyst', 'connector', 'grounding', 'composer', 'narrator']

// ── THE CACHE — what this machine last successfully adopted ───────────────────────────────────────────────
// The profile arrives from the project's Durable Object. When that is unreachable — a control plane blip, a
// box starting while the network is still coming up — the alternative to a cache is booting on the git
// default, which means a machine SILENTLY REVERTS to different agents than the ones it was configured with.
// That is the worst of the outcomes: it works, so nobody looks.
let cachePath: string | null = null

export function useCache(dir: string): void {
  cachePath = join(dir, 'profile.json')
  try {
    const p = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (validate(p).length === 0) adopt(p, `cached v${p?.version ?? '?'}`)
  } catch { /* no cache yet, or unreadable — the baked default stands */ }
}

function writeCache(p: Partial<Profile>): void {
  if (!cachePath) return
  try {
    mkdirSync(dirname(cachePath), { recursive: true })
    writeFileSync(cachePath, JSON.stringify(p, null, 2))
  } catch (e: any) { console.warn(`[config] could not cache the profile (${e?.message ?? e})`) }
}

// ── VALIDATION — SHAPE, not choice ────────────────────────────────────────────────────────────────────────
// WHICH models are permitted is decided in superadmin, against the catalogue held there; by the time a profile
// reaches a box that choosing is over, and the box is given the decision rather than the options.
//
// What a box still owes itself is that the document is USABLE. A profile is edited by a person and applied
// without a deploy, so a typo reaches a running machine directly: adopting `harness: "openocde"` would leave
// an agent unable to start, and the cache would make it persist across restarts. Checked BEFORE adopting — a
// bad profile is reported and ignored, and the box keeps running what it has.
const HARNESSES = new Set<string>(['opencode', 'pi', 'claude-code-pty', 'codex', 'mock'])

export function validate(p: any): string[] {
  const bad: string[] = []
  if (!p || typeof p !== 'object') return ['profile is not an object']
  // A profile OVERRIDES the default, so naming no agents is legitimate: a project that has made no per-agent
  // choice is a project running the engine's own defaults.
  if (p.agents !== undefined && (typeof p.agents !== 'object' || Array.isArray(p.agents))) return ['profile.agents is not an object']
  for (const [name, a] of Object.entries((p.agents ?? {}) as Record<string, any>)) {
    if (!AGENTS.includes(name as AgentName)) { bad.push(`"${name}" is not an agent`); continue }
    // All three, on every agent — the shape IS the contract, and a half-specified agent is the ambiguity this
    // whole module exists to remove.
    for (const field of ['harness', 'provider', 'model'] as const) {
      if (typeof a?.[field] !== 'string' || !a[field]) bad.push(`agents.${name}.${field} is missing`)
    }
    if (a?.harness && !HARNESSES.has(a.harness)) bad.push(`agents.${name}.harness "${a.harness}" is not a harness`)
    // THE PAIR. A harness reaches only the accounts it can authenticate against — claude-code-pty drives a CLI
    // with its own subscription and nothing else. Refused here as well as narrowed in the editor, because a
    // profile can also arrive from a script or a restored backup, and an impossible pair leaves an agent
    // unable to start with an error about a model rather than about the combination.
    else if (a?.harness && a?.provider && !harnessCanUse(a.harness, a.provider)) {
      const can = providersForHarness(a.harness)
      bad.push(`agents.${name}: ${a.harness} cannot use ${a.provider}${can.length ? ` (it reaches ${can.join(', ')})` : ''}`)
    }
  }
  return bad
}

/** Adopt a profile that arrived from the control plane: validated, then cached. Returns whether it was taken,
 *  so the caller reports the truth rather than assuming. */
export function receive(p: any, from: string): { ok: boolean; problems: string[] } {
  const problems = validate(p)
  if (problems.length) {
    console.error(`[config] REFUSED the profile from ${from}: ${problems.join('; ')} — still running ${source}`)
    return { ok: false, problems }
  }
  adopt(p, from)
  writeCache(p)
  return { ok: true, problems: [] }
}

/** The effective table, one line per agent. Printed at boot: a box running a downloaded profile is otherwise
 *  indistinguishable from one running the git default, and "where did this value come from" is the question
 *  every configuration bug starts with. */
export function describeConfig(): string[] {
  const out = [`profile v${active.version} · ${source}`]
  for (const a of AGENTS) {
    const r = active.agents[a]
    if (r) out.push(`  ${a.padEnd(10)} ${r.harness} · ${r.provider} · ${r.model}`)
  }
  return out
}

/** What this engine is running, in the shape the DO stores and a UI renders. Sent after every adoption, so
 *  "saved" and "running" stay separate facts that can be compared.
 *
 *  The whole active document travels too: the superadmin editor is SEEDED FROM THIS rather than from a
 *  skeleton it makes up, so what you edit is literally what the box is running — including a project that has
 *  never been configured, where the honest starting point is the engine's baked default. */
export function applied(): { version: number; agents: Record<string, AgentProfile>; profile: Profile } {
  return { version: active.version, agents: active.agents, profile: active }
}
