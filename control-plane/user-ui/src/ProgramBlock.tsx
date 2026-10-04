// A PROGRAM'S OWN VIEW inside a block: its React side, loaded file by file over the hub (session:file) and run with this
// page's React and platform libraries (one copy for every program). Each ui block the program declares is the export
// named for it in PascalCase (`unsettled-trips` → UnsettledTrips), drawn with { slice, state }: its part of the block's
// STATE and the whole. Its controls are <Intent>s, caught by the session's one listener. A program that fails to load or
// throws while drawing says so in its place; the rest of the page is untouched.

import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import * as ui from '@superatom/ui'
import { loadProgramUI } from '@superatom/ui'

export interface ProgramUI { package: string; hash: string; entry: string; blocks: string[] }

const PLATFORM = { react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, '@superatom/ui': ui }
const loaded = new Map<string, Promise<Record<string, unknown>>>()
const pascal = (name: string) => name.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join('')

class Boundary extends React.Component<{ name: string; children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) } }
  render() { return this.state.error ? <p className="sa-program-error" role="alert">{this.props.name} could not be drawn: {this.state.error}</p> : this.props.children }
}

export default function ProgramBlock({ program, slice, state, fetchFile }: { program: ProgramUI; slice: unknown; state: unknown; fetchFile: (hash: string, path: string) => Promise<string> }) {
  const [mod, setMod] = React.useState<Record<string, unknown> | null>(null)
  const [error, setError] = React.useState('')
  React.useEffect(() => {
    let live = true
    if (!loaded.has(program.hash)) {
      const base = `sa-program://${program.hash}/`
      const p = loadProgramUI(base + program.entry, { platform: PLATFORM, fetchText: (url) => fetchFile(program.hash, url.slice(base.length)) })
      p.catch(() => loaded.delete(program.hash))
      loaded.set(program.hash, p)
    }
    loaded.get(program.hash)!.then((m) => { if (live) setMod(m) }, (e) => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [program.hash, program.entry, fetchFile])
  if (error) return <p className="sa-program-error" role="alert">{program.package} could not be loaded: {error}</p>
  if (!mod) return null
  return <>{program.blocks.map((b) => {
    const C = mod[pascal(b)]
    if (typeof C !== 'function') return <p key={b} className="sa-program-error" role="alert">{program.package} has no view for {b} ({pascal(b)})</p>
    return <Boundary key={b} name={b}>{React.createElement(C as React.ComponentType<{ slice: unknown; state: unknown }>, { slice, state })}</Boundary>
  })}</>
}
