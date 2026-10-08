// A PROGRAM'S OWN VIEW inside a block: its React side, loaded file by file over the hub (session:file) and run with this
// page's React and platform libraries (one copy for every program). Each ui block the program declares is the export
// named for it in PascalCase (`unsettled-trips` → UnsettledTrips), drawn with { slice, state }: its part of the block's
// STATE and the whole. Its controls are <Intent>s, caught by the session's one listener. A program that fails to load or
// throws while drawing says so in its place; the rest of the page is untouched.

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ui from '@superatom/ui'
import { loadProgramUI, formatsOf, type Formats } from '@superatom/ui'

export interface ProgramUI { package: string; hash: string; entry: string; blocks: string[]; /** Blocks drawn above the step's answer (its controls), the rest below. */ head?: string[]; /** The library builds it links, by name: where its @lib/<name> imports lead. */ uses?: Record<string, string> }

const PLATFORM = { react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, '@superatom/ui': ui }
const loaded = new Map<string, Promise<Record<string, unknown>>>()
/** The modules already here: drawn at once, so a step never shows first without its program's view. */
const ready = new Map<string, Record<string, unknown>>()

/** Load a program's React side (once per hash). A session waits for this before it shows a step, so the step appears whole. */
export function preloadProgram(program: ProgramUI, fetchFile: (hash: string, path: string) => Promise<string>): Promise<Record<string, unknown>> {
  if (!loaded.has(program.hash)) {
    // Every file by its build's address (sa-program://<hash>/<path>): the program's own, and its libraries' — each
    // library build at its own hash, so programs sharing one share its files.
    const p = loadProgramUI(`sa-program://${program.hash}/${program.entry}`, {
      platform: PLATFORM,
      fetchText: (url) => { const m = /^sa-program:\/\/([0-9a-f]{64})\/(.+)$/.exec(url); return m ? fetchFile(m[1], m[2]) : Promise.reject(new Error(`${url} is not a program's file`)) },
      lib: (name, file) => (program.uses?.[name] ? `sa-program://${program.uses[name]}/web/${file}` : null),
    })
    p.then((m) => { ready.set(program.hash, m) }, () => loaded.delete(program.hash))
    loaded.set(program.hash, p)
  }
  return loaded.get(program.hash)!
}
/** How the step's programs write values (their `formats` exports, over the platform's), in the agent's order — none
 *  loaded yet: the platform's. */
export function stepFormats(programs: ProgramUI[]): Formats | null {
  const merged: Formats = {}
  for (const p of programs) Object.assign(merged, formatsOf(ready.get(p.hash)) ?? {})
  return Object.keys(merged).length ? merged : null
}
const pascal = (name: string) => name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('')

class Boundary extends React.Component<{ name: string; children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) } }
  render() { return this.state.error ? <p className="sa-program-error" role="alert">{this.props.name} could not be drawn: {this.state.error}</p> : this.props.children }
}

export default function ProgramBlock({ program, slice, state, fetchFile, only }: { program: ProgramUI; slice: unknown; state: unknown; fetchFile: (hash: string, path: string) => Promise<string>; only?: string[] }) {
  const [mod, setMod] = React.useState<Record<string, unknown> | null>(() => ready.get(program.hash) ?? null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let live = true
    preloadProgram(program, fetchFile).then((m) => { if (live) setMod(m) }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [program.hash, program.entry, fetchFile])   // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <p className="sa-program-error" role="alert">{program.package} could not be loaded: {error}</p>
  if (!mod) return null
  return <>{program.blocks.filter((b) => !only || only.includes(b)).map((b) => {
    const C = mod[pascal(b)]
    if (typeof C !== 'function') return <p key={b} className="sa-program-error" role="alert">{program.package} has no view for {b} ({pascal(b)})</p>
    return <Boundary key={b} name={b}>{React.createElement(C as React.ComponentType<{ slice: unknown; state: unknown }>, { slice, state })}</Boundary>
  })}</>
}
