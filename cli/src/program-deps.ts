// A PROGRAM'S NPM PACKAGES, the usual way: its package.json lists them (`pnpm install` there), its web side imports them
// (`import mapboxgl from 'mapbox-gl'`, `import 'mapbox-gl/dist/mapbox-gl.css'`), and sacli bundles each one it imports —
// with the esbuild from the program's own folder (its devDependencies), as connectors are built — into one file of its
// own under web/deps/: a package's code as one ES module, a stylesheet as a module that adds it to the page. The engine
// points the import at that file; the browser loads it as it is. The same source and packages give the same bytes.

import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CliError } from './config.ts'

const PLATFORM = ['react', 'react/jsx-runtime', 'react-dom', 'echarts', '@superatom/ui']
const IMPORT = /\bimport\s*(?:[^'"]*?\sfrom\s*)?['"]([^'"]+)['"]/g
/** Where a bundled import lives in the program: web/deps/<the import, as a file name>.js. */
export const depFile = (spec: string) => `deps/${spec.replace(/[^A-Za-z0-9.-]+/g, '_')}.js`
const packageOf = (spec: string) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])

/** The bundled files for the npm packages a program's web side imports (path within the program → contents). */
export async function bundleDeps(root: string, shown: string, sources: Record<string, string>): Promise<Record<string, string>> {
  const pkgFile = join(root, 'package.json')
  if (!existsSync(pkgFile)) return {}
  let pkg: any
  try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch (e: any) { throw new CliError(`${shown}/package.json could not be read: ${e?.message ?? e}`, 1) }
  const deps = new Set(Object.keys(pkg.dependencies ?? {}))
  const specs = new Set<string>()
  for (const [path, text] of Object.entries(sources)) {
    if (!/^web\/.+\.(tsx?|jsx?)$/.test(path) || path.startsWith('web/deps/')) continue
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1]
      if (spec.startsWith('.') || spec.startsWith('@lib/') || PLATFORM.some((p) => spec === p || spec.startsWith(p + '/'))) continue
      if (!deps.has(packageOf(spec))) throw new CliError(`${shown}/${path} imports "${spec}", which ${shown}/package.json does not list in its dependencies`, 1)
      specs.add(spec)
    }
  }
  if (!specs.size) return {}
  let esbuild: any
  try { esbuild = createRequire(pkgFile)('esbuild') } catch { throw new CliError(`${shown} imports npm packages, bundled with its own esbuild: add "esbuild" to its devDependencies and run pnpm install there`, 1) }
  if (!existsSync(join(root, 'node_modules'))) throw new CliError(`${shown}: run pnpm install there first (its package.json lists its packages)`, 1)
  const out: Record<string, string> = {}
  for (const spec of [...specs].sort()) {
    const common = { bundle: true, write: false, minify: true, platform: 'browser', target: 'es2022', logLevel: 'silent', absWorkingDir: root, define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'dataurl', '.svg': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' } }
    try {
      if (spec.endsWith('.css')) {
        const r = await esbuild.build({ ...common, entryPoints: [createRequire(pkgFile).resolve(spec)], outfile: 'x.css' })
        const css = r.outputFiles.find((f: any) => f.path.endsWith('.css'))?.text ?? ''
        out[`web/${depFile(spec)}`] = `// ${spec}, bundled by sacli: added to the page once\nconst s = document.createElement('style'); s.dataset.dep = ${JSON.stringify(spec)}; s.textContent = ${JSON.stringify(css)}; document.head.appendChild(s);\nexport {}\n`
      } else {
        const r = await esbuild.build({ ...common, format: 'esm', stdin: { contents: `import * as m from ${JSON.stringify(spec)};\nexport default (m.default ?? m);\nexport * from ${JSON.stringify(spec)};`, resolveDir: root, loader: 'js' } })
        out[`web/${depFile(spec)}`] = `// ${spec}, bundled by sacli\n${r.outputFiles[0].text}`
      }
    } catch (e: any) { throw new CliError(`${shown}: "${spec}" could not be bundled: ${String(e?.errors?.[0]?.text ?? e?.message ?? e)}`, 1) }
  }
  return out
}
