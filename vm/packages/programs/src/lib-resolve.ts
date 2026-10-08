// WHERE `@lib/<name>` LEADS, IN NODE. A built program imports its libraries as `@lib/<name>[/<file>.js]` and names the
// build of each in its manifest (`uses: [{ name, hash }]`). This resolve hook — installed once per process — sends such
// an import from any file of a stored program (<store>/<hash>/node/…) to that library's own build in the same store
// (<store>/<library hash>/node/<file>, index.js by default). Every program naming one library build gets the same file,
// so Node loads it once, as one module. Anything else resolves as Node would.

import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const LIB = /^@lib\/([a-z][a-z0-9-]*)(\/.+)?$/
const IN_STORE = /^(.*)[\\/]([0-9a-f]{64})[\\/]node[\\/]/
let installed = false

export function installLibResolve(): void {
  if (installed) return
  installed = true
  const usesOf = new Map<string, Record<string, string>>()
  registerHooks({
    resolve(specifier, context, next) {
      const lib = LIB.exec(specifier)
      if (!lib || !context.parentURL?.startsWith('file:')) return next(specifier, context)
      const at = IN_STORE.exec(fileURLToPath(context.parentURL))
      if (!at) return next(specifier, context)
      const [, root, program] = at
      let uses = usesOf.get(program)
      if (!uses) {
        const m = JSON.parse(readFileSync(join(root, program, 'manifest.json'), 'utf8'))
        uses = Object.fromEntries(((m.uses ?? []) as { name: string; hash: string }[]).map((u) => [u.name, u.hash]))
        usesOf.set(program, uses)
      }
      const hash = uses[lib[1]]
      if (!hash) throw new Error(`a file of program ${program.slice(0, 12)} imports "${specifier}", which it does not use`)
      return { url: pathToFileURL(join(root, hash, 'node', lib[2] ? lib[2].slice(1) : 'index.js')).href, shortCircuit: true }
    },
  })
}
