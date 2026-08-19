// ── Connector Agent ───────────────────────────────────────────────────────────
// The admin's infrastructure coding agent. A real claude-code session (default claude-code:sonnet-5) that
// the admin talks to in a terminal (raw PTY → xterm; NO [[ui]] narration — you just watch it work). Its
// main job is connecting data sources: it writes a bridge, tests it against the datasource-manager, and
// registers it live. It shares the ICA workspace machinery with the analyst/modeler; its instructions are
// in ./SYSTEM.md (copied in as ./connector/CONNECTOR.md so it never clobbers the other agents' role files).

import { readFile, cp } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createSession, prepareWorkspace, type Harness, type Session, type RunHandlers } from '../../ica/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Deterministic hash of the connector's instructions — changes → fresh session instead of a stale resume.
export async function promptVersion(): Promise<string> {
  return createHash('sha1').update(await readFile(join(__dirname, 'SYSTEM.md'), 'utf8').catch(() => '')).digest('hex').slice(0, 12)
}

export interface ConnectorOpts {
  root: string                                   // workspace root (a dir per project is created under here)
  projectId: string
  ica?: { harness?: Harness; model?: string; resumeId?: string }   // default claude-code:sonnet-5
  managerUrl?: string                            // the datasource-manager (to register + test bridges)
  datasourcesDir: string                         // where bridges are written (persisted, shared with the manager)
}

export interface Connector {
  ask(message: string, handlers?: RunHandlers): Promise<{ lastLines: string; ms: number }>
  session: Session
  cwd: string
}

export async function createConnector(opts: ConnectorOpts): Promise<Connector> {
  const harness = opts.ica?.harness ?? 'claude-code'
  const model = opts.ica?.model ?? 'claude-sonnet-5'
  const cwd = await prepareWorkspace({ root: opts.root, projectId: opts.projectId, managerUrl: opts.managerUrl })
  await cp(join(__dirname, 'SYSTEM.md'), join(cwd, 'connector/CONNECTOR.md'))

  const session = createSession(harness, { cwd, model, resumeId: opts.ica?.resumeId })
  const manager = opts.managerUrl ?? 'http://localhost:4000'
  const preamble =
    `You are the infrastructure connector agent. Read ./connector/CONNECTOR.md for your role + the bridge protocol, then help ` +
    `the admin. The datasource-manager is at ${manager}. Write bridges under ${opts.datasourcesDir} (one folder per ` +
    `source: <id>/bridge.mjs + <id>/.env for secrets). Register a bridge LIVE via POST ${manager}/sources ` +
    `{"id","path"} (absolute path), then verify via GET ${manager}/sources, POST ${manager}/introspect, POST ${manager}/query.`

  return {
    cwd,
    session,
    // One admin turn. The session persists across turns (same claude-code session), so the admin's follow-up
    // replies keep full context — a real conversation. Streaming is raw PTY (the engine forwards onOutput).
    async ask(message, handlers) {
      const prompt = `${preamble}\n\nThe admin says:\n${message}`
      return session.run(prompt, handlers)
    },
  }
}
