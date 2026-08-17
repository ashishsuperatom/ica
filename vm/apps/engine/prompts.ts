// ── Prompt loader with a fail-safe VOLUME OVERRIDE layer ──────────────────────
// A prompt can be tweaked on a RUNNING VM without a full image rebuild+roll: drop an override on the
// persistent volume and the agent picks it up live. Safety is built in:
//
//  • Build-id gated. Each image is stamped with a BUILD_ID (baked at build time). An override is honored ONLY
//    if its stamp matches the CURRENT image's build id — so a freshly deployed image's baked prompts ALWAYS
//    win, and a stale override can never shadow a new release. (The stamp is the whole override set's, one file.)
//  • Fail-safe. ANY problem — no build id, no/blank override, mismatched stamp, unreadable file, exception —
//    falls back to the baked prompt. An override can only speed iteration, never break an agent.
//  • Provenance. Every load logs its source (override|baked + build id + size), so we always know what ran.
//
// To iterate: SSH the VM → write /app/data/prompt-overrides/<key> and stamp /app/data/prompt-overrides/BUILD_ID
// with `cat /app/BUILD_ID` (see scripts/prompt-override.sh). Once happy: commit the change into the baked file
// and roll a new image (which auto-invalidates the override).

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OVERRIDE_ROOT = process.env.PROMPT_OVERRIDE_DIR ?? '/app/data/prompt-overrides'
const BUILD_ID_FILE = process.env.BUILD_ID_FILE ?? '/app/BUILD_ID'

let cachedBuildId: string | null = null
export function imageBuildId(): string {
  if (cachedBuildId === null) { try { cachedBuildId = readFileSync(BUILD_ID_FILE, 'utf8').trim() } catch { cachedBuildId = '' } }
  return cachedBuildId
}

const lastLogged = new Map<string, string>()
function announce(key: string, source: 'override' | 'baked', buildId: string, len: number): void {
  const sig = `${source}:${buildId}:${len}`
  if (lastLogged.get(key) !== sig) { lastLogged.set(key, sig); console.log(`[prompt] ${key} ← ${source} (build ${buildId || '?'}, ${len}b)`) }
}

/**
 * Return a prompt's text. `bakedPath` is the in-image source file; `key` is a stable id used for the override
 * filename (mirrored under the override root) and for logging. Read fresh each call so an edited override goes
 * live without a process restart.
 */
export function loadPrompt(bakedPath: string, key: string): string {
  const baked = (): string => readFileSync(bakedPath, 'utf8')
  try {
    const buildId = imageBuildId()
    if (buildId) {   // no build id → never override (fail-safe)
      const stampPath = join(OVERRIDE_ROOT, 'BUILD_ID')
      const overridePath = join(OVERRIDE_ROOT, key)
      if (existsSync(stampPath) && existsSync(overridePath) && readFileSync(stampPath, 'utf8').trim() === buildId) {
        const c = readFileSync(overridePath, 'utf8')
        if (c.trim()) { announce(key, 'override', buildId, c.length); return c }
      }
    }
    const c = baked(); announce(key, 'baked', buildId, c.length); return c
  } catch {
    try { return baked() } catch { return '' }   // ultimate fallback
  }
}
