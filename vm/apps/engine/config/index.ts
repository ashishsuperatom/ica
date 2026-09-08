// ── THE ENGINE PROFILE — one place that decides which brain each agent runs on ────────────────────────────
//
// WHAT THIS REPLACES. Every agent's harness, provider and model used to be decided by a `?? process.env.X ??
// 'literal'` chain written wherever the agent happened to be constructed — thirteen of them, across six
// files, in two contradictory directions: engine.ts inferred a MODEL FROM THE HARNESS, while ica/providers.ts
// inferred a PROVIDER FROM THE MODEL. Nothing reconciled them.
//
// That is not a tidiness complaint. Two of those chains computed the SAME value from DIFFERENT literals:
// the composer ran `pi/gpt-5.6-luna` (agents/composer/index.ts) while the provenance written for the program
// it authored said `opencode/deepseek-v4-flash` (engine.ts). Both read ICA_COMPOSER_*; they disagreed only
// when it was unset, which is the case on every fleet box. So the record of who wrote a program was wrong
// precisely where we could least afford it — and no single file was incorrect on its own.
//
// THREE LAYERS, one rule, and the winner is always named in the log:
//
//   1. this file's default.json   — shipped in git, so a laptop with no network boots
//   2. the project's profile      — written by superadmin into ProjectDO, fetched at boot, cached in the
//                                   state dir so an unreachable control plane costs nothing
//   3. ICA_* environment          — still wins, because experimenting on ONE box must not require a deploy
//
// NO CREDENTIALS LIVE HERE. A profile is logged, cached to disk, diffed between versions and rendered in a
// UI — four places a secret must never be. The profile says which credentials a box NEEDS (a provider with an
// envVar is one the box must hold); the values come from the vault, per provider, already audited.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Harness } from '../ica/index.js'

export type AgentName = 'analyst' | 'connector' | 'grounding' | 'modeller' | 'composer' | 'narrator'

export interface AgentProfile {
  harness?: Harness
  provider?: string
  model?: string
}

export interface Profile {
  version: number
  fleetHarness: Harness
  harnessModel: Partial<Record<Harness, string>>
  agents: Partial<Record<AgentName, AgentProfile>>
}

/** What an agent actually runs on, and — for every field — WHERE that came from. The source travels with the
 *  value because the whole failure this module exists to prevent is a value nobody can trace. */
export interface Resolved {
  harness: Harness
  provider?: string
  model?: string
  from: { harness: string; provider: string; model: string }
}

const HERE = dirname(fileURLToPath(import.meta.url))

const BAKED: Profile = JSON.parse(readFileSync(join(HERE, 'default.json'), 'utf8'))

// The profile in force. Starts as the baked default so anything reading config before the download — or on a
// box that never downloads one — gets a complete answer rather than undefined.
let active: Profile = BAKED
let source = 'default.json'

/** Adopt a downloaded profile. Merged FIELD BY FIELD over the baked default, so a profile that names only
 *  `agents.composer` still gets every other agent — a partial profile is a partial OVERRIDE, never a
 *  replacement that silently drops what it does not mention. */
export function adopt(p: Partial<Profile> | null | undefined, from: string): void {
  if (!p) return
  active = {
    version: p.version ?? BAKED.version,
    fleetHarness: p.fleetHarness ?? BAKED.fleetHarness,
    harnessModel: { ...BAKED.harnessModel, ...(p.harnessModel ?? {}) },
    agents: { ...BAKED.agents, ...(p.agents ?? {}) },
  }
  source = from
}

export const profile = (): Profile => active
export const profileSource = (): string => source

// ── LEGACY NAMES, still honoured ──────────────────────────────────────────────────────────────────────────
// The narrator's variables were ICA_REFLEX_* until the reflex agent was deleted. An existing deployment that
// still sets them must not silently change model on its next restart, so they are read as a fallback.
const envFor = (agent: AgentName, field: 'HARNESS' | 'PROVIDER' | 'MODEL'): { value?: string; name?: string } => {
  const names = [`ICA_${agent.toUpperCase()}_${field}`]
  if (agent === 'narrator') names.push(`ICA_REFLEX_${field}`)
  for (const n of names) { const v = process.env[n]; if (v) return { value: v, name: n } }
  return {}
}

/** Which brain this agent runs on, and where each part of that answer came from.
 *
 *  An agent that names no harness inherits the FLEET harness — one switch that moves analyst, connector,
 *  grounding and modeller together, which is how they have always been operated. An agent that names no model
 *  takes its harness's own default, because a harness's model is a property of the harness, not of the task. */
export function agentConfig(agent: AgentName): Resolved {
  const p = active.agents[agent] ?? {}

  const eh = envFor(agent, 'HARNESS')
  const fleetEnv = process.env.ICA_AGENT_HARNESS
  const harness = (eh.value ?? p.harness ?? fleetEnv ?? active.fleetHarness) as Harness
  const harnessFrom = eh.name ?? (p.harness ? source : fleetEnv ? 'ICA_AGENT_HARNESS' : `${source} (fleet)`)

  const ep = envFor(agent, 'PROVIDER')
  const provider = ep.value ?? p.provider
  const providerFrom = ep.name ?? (p.provider ? source : 'harness default')

  // The fleet MODEL applies only to agents actually running the fleet harness — forcing one model across
  // agents on different harnesses would name a model the harness does not carry.
  const em = envFor(agent, 'MODEL')
  const fleetModel = harness === (fleetEnv ?? active.fleetHarness) ? process.env.ICA_AGENT_MODEL : undefined
  const model = em.value ?? p.model ?? fleetModel ?? active.harnessModel[harness]
  const modelFrom = em.name ?? (p.model ? source : fleetModel ? 'ICA_AGENT_MODEL' : `${source} (harness default)`)

  return { harness, provider, model, from: { harness: harnessFrom, provider: providerFrom, model: modelFrom } }
}

const AGENTS: AgentName[] = ['analyst', 'connector', 'grounding', 'modeller', 'composer', 'narrator']

/** The effective table, one line per agent, each value carrying where it came from. Printed at boot: a box
 *  running a downloaded profile is otherwise indistinguishable from one running the git default, and "which
 *  layer decided this" is the question every configuration bug starts with. */
export function describeConfig(): string[] {
  const out = [`profile v${active.version} · ${source}`]
  for (const a of AGENTS) {
    const r = agentConfig(a)
    const parts = [`${r.harness} [${r.from.harness}]`]
    if (r.provider) parts.push(`${r.provider} [${r.from.provider}]`)
    if (r.model) parts.push(`${r.model} [${r.from.model}]`)
    out.push(`  ${a.padEnd(10)} ${parts.join(' · ')}`)
  }
  return out
}
