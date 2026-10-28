// A SESSION'S SPECIALISED AGENTS (docs/intent-graph.md): one of each per session — the builder, the connector, any agent
// the project's admins made — made only when the session first reaches a node that one answers at, and kept for the
// session: the same agent (its conversation resumed across engine restarts) and the same folder, the session's own
// (sessions/<sid>/work), every time. Whether the person may use it is the platform's word (their capabilities, stamped on
// what they send); the engine asks the platform for the agent's instructions when it is the project's own.
//
// A turn ends when the agent writes its note for the person (out/<turn>.md) — the same on every harness. The builder's
// programs (programs/<name>/) are built after its turn by the engine, as any program is (program-seam.ts build).

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createSession, type Session } from './ica/index.js'
import { prepareWorkspace } from './ica/workspace.js'
import { agentConfig } from './config/index.js'
import { builderBriefing } from './agents/builder/index.js'
import { connectorBriefing } from './agents/connector/index.js'

export interface AgentSpecLite { name: string; title: string; instructions?: string; needs: string; harness: string; builtin?: boolean }
export interface AgentTurn { markdown: string; built: { name: string; hash: string }[]; refused: string[]; ms: number }

/** How long one turn of a specialised agent may take before it is let go. */
const MAX_TURN_MS = Number(process.env.SESSION_AGENT_MAX_TURN_MS) || 30 * 60_000
const PROGRAM_FILE = /^(manifest\.json|doc\.md|package\.json|(server|web)(\/[\w-]+)*\/[\w.-]+(\.[\w-]+)+)$/

export function createSessionAgents(d: {
  root: string; project: string; projectDir: string; manager: string; datasourcesDir: string
  build: (payload: { files: Record<string, string> }, from: any) => Promise<Record<string, unknown>>
  /** What the connector wrote this turn, kept by the platform through the one door (connections.ts publishWritten). */
  publishConnections?: (from: any, since: number) => Promise<string[]>
  log?: (s: string) => void
}) {
  const log = d.log ?? (() => {})
  const live = new Map<string, { session: Session; preamble: string; cwd: string }>()
  const resumeFile = (sid: string) => join(d.projectDir, 'sessions', sid, 'agents.json')
  const resumes = (sid: string): Record<string, string> => { try { return JSON.parse(readFileSync(resumeFile(sid), 'utf8')) } catch { return {} } }

  async function agentFor(sid: string, spec: AgentSpecLite) {
    const key = `${sid}|${spec.name}`
    const had = live.get(key)
    if (had) return had
    const cwd = await prepareWorkspace({ root: d.root, projectId: d.project, managerUrl: d.manager, projectDir: d.projectDir, sessionId: sid })
    const preamble = spec.name === 'builder' ? await builderBriefing(cwd)
      : spec.name === 'connector' ? await connectorBriefing(cwd, d.manager, d.datasourcesDir)
      : `${spec.instructions ?? ''}\nRead the data with the tools in this folder (./sources, ./find-schema, ./get-schema, ./query; each explains itself with --help).`
    const cfg = agentConfig(spec.name === 'connector' ? 'connector' : 'analyst')
    const harness = spec.harness === 'codex' ? 'codex' : cfg.harness
    const session = createSession(harness, { cwd, ...(harness === cfg.harness ? { model: cfg.model, provider: cfg.provider, thinking: cfg.thinking } : {}), resumeId: resumes(sid)[spec.name] })
    const made = { session, preamble, cwd }
    live.set(key, made)
    log(`[agents] ${sid.slice(0, 12)}: the ${spec.name} agent is made (${harness})`)
    return made
  }

  /** The programs the builder wrote or changed during a turn, built; what was built and why the rest were not. */
  async function buildWritten(cwd: string, since: number, from: any): Promise<{ built: AgentTurn['built']; refused: string[] }> {
    const built: AgentTurn['built'] = [], refused: string[] = []
    const root = join(cwd, 'programs')
    for (const name of existsSync(root) ? readdirSync(root) : []) {
      const dir = join(root, name)
      if (!existsSync(join(dir, 'manifest.json'))) continue
      const files: Record<string, string> = {}
      let newest = 0
      const walk = (p: string) => { for (const f of readdirSync(p)) { const full = join(p, f); const st = statSync(full); if (st.isDirectory()) { if (f !== 'node_modules') walk(full) } else { const rel = relative(dir, full); newest = Math.max(newest, st.mtimeMs); if (PROGRAM_FILE.test(rel) && !/\.test\./.test(rel)) files[rel] = readFileSync(full, 'utf8') } } }
      walk(dir)
      if (newest < since) continue   // not touched this turn
      const r = await d.build({ files }, from)
      if (r.t === 'program:built') built.push({ name: String(r.name), hash: String(r.hash) })
      else refused.push(`${name}: ${String(r.reason ?? 'not built')}`)
    }
    return { built, refused }
  }

  return {
    /** One turn of the session's agent `spec.name`, for the words the person said at a node it answers at. */
    async run(o: { session: string; spec: AgentSpecLite; text: string; from: any; turn: string; onNarration?: (t: string) => void }): Promise<AgentTurn> {
      const t0 = Date.now()
      const a = await agentFor(o.session, o.spec)
      const out = join(a.cwd, 'out'); mkdirSync(out, { recursive: true })
      const note = join(out, `${o.turn}.md`)
      const prompt = `${a.preamble}\n\nThe person says:\n${o.text}\n\nWhen you are done, write your note for the person (markdown, a few lines) to ./out/${o.turn}.md — writing it ends your turn.`
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        a.session.run(prompt, { doneWhen: () => existsSync(note), onNarration: o.onNarration }),
        new Promise((res) => { timer = setTimeout(() => { try { a.session.stop() } catch { /* gone */ } ; res(null) }, MAX_TURN_MS) }),
      ])
      if (timer) clearTimeout(timer)
      // its conversation, resumed after a restart: kept once a turn has happened (never before — there is nothing to resume)
      try { const id = (a.session as any).sessionId?.(); if (id) writeFileSync(resumeFile(o.session), JSON.stringify({ ...resumes(o.session), [o.spec.name]: id })) } catch { /* not kept: a fresh agent next time */ }
      let markdown = existsSync(note) ? readFileSync(note, 'utf8').trim() : ''
      const { built, refused } = o.spec.name === 'builder' ? await buildWritten(a.cwd, t0, o.from) : { built: [], refused: [] }
      if (built.length) markdown += `\n\n**Built:** ${built.map((b) => `\`${b.name}\` (${b.hash.slice(0, 12)})`).join(', ')} — yours until published (sacli program publish, or the console).`
      if (refused.length) markdown += `\n\n**Not built:** ${refused.join('; ')}`
      const kept = o.spec.name === 'connector' && d.publishConnections ? await d.publishConnections(o.from, t0).catch((e: any) => [`not kept by the platform — ${e?.message ?? e}`]) : []
      if (kept.length) markdown += `\n\n**Kept by the platform:** ${kept.join('; ')}`
      if (!markdown) markdown = `_The ${o.spec.title} agent finished without a note._`
      return { markdown, built, refused, ms: Date.now() - t0 }
    },
    /** The session's agents let go (their folders and conversations stay, to resume). */
    stop(session: string) { for (const [k, a] of live) if (k.startsWith(`${session}|`)) { try { a.session.stop() } catch { /* gone */ } ; live.delete(k) } },
  }
}
