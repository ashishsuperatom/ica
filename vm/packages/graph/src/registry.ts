// ── WHERE A NAME IS LOOKED UP: THIS ORGANISATION'S PROGRAMS, AND THE LIBRARIES IT USES ─────────────────────────
//
// A name may carry a namespace — `procurement/supplier score` — and a program is reached by its full name from
// anywhere. Inside a namespace, a name without one means that namespace's first: a procurement program that reads
// `supplier score` gets `procurement/supplier score`, and only if there is none, the name at the top.
//
// A LIBRARY is a namespace whose programs live in a store of their own, mounted read-only: another team's model, a
// shared one, one registered by someone else. Its programs are used and composed exactly as this organisation's
// are — by name, through contracts, with every call remembered in the organisation's own memory — and nothing here
// can change them. A library's own names are written without its namespace; mounting gives them one.
//
// A hash names the same program everywhere, so a program found in a library is the same program wherever it runs.

import type { GraphStore, StoredProgram } from './store.js'

export interface Library {
  namespace: string
  store: GraphStore
}

export const namespaceOf = (name: string) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '')
const leaf = (name: string) => name.slice(name.lastIndexOf('/') + 1)

export class Registry {
  private readonly libraries = new Map<string, GraphStore>()

  constructor(private readonly own: GraphStore, libraries: Library[] = []) {
    for (const l of libraries) {
      if (!/^[a-z][a-z0-9_-]*(\/[a-z][a-z0-9_-]*)*$/.test(l.namespace)) throw new Error(`library namespace "${l.namespace}" must be lower-case words joined by /`)
      if (this.libraries.has(l.namespace)) throw new Error(`two libraries are mounted as "${l.namespace}"`)
      this.libraries.set(l.namespace, l.store)
    }
  }

  /** The library a full name belongs to, if any. */
  libraryOf(name: string): { namespace: string; store: GraphStore } | null {
    for (let ns = namespaceOf(name); ns; ns = namespaceOf(ns)) {
      const store = this.libraries.get(ns)
      if (store) return { namespace: ns, store }
    }
    return null
  }

  /** A name as written, read from inside a namespace: the full name it means and the program it points at. */
  resolve(name: string, from = ''): { name: string; hash: string } | null {
    const candidates = name.includes('/') ? [name] : [...(from ? [`${from}/${name}`] : []), name]
    for (const full of candidates) {
      const lib = this.libraryOf(full)
      const hash = lib ? lib.store.resolve(full.slice(lib.namespace.length + 1)) : this.own.resolve(full)
      if (hash) return { name: full, hash }
    }
    return null
  }

  /** A program by hash — the organisation's, or any library's. */
  program(hash: string): StoredProgram | null {
    const found = this.own.getProgram(hash)
    if (found) return found
    for (const store of this.libraries.values()) {
      const p = store.getProgram(hash)
      if (p) return p
    }
    return null
  }

  /** Every full name and the program it points at. */
  names(): Array<{ name: string; hash: string; library: string | null }> {
    const out = this.own.current().map((n) => ({ ...n, library: null as string | null }))
    for (const [ns, store] of this.libraries) out.push(...store.current().map((n) => ({ name: `${ns}/${n.name}`, hash: n.hash, library: ns })))
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }
}

export { leaf as nameWithoutNamespace }
