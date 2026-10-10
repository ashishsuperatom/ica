// ── The engine's own release: what it runs, what the platform chose, how the last switch went ──────────────────────
//
// Plain files in <project home>/engine-release, the one place the engine and the box's updater (apps/updater) meet:
//
//   desired.json   written here when the platform says which release this project runs (in the welcome, and when it
//                  changes); the updater reads it and switches the engine to it
//   running.json   written here once this engine has reached the platform — the updater's proof that a new release
//                  came up; a release that never writes it within the updater's window is rolled back
//   result.json    written by the updater after every switch (switched, rolled back, refused — and why); reported to
//                  the platform with what this engine runs, so the admin console says how the last switch went
//
// Every file is written whole (a temporary name, then a rename): a power cut leaves the old file or the new one.
import { mkdirSync, readFileSync, renameSync, watchFile, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Desired { digest: string; tag: string | null; image: string; chosenAt?: string }

export function createRelease(dir: string, buildFile = '/app/BUILD_ID') {
  const read = (name: string) => { try { return JSON.parse(readFileSync(join(dir, name), 'utf8')) } catch { return null } }
  const write = (name: string, v: unknown) => {
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${name}.tmp`)
    writeFileSync(tmp, JSON.stringify(v, null, 2))
    renameSync(tmp, join(dir, name))
  }
  const build = (() => { try { return readFileSync(buildFile, 'utf8').trim() || 'dev' } catch { return 'dev' } })()
  /** The image this engine was started from (set by whoever started it: sacli or the updater), and its build. */
  const image = process.env.SA_ENGINE_IMAGE || null
  return {
    /** The platform's choice: kept for the updater when it differs from what is kept already. */
    desire(r: Desired | null | undefined): boolean {
      if (!r?.digest) return false
      const had = read('desired.json')
      if (had?.digest === r.digest && had?.chosenAt === r.chosenAt) return false   // the same choice; chosen again is new
      write('desired.json', { ...r, at: new Date().toISOString() })
      console.log(`[release] the platform chose ${r.tag ?? r.digest.slice(0, 19)} — the box's updater switches to it${image?.endsWith(r.digest) ? ' (already running it)' : ''}`)
      return true
    },
    /** This engine reached the platform: the proof a switch to it worked. */
    connected() { try { write('running.json', { image, build, at: new Date().toISOString() }) } catch (e: any) { console.warn(`[release] could not note that this engine is up: ${e?.message ?? e}`) } },
    /** Call `fn` whenever the updater writes a new outcome — it writes it after this engine has already reported, so the
     *  report is sent again rather than leaving the platform with "switching". */
    onResult(fn: () => void) { mkdirSync(dir, { recursive: true }); watchFile(join(dir, 'result.json'), { interval: 3000, persistent: false }, (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) fn() }) },
    /** What to tell the platform: what runs, and how the last switch went. */
    report() { return { image, build, digest: image?.includes('@') ? image.slice(image.indexOf('@') + 1) : null, last: read('result.json') } },
  }
}
