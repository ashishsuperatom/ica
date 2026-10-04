// ── A built program as one bundle — the form it travels and is stored in ──────────────────────────────────────────────
//
// A built program is a few text files (compiled JavaScript, its manifest, its doc). As a bundle it is one JSON object:
// its hash and its files by path. The hash is defined here, once, for every place that computes it — the engine's
// store (Node) and the platform (a Worker): SHA-256 over each file in path order, as "<path>\n<contents>\n". Nothing
// here touches a file system, so a Durable Object checks a bundle with exactly the code the engine made it with.

export const BUNDLE_FORMAT = 1
/** The largest bundle the platform keeps. */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024
/** Files every built program has. */
export const REQUIRED_FILES = ['manifest.json', 'doc.md', 'node/index.js', 'web/index.js'] as const

export interface ProgramBundle { format: typeof BUNDLE_FORMAT; hash: string; files: Record<string, string> }

const enc = new TextEncoder()

/** The bytes a program's hash is taken over, from its files (path → text). */
export function digestInput(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const parts = Object.keys(files).sort().flatMap((p) => [enc.encode(`${p}\n`), enc.encode(files[p]), enc.encode('\n')])
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** A program's hash from its files (Web Crypto: Node 22 and Workers alike). */
export async function bundleHash(files: Record<string, string>): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput(files)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** What is wrong with a bundle, in sentences — before its hash is even computed. */
export function checkBundle(b: unknown): string[] {
  const o = b as Partial<ProgramBundle>
  if (!o || typeof o !== 'object') return ['a bundle is an object']
  const out: string[] = []
  if (o.format !== BUNDLE_FORMAT) out.push(`a bundle's format is ${BUNDLE_FORMAT}`)
  if (typeof o.hash !== 'string' || !/^[0-9a-f]{64}$/.test(o.hash)) out.push('a bundle names its hash (64 hex characters)')
  if (!o.files || typeof o.files !== 'object') return [...out, 'a bundle carries its files']
  let bytes = 0
  for (const [p, text] of Object.entries(o.files)) {
    if (!/^[\w-]+(\.[\w-]+)*(\/[\w-]+(\.[\w-]+)*)*$/.test(p)) out.push(`"${p}" is not a path in a program`)
    else if (p === 'built.json') out.push('built.json is the store\'s own record, not part of a program')
    if (typeof text !== 'string') out.push(`${p} is not text`)
    else bytes += enc.encode(text).length
  }
  for (const f of REQUIRED_FILES) if (!(f in o.files)) out.push(`a built program has ${f}`)
  if (bytes > MAX_BUNDLE_BYTES) out.push(`a program is at most ${MAX_BUNDLE_BYTES / 1024 / 1024} MB of files`)
  return out
}

/** Check a bundle whole: its shape, then that its files are what its hash says. */
export async function verifyBundle(b: unknown): Promise<string[]> {
  const bad = checkBundle(b)
  if (bad.length) return bad
  const o = b as ProgramBundle
  const h = await bundleHash(o.files)
  return h === o.hash ? [] : [`the files hash to ${h.slice(0, 12)}, not ${o.hash.slice(0, 12)} — the bundle was changed or damaged`]
}
