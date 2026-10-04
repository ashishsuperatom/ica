// ── Loading a program's React side ───────────────────────────────────────────────────────────────────────────────────
//
// A built program's React side imports the platform's libraries by name ('react', 'echarts', …) and its own files
// by relative path. In the browser there is one copy of each library — the user UI's — so the program is given that
// copy: every platform import is pointed at a small module that hands out the live library, and every own file is
// loaded the same way, recursively. Nothing is fetched from anywhere else; an import of anything that is neither is
// refused with a sentence. The same code runs in the browser and in Node (data: modules work in both).

import { PLATFORM_LIBRARIES } from '@superatom/platform-types'

const GLOBAL = '__superatom_platform'
const SPEC = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g

export class ProgramLoadError extends Error {}

export interface LoadOptions {
  /** Reads a file of the built program by URL. */
  fetchText: (url: string) => Promise<string>
  /** The live platform libraries, by name: the same objects the user UI uses. */
  platform: Partial<Record<(typeof PLATFORM_LIBRARIES)[number], object>>
}

const moduleUrl = (code: string) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(code)
const IDENT = /^[A-Za-z_$][\w$]*$/

/** The module that hands out one live library: its default and every named export. */
function shim(lib: string, value: object): string {
  const names = Object.keys(value).filter((k) => k !== 'default' && IDENT.test(k))
  return `const m = globalThis[${JSON.stringify(GLOBAL)}][${JSON.stringify(lib)}];\nexport default (m.default ?? m);\n` + (names.length ? `export const { ${names.join(', ')} } = m;\n` : '')
}

/** Import a program's React side from its entry file's URL; returns the module (its components by name). */
export async function loadProgramUI(entry: string, opts: LoadOptions): Promise<Record<string, unknown>> {
  const g = globalThis as any
  g[GLOBAL] = { ...(g[GLOBAL] ?? {}), ...opts.platform }
  const shims = new Map<string, string>()
  const done = new Map<string, Promise<string>>()

  const libUrl = (lib: string) => {
    if (!shims.has(lib)) {
      const value = opts.platform[lib as keyof LoadOptions['platform']]
      if (!value) throw new ProgramLoadError(`the program imports "${lib}", which this screen does not supply`)
      shims.set(lib, moduleUrl(shim(lib, value)))
    }
    return shims.get(lib)!
  }

  const load = (url: string, chain: string[]): Promise<string> => {
    if (chain.includes(url)) return Promise.reject(new ProgramLoadError(`the program's files import each other in a circle: ${[...chain, url].map((u) => u.split('/').pop()).join(' → ')}`))
    if (!done.has(url)) done.set(url, (async () => {
      const code = await opts.fetchText(url)
      const specs = [...code.matchAll(SPEC)].map((m) => m[3])
      const targets = new Map<string, string>()
      for (const spec of new Set(specs)) {
        if (spec.startsWith('.')) targets.set(spec, await load(new URL(spec, url).href, [...chain, url]))
        else if ((PLATFORM_LIBRARIES as readonly string[]).includes(spec)) targets.set(spec, libUrl(spec))
        else throw new ProgramLoadError(`${url.split('/').pop()} imports "${spec}": a program's React side may import only the platform's libraries and its own files`)
      }
      return moduleUrl(code.replace(SPEC, (all, lead, q, spec) => `${lead}${q}${targets.get(spec) ?? spec}${q}`))
    })())
    return done.get(url)!
  }

  // The URL is awaited on its own line: Vite wraps a dynamic import in a preload arrow, and an `await` inside the
  // import's argument ends up in that (non-async) arrow — a syntax error that took the whole screen down.
  const url = await load(new URL(entry).href, [])
  return import(/* @vite-ignore */ url)
}
