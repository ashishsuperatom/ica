// PROGRAMS, BUILT HERE AND KEPT BY THE PLATFORM. A person or agent sends a program's source; the engine — the one place
// that compiles — builds it, and uploads the built program to the platform, which keeps it (R2 + the project's
// catalogue) as a draft of whoever asked:
//
//   program:build { files: { "<path>": "<text>", … } }   → program:built { hash, name, version, added } | program:refused { reason }
//
// The source is a program folder (manifest.json, server/…, web/…, doc.md). Its manifest's owner is set to whoever
// asked, so the program says who it belongs to. Listing and publishing are the platform's (program:list,
// program:publish), not the engine's.
//
// The engine runs only built programs from its store, and fetches one it lacks from the platform by hash (checked
// against the hash before it is kept) — or, by name, the newest published.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildProgram, fromBundle, toBundle, linked, ProgramError, ProgramStore } from '@superatom/programs'
import { whoIs, IdentityRefusal } from './identity.js'
import { devOf } from './dev.js'
import type { Platform } from './platform.js'

export const PROGRAM_MESSAGES = new Set(['program:build', 'dev:clear'])
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

export function createProgramSeam(d: { projectDir: string; platform: Platform | null; send: (to: any, msg: Record<string, unknown>) => void; activities?: ReturnType<typeof import('./activity.js').createActivities>
  /** Each development environment held here, as a workload (kind "dev-env"); asked for when needed (made after this). */
  workloads?: () => ReturnType<typeof import('./workloads.js').createWorkloads> | undefined }) {
  const store = new ProgramStore(join(d.projectDir, 'programs', 'store'))

  /** A program by hash or name, with every library build it links, each fetched by hash when it is not here. By name it
   *  is the newest PUBLISHED build — what everyone runs — or, for a session pinned to the draft (someone who may
   *  publish, trying what is not yet published), the newest build of all. The same rule as the graph's draft. */
  async function ensure(ref: string, o: { draft?: boolean } = {}): Promise<string> {
    const hash = await ensureOne(ref, o.draft)
    store.touch(hash)
    for (const l of linked(store, store.manifest(hash).uses ?? [])) if (!store.has(l.hash)) { await ensureOne(l.hash); for (const m of linked(store, [l])) if (!store.has(m.hash)) await ensureOne(m.hash) }
    return hash
  }
  // The newest published build of each name, as the platform said it last (kept a few seconds: a publish reaches new
  // sessions at once, and a burst of them asks once). When the platform cannot be reached, the last answer holds.
  const publishedNow = new Map<string, { hash: string; at: number }>()
  async function newestPublished(name: string): Promise<string> {
    const seen = publishedNow.get(name)
    if (seen && Date.now() - seen.at < 15_000) return seen.hash
    try {
      const list = (await d.platform!.listPrograms({ name, published: true })).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))
      if (!list.length) throw new ProgramError([`no program "${name}" is published — publish a build of it (or try it in a session pinned to the draft)`])
      publishedNow.set(name, { hash: list[0].hash, at: Date.now() })
      return list[0].hash
    } catch (e) { if (seen && !(e instanceof ProgramError)) return seen.hash; throw e }
  }
  async function ensureOne(ref: string, draft = false): Promise<string> {
    const byHash = /^[0-9a-f]{64}$/.test(ref)
    // An engine with no platform (a home on its own) has only what was built here: its newest.
    if (!d.platform) return store.resolve(ref)
    let hash = ref
    if (!byHash) {
      if (draft) {
        // The draft: the newest build of all (every build is uploaded as it is made), else the newest here.
        const all = (await d.platform.listPrograms({ name: ref })).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))
        hash = all[0]?.hash ?? store.resolve(ref)
      } else hash = await newestPublished(ref)
    }
    if (store.has(hash)) return hash
    return fromBundle(store, await d.platform.fetchProgram(hash))
  }

  // A development environment's builds (docs/dev-mode.md): dev/<id>/index.json names them; never uploaded, never in the
  // catalogue, kept by the sweep while the environment is attached, and let go when the platform says it ended.
  const devDir = join(d.projectDir, 'dev')
  const devIndex = (env: string) => join(devDir, env, 'index.json')
  const devBuilds = (env: string): Record<string, string> => { try { return JSON.parse(readFileSync(devIndex(env), 'utf8')).programs ?? {} } catch { return {} } }
  const allDevBuilds = (): string[] => { try { return readdirSync(devDir).flatMap((e) => Object.values(devBuilds(e))) } catch { return [] } }
  // Each environment held here as a workload (`dev-env/<id>`): its builds; gone once the platform ends it.
  const reportedDev = new Set<string>()
  const reportDev = () => {
    const w = d.workloads?.()
    if (!w) return
    let envs: string[] = []
    try { envs = readdirSync(devDir).filter((e) => /^dv_[\w-]{4,40}$/.test(e)) } catch { /* none yet */ }
    for (const e of envs) { w.set({ kind: 'dev-env', id: e, state: 'ready', health: { builds: Object.keys(devBuilds(e)).length } }); reportedDev.add(e) }
    for (const e of [...reportedDev]) if (!envs.includes(e)) { w.gone('dev-env', e); reportedDev.delete(e) }
  }

  async function handle(payload: any, from: any): Promise<void> {
    const reply = (msg: Record<string, unknown>) => d.send(from, { ...msg, reqId: payload.reqId })
    if (payload.t === 'dev:clear') {
      // Only the platform ends an environment (its owner asked, or it was left an hour).
      if (from?.type !== 'hub' || !/^dv_[\w-]{4,40}$/.test(String(payload.env))) return
      const builds = Object.values(devBuilds(String(payload.env)))
      rmSync(join(devDir, String(payload.env)), { recursive: true, force: true })
      // Deleted (not merely ended): its builds go too — each one no other environment uses and the platform does not
      // hold (the same program built and kept outside an environment is not the environment's to remove).
      let removed = 0
      if (payload.purge && builds.length) {
        const others = new Set(allDevBuilds())
        const kept = new Set(d.platform ? (await d.platform.listPrograms().catch(() => null))?.map((p) => p.hash) ?? builds : builds)
        for (const h of builds) if (!others.has(h) && !kept.has(h)) { rmSync(store.dirOf(h), { recursive: true, force: true }); removed++ }
      }
      reportDev()
      return reply({ t: 'dev:cleared', env: payload.env, ...(payload.purge ? { removed } : {}) })
    }
    const env = payload.env ? String(payload.env) : null
    const src = join(d.projectDir, 'programs', 'incoming', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      const who = whoIs(from)
      if (env && devOf(from)?.id !== env) throw new ProgramError([`build into an environment you are attached to (sacli dev) — ${env} is not yours, or not attached`])
      if (!d.platform) throw new ProgramError(['this engine is not connected to a platform to keep programs'])
      const files = payload.files
      if (!files || typeof files !== 'object' || Array.isArray(files)) throw new ProgramError(['program:build carries the program\'s source files: { "<path>": "<text>" }'])
      let bytes = 0
      for (const [p, text] of Object.entries(files)) {
        if (!/^(manifest\.json|doc\.md|(server|web)(\/[\w-]+)*\/[\w-]+(\.[\w-]+)+)$/.test(p)) throw new ProgramError([`"${p}" is not a file of a program's source (manifest.json, doc.md, server/…, web/…)`])
        if (typeof text !== 'string') throw new ProgramError([`${p} is not text`])
        bytes += Buffer.byteLength(text)
      }
      if (bytes > MAX_SOURCE_BYTES) throw new ProgramError([`a program's source is at most ${MAX_SOURCE_BYTES / 1024 / 1024} MB`])
      let manifest: any
      try { manifest = JSON.parse(String(files['manifest.json'] ?? '')) } catch { throw new ProgramError(['manifest.json is missing or not JSON']) }
      manifest.owner = who.id
      for (const [p, text] of Object.entries({ ...files, 'manifest.json': JSON.stringify(manifest, null, 2) })) {
        const f = join(src, p); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text as string)
      }
      // The libraries it uses, here before it is built (by name: the newest here, else the newest published).
      for (const u of Array.isArray(manifest.uses) ? manifest.uses : []) if (typeof u === 'string') { try { await ensure(u.split('@')[0], { draft: true }) } catch { /* the build says which is missing */ } }
      const run = async () => {
        // A build the platform does not take is not kept here either: nothing may link a build no other engine can fetch.
        const before = new Set(existsSync(store.root) ? readdirSync(store.root) : [])
        const built = buildProgram(src, store)
        if (env) {
          // Into the environment only: recorded beside it, never uploaded.
          mkdirSync(join(devDir, env), { recursive: true })
          writeFileSync(devIndex(env), JSON.stringify({ programs: { ...devBuilds(env), [built.manifest.name]: built.hash } }, null, 2))
          reportDev()
          return { built, up: { added: false } }
        }
        try { return { built, up: await d.platform!.uploadProgram(toBundle(store, built.hash), who.id) } }
        catch (e) { if (!before.has(built.hash)) rmSync(store.dirOf(built.hash), { recursive: true, force: true }); throw e }
      }
      const { built, up } = d.activities ? await d.activities.around(who.id, 'program.build', `Building ${manifest.name ?? 'a program'}`, run, (r) => `${r.built.manifest.name} ${r.built.hash.slice(0, 12)}${r.up.added ? '' : ' (already kept)'}`) : await run()
      return reply({ t: 'program:built', hash: built.hash, name: built.manifest.name, version: built.manifest.version, added: up.added, ...(env ? { env } : {}) })
    } catch (e: any) {
      if (e instanceof ProgramError || e instanceof IdentityRefusal) return reply({ t: 'program:refused', reason: e.message })
      console.error('[program]', e?.stack ?? e)
      return reply({ t: 'program:refused', reason: `the program could not be built or kept: ${e?.message ?? e}` })
    } finally { rmSync(src, { recursive: true, force: true }) }
  }

  /** Every program built here that the platform does not keep yet, uploaded (on each connect): the platform's catalogue
   *  is where screens load a program's view from, and where a replaced machine gets it back. */
  async function syncUp(log?: (s: string) => void): Promise<number> {
    if (!d.platform) return 0
    const kept = new Set((await d.platform.listPrograms()).map((p) => p.hash))
    let n = 0
    for (const m of store.list()) {
      if (kept.has(m.hash)) continue
      const by = /^(user|agent):\S+$/.test(String(m.owner)) ? String(m.owner) : 'user:platform'
      try { await d.platform.uploadProgram(toBundle(store, m.hash), by); n++ } catch (e: any) { log?.(`[programs] ${m.name} ${m.hash.slice(0, 12)} not uploaded: ${e?.message ?? e}`) }
    }
    if (n) log?.(`[programs] uploaded ${n} program(s) the platform did not keep yet`)
    return n
  }

  /** The store is a cache over the platform: a build unused for 14 days goes — never the newest published of a name,
   *  never one `keepAlso` names (an attached environment's), never a library a remaining build links. Without the
   *  platform's answer nothing goes: what is published must be known before anything is removed. */
  async function sweep(keepAlso: () => Iterable<string> = allDevBuilds): Promise<string[]> {
    if (!d.platform) return []
    const published = await d.platform.listPrograms({ published: true })
    const newest = new Map<string, { hash: string; at: string }>()
    for (const p of published) { const n = newest.get(p.name); if (!n || p.uploaded_at > n.at) newest.set(p.name, { hash: p.hash, at: p.uploaded_at }) }
    const gone = store.sweep([...[...newest.values()].map((n) => n.hash), ...keepAlso()], Date.now() - 14 * 86_400_000)
    for (const h of gone) publishedNow.forEach((v, k) => { if (v.hash === h) publishedNow.delete(k) })
    return gone
  }

  return { handle, ensure, store, syncUp, sweep, reportDev }
}
