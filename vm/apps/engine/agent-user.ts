// THE AGENTS' OS USER (docs/connectors-plan.md, step 1e). In the Docker image the engine runs as root and its agents —
// the runner (ica/runner.ts) and program runs — as `sa-agent` (SA_AGENT_USER), whose group `sa` shares the folders agents
// work in: they cannot read the engine's environment or memory (its key, the manager's key), nor change what the engine
// itself runs (bridges, programs, its own code). Natively, on a person's machine, there is one user; agents run as it,
// and the engine says so at start.

import { execFileSync } from 'node:child_process'
import { chmodSync, chownSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface AgentUser { name: string; uid: number; gid: number }

function resolve(): AgentUser | null {
  // Tests run the runner as their own user (no root on a developer's machine): the same paths, without the switch of user.
  if (process.env.SA_RUNNER_TEST && !process.env.SA_IN_RUNNER) return { name: 'test', uid: process.getuid!(), gid: process.getgid!() }
  const name = process.env.SA_AGENT_USER
  if (!name || process.env.SA_IN_RUNNER || process.getuid?.() !== 0) return null
  try {
    const uid = Number(execFileSync('id', ['-u', name], { encoding: 'utf8' }).trim())
    const gid = Number(execFileSync('id', ['-g', name], { encoding: 'utf8' }).trim())
    return Number.isInteger(uid) && Number.isInteger(gid) ? { name, uid, gid } : null
  } catch { return null }
}

/** Who agents run as, or null (they run as the engine's own user). */
export const agentUser: AgentUser | null = resolve()

/** A folder agents work in: its group the agents', writable by it, and what is made inside it later the same (setgid,
 *  with the engine's umask 002). Symbolic links are not followed. Nothing when agents run as the engine's own user. */
export function shareWithAgents(dir: string): void {
  if (!agentUser) return
  const walk = (p: string) => {
    let st; try { st = lstatSync(p) } catch { return }
    if (st.isSymbolicLink()) return
    try { if (st.gid !== agentUser!.gid) chownSync(p, st.uid, agentUser!.gid) } catch { /* not ours to change */ }
    try { chmodSync(p, st.isDirectory() ? (st.mode & 0o7777) | 0o2070 : (st.mode & 0o7777) | 0o060) } catch { /* not ours to change */ }
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n))
  }
  walk(dir)
}

/** A folder only the engine may change (what it runs: bridges, programs): owned by it, nobody else may write. */
export function keepFromAgents(dir: string): void {
  if (!agentUser) return
  const walk = (p: string) => {
    let st; try { st = lstatSync(p) } catch { return }
    if (st.isSymbolicLink()) return
    try { chownSync(p, 0, 0) } catch { /* not ours to change */ }
    try { chmodSync(p, (st.mode & 0o0777) & ~0o022) } catch { /* not ours to change */ }
    if (st.isDirectory()) for (const n of readdirSync(p)) walk(join(p, n))
  }
  walk(dir)
}
