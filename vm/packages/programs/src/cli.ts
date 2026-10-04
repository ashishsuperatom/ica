// programs — build a program into the project's store, and run it in the STATE engine against the project's data.
//
//   programs init <name>                                a new program's source from the template (programs/src/<name>)
//   programs build <source folder>                      compile, check, hash; prints the hash (the same source, the same hash)
//   programs list                                       the programs in the store
//   programs doc <hash|name>                            its documentation
//   programs inspect <hash|name> <fn>                   where a function lives
//   programs verify                                     every stored program is what its hash says
//   programs run <hash|name> [--set <path>=<json>]… [--call <fn>] [--act <action>]
//        STATE starts from the program's initial slice; the --set ops apply (re-running what reads them), then the
//        call or action, else run. Prints what changed, what ran and what each showed, and the program's slice.
//
// Where: --store <dir>, else $PROGRAM_STORE, else <$ENGINE_PROJECT_DIR>/programs/store. Data goes through the
// datasource-manager at $DATASOURCE_URL — the one way programs reach data.

import { readFileSync, writeFileSync, existsSync, cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildProgram, ProgramStore, ProgramError, inspect, loadPackage } from './index.js'
import { createStateEngine, StateRefusal } from '@superatom/state'
import type { Op } from '@superatom/platform-types'

const argv = process.argv.slice(2)
const flags: Record<string, string[]> = {}
const pos: string[] = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) (flags[argv[i].slice(2)] ??= []).push(argv[++i] ?? '')
  else pos.push(argv[i])
}
const flag = (k: string) => flags[k]?.at(-1)

function storeDir(): string {
  if (flag('store')) return resolve(flag('store')!)
  if (process.env.PROGRAM_STORE) return resolve(process.env.PROGRAM_STORE)
  if (process.env.ENGINE_PROJECT_DIR) return join(process.env.ENGINE_PROJECT_DIR, 'programs', 'store')
  throw new ProgramError(['no store: pass --store <dir>, or set PROGRAM_STORE or ENGINE_PROJECT_DIR'])
}

const resolveProgram = (store: ProgramStore, ref: string | undefined): string => {
  if (!ref) throw new ProgramError(['which program? give its hash or name'])
  return store.resolve(ref)
}
const built = (store: ProgramStore, hash: string): string => store.builtAt(hash)

async function query(id: string, sql: string, params: Record<string, unknown> = {}) {
  const url = process.env.DATASOURCE_URL
  if (!url) throw new Error('DATASOURCE_URL is not set: programs reach data only through the datasource-manager')
  const r = await fetch(url + '/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, sql, params }) })
  const p: any = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }))
  if (!r.ok || p.error) throw new Error(p.error ?? `${r.status}`)
  return p.rows ?? []
}

function parseSet(s: string): Op {
  const eq = s.indexOf('=')
  if (eq < 1) throw new ProgramError([`--set ${s}: write <path>=<json>`])
  const raw = s.slice(eq + 1)
  let value: unknown
  try { value = JSON.parse(raw) } catch { value = raw }
  return { op: 'set', path: s.slice(0, eq), value }
}

async function main() {
  const [cmd, a, b] = pos
  if (!cmd || cmd === 'help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l: string) => l.startsWith('//')).map((l: string) => l.slice(3)).join('\n')); return }
  const store = new ProgramStore(storeDir())
  if (cmd === 'init') {
    const name = a
    if (!name || !/^[a-z][a-z0-9-]{1,60}$/.test(name)) throw new ProgramError(['a program name is lower-case letters, digits and dashes'])
    const home = process.env.ENGINE_PROJECT_DIR
    if (!home) throw new ProgramError(['ENGINE_PROJECT_DIR names the project home the program is made in'])
    const dest = join(home, 'programs', 'src', name)
    if (existsSync(dest)) throw new ProgramError([`${dest} exists already`])
    const template = new URL('../../project-template/start/programs/template/', import.meta.url)
    cpSync(template, dest, { recursive: true })
    const mf = join(dest, 'manifest.json')
    const m = JSON.parse(readFileSync(mf, 'utf8'))
    m.id = `prg_${name.replace(/-/g, '_')}`; m.name = name; m.ui.blocks = [name]; m.package.owns = name.replace(/-/g, '_')
    writeFileSync(mf, JSON.stringify(m, null, 2) + '\n')
    console.log(`${dest}\n(from the template — see docs/program-contract.md; rename the slice "example" in server/ and web/ to "${m.package.owns}")`)
    return
  }
  if (cmd === 'build') { const r = buildProgram(resolve(a ?? '.'), store); console.log(`${r.hash}  ${r.manifest.name}`); return }
  if (cmd === 'list') { for (const m of store.list()) console.log(`${m.hash.slice(0, 12)}  ${m.name}  v${m.version}  ${m.scope}  ${m.attachesTo ?? ''}  ${built(store, m.hash)}`); return }
  if (cmd === 'doc') { process.stdout.write(store.doc(resolveProgram(store, a))); return }
  if (cmd === 'inspect') { console.log(JSON.stringify(inspect(store, resolveProgram(store, a), b ?? 'run'), null, 2)); return }
  if (cmd === 'verify') {
    let bad = 0
    for (const m of store.list()) { const ok = store.verify(m.hash); if (!ok) bad++; console.log(`${ok ? 'ok ' : 'BAD'}  ${m.hash.slice(0, 12)}  ${m.name}`) }
    if (bad) process.exitCode = 1
    return
  }
  if (cmd === 'run') {
    const hash = resolveProgram(store, a)
    const pkg = await loadPackage(store, hash)
    const engine = createStateEngine([pkg as any], { services: { query } })
    let state = engine.start()
    const ran: unknown[] = [], changed: string[] = []
    const t0 = Date.now()
    const ops = (flags.set ?? []).map(parseSet)
    if (ops.length) { const o = await engine.dispatch(state, ops); state = o.state; ran.push(...o.ran); changed.push(...o.changed) }
    const act = flag('act'), fn = flag('call')
    if (act || fn || !ops.length) {
      const o = act ? await engine.act(state, pkg.name, act) : await engine.call(state, pkg.name, fn ?? 'run')
      state = o.state; ran.push(...o.ran); changed.push(...o.changed)
    }
    console.log(JSON.stringify({ program: pkg.name, hash, ms: Date.now() - t0, changed: [...new Set(changed)], ran, slice: state[pkg.name] }, null, 2))
    return
  }
  throw new ProgramError([`unknown command "${cmd}" — try: programs help`])
}

main().catch((e) => {
  console.error(e instanceof ProgramError || e instanceof StateRefusal ? `refused: ${e.message}` : (e?.stack ?? String(e)))
  process.exit(1)
})
