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

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildProgram, fromBundle, toBundle, linked, ProgramError, ProgramStore } from '@superatom/programs'
import { whoIs, IdentityRefusal } from './identity.js'
import type { Platform } from './platform.js'

export const PROGRAM_MESSAGES = new Set(['program:build'])
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

export function createProgramSeam(d: { projectDir: string; platform: Platform | null; send: (to: any, msg: Record<string, unknown>) => void; activities?: ReturnType<typeof import('./activity.js').createActivities> }) {
  const store = new ProgramStore(join(d.projectDir, 'programs', 'store'))

  /** A program by hash or name, from the store — or else from the platform (by name: its newest published build) —
   *  with every library build it links, each fetched by hash when it is not here. */
  async function ensure(ref: string): Promise<string> {
    const hash = await ensureOne(ref)
    for (const l of linked(store, store.manifest(hash).uses ?? [])) if (!store.has(l.hash)) { await ensureOne(l.hash); for (const m of linked(store, [l])) if (!store.has(m.hash)) await ensureOne(m.hash) }
    return hash
  }
  async function ensureOne(ref: string): Promise<string> {
    try { return store.resolve(ref) } catch (e) { if (!d.platform) throw e }
    const platform = d.platform!
    let hash = ref
    if (!/^[0-9a-f]{64}$/.test(ref)) {
      const published = (await platform.listPrograms({ name: ref, published: true })).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at))
      if (!published.length) throw new ProgramError([`no program "${ref}" here, and none published on the platform`])
      hash = published[0].hash
    }
    return fromBundle(store, await platform.fetchProgram(hash))
  }

  async function handle(payload: any, from: any): Promise<void> {
    const reply = (msg: Record<string, unknown>) => d.send(from, { ...msg, reqId: payload.reqId })
    const src = join(d.projectDir, 'programs', 'incoming', `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
    try {
      const who = whoIs(from)
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
      for (const u of Array.isArray(manifest.uses) ? manifest.uses : []) if (typeof u === 'string') { try { await ensure(u.split('@')[0]) } catch { /* the build says which is missing */ } }
      const run = async () => {
        const built = buildProgram(src, store)
        const up = await d.platform!.uploadProgram(toBundle(store, built.hash), who.id)
        return { built, up }
      }
      const { built, up } = d.activities ? await d.activities.around(who.id, 'program.build', `Building ${manifest.name ?? 'a program'}`, run, (r) => `${r.built.manifest.name} ${r.built.hash.slice(0, 12)}${r.up.added ? '' : ' (already kept)'}`) : await run()
      return reply({ t: 'program:built', hash: built.hash, name: built.manifest.name, version: built.manifest.version, added: up.added })
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

  return { handle, ensure, store, syncUp }
}
