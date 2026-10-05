// A THREAD KEPT IN THE BROWSER — for a surface that has no session behind it (the admin console, the user UI's pages):
// the same tree of blocks as a session's, drawn with the same frames. Every click opens a block below (from an earlier
// block, a branch); looking closer changes a block in place; a form is a block that locks when sent and leaves a
// receipt block. The tree lives in the history (Back and Forward walk it); the address names the current block.
//
//   blocks     a registry of block types: what each is (label, icon, accent), how it names itself, how it draws
//   useThread  inside a block: open a block below this one, change this one, start over
//
// Nothing here knows what a surface shows: the surface gives the registry.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import BlockFrame from './BlockFrame'
import Steps, { type StepItem } from './Steps'
import { revealBlock } from './navigation'

export interface LocalBlock { id: string; type: string; props: Record<string, unknown>; parent: string | null; cause?: string; at: string; step: number; kids: string[]; active?: string }
interface Tree { nodes: Record<string, LocalBlock>; root: string | null; leaf: string | null; next: number; rev: number }

export interface BlockApi {
  /** This block's id and props. */
  id: string
  props: Record<string, unknown>
  /** Open a block below this one (from an earlier block: a new branch). */
  open: (type: string, props?: Record<string, unknown>, cause?: string) => void
  /** Change this block in place (looking closer: a filter, a page). */
  update: (props: Record<string, unknown>) => void
  /** A fresh thread from a block (the sidebar, home). */
  start: (type: string, props?: Record<string, unknown>) => void
}

export interface BlockDef {
  label: string
  icon?: string
  accent?: string
  /** The block's title from its props (else its label). */
  title?: (props: Record<string, unknown>) => string
  subtitle?: (props: Record<string, unknown>) => string | undefined
  /** A PAGE, not a block: something that needs the whole page to be seen (a graph to walk) is a thread on its own —
   *  started from the sidebar, drawn full width without a frame, with nothing opened below it. */
  page?: boolean
  render: (api: BlockApi) => ReactNode
}
export type Registry = Record<string, BlockDef>

const BlockContext = createContext<BlockApi | null>(null)
/** Inside a block: open the next one, change this one, start over. */
export function useThread(): BlockApi {
  const b = useContext(BlockContext)
  if (!b) throw new Error('useThread is used inside a block of a LocalThread')
  return b
}

const empty: Tree = { nodes: {}, root: null, leaf: null, next: 1, rev: 0 }
const KEY = 'sa-local-thread'
let n = 0
const newId = () => `lb${Date.now().toString(36)}${(n++).toString(36)}`

/** The blocks from the root down the active branch. */
function activePath(t: Tree): LocalBlock[] {
  const out: LocalBlock[] = []
  for (let id = t.root; id; id = t.nodes[id]?.active ?? null) { const b = t.nodes[id]; if (!b) break; out.push(b) }
  return out
}

export default function LocalThread({ blocks, home, empty: emptyView, after, onRoot, address }: {
  blocks: Registry
  /** The block a fresh thread starts from, when there is none (else the empty view). */
  home?: { type: string; props?: Record<string, unknown> }
  empty?: ReactNode
  after?: ReactNode
  /** The type the current thread started from (the sidebar marks it, and keeps it whatever is opened below). */
  onRoot?: (type: string | null) => void
  /** The address that names a block (the current one goes in the address bar, so a reload or a link lands on it). */
  address?: (block: LocalBlock) => string | null
}) {
  const [tree, setTree] = useState<Tree>(() => (history.state?.[KEY] as Tree | undefined) ?? empty)
  const treeRef = useRef(tree); treeRef.current = tree
  const addressRef = useRef(address); addressRef.current = address
  // Every change is a history entry (opening, starting) or replaces the current one (changing in place, branching back).
  const commit = useCallback((next: Tree, push: boolean) => {
    const t = { ...next, rev: next.rev + 1 }
    setTree(t)
    const state = { ...(history.state ?? {}), [KEY]: t }
    const leaf = t.leaf ? t.nodes[t.leaf] : null
    const url = leaf && addressRef.current ? addressRef.current(leaf) ?? undefined : undefined
    if (push) history.pushState(state, '', url); else history.replaceState(state, '', url)
  }, [])
  useEffect(() => {
    const onPop = (e: PopStateEvent) => { const t = e.state?.[KEY] as Tree | undefined; setTree(t ?? empty) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const start = useCallback((type: string, props: Record<string, unknown> = {}) => {
    const id = newId()
    commit({ nodes: { [id]: { id, type, props, parent: null, at: new Date().toISOString(), step: 1, kids: [] } }, root: id, leaf: id, next: 2, rev: treeRef.current.rev }, true)
    setTimeout(() => revealBlock(id), 30)
  }, [commit])
  useEffect(() => { if (!tree.root && home) start(home.type, home.props) }, [tree.root, home, start])
  useEffect(() => { const on = (e: Event) => { const d = (e as CustomEvent).detail; start(d.type, d.props) }; window.addEventListener('sa-thread-start', on); return () => window.removeEventListener('sa-thread-start', on) }, [start])
  useEffect(() => { onRoot?.(tree.root ? tree.nodes[tree.root]?.type ?? null : null) }, [tree.root, tree.nodes, onRoot])

  const open = useCallback((from: string, type: string, props: Record<string, unknown> = {}, cause?: string) => {
    const t = treeRef.current
    const parent = t.nodes[from]
    if (!parent) return
    const id = newId()
    const node: LocalBlock = { id, type, props, parent: from, cause, at: new Date().toISOString(), step: t.next, kids: [] }
    commit({ ...t, nodes: { ...t.nodes, [from]: { ...parent, kids: [...parent.kids, id], active: id }, [id]: node }, leaf: id, next: t.next + 1 }, true)
    setTimeout(() => revealBlock(id), 30)
  }, [commit])
  const update = useCallback((id: string, props: Record<string, unknown>) => {
    const t = treeRef.current
    const b = t.nodes[id]
    if (b) commit({ ...t, nodes: { ...t.nodes, [id]: { ...b, props: { ...b.props, ...props } } } }, false)
  }, [commit])
  const remove = useCallback((id: string) => {
    const t = treeRef.current
    const b = t.nodes[id]
    if (!b?.parent) return
    const nodes = { ...t.nodes }
    const drop = (x: string) => { for (const k of nodes[x]?.kids ?? []) drop(k); delete nodes[x] }
    drop(id)
    const parent = { ...nodes[b.parent], kids: nodes[b.parent].kids.filter((k) => k !== id) }
    parent.active = parent.kids[parent.kids.length - 1]
    nodes[b.parent] = parent
    commit({ ...t, nodes }, false)
  }, [commit])
  const switchBranch = useCallback((id: string) => {
    const t = treeRef.current
    const b = t.nodes[id]
    if (!b?.parent) return
    const nodes = { ...t.nodes, [b.parent]: { ...t.nodes[b.parent], active: id } }
    let leaf = id; while (nodes[leaf]?.active) leaf = nodes[leaf].active!
    commit({ ...t, nodes, leaf }, true)
  }, [commit])

  const path = useMemo(() => activePath(tree), [tree])
  const rootDef = path[0] ? blocks[path[0].type] : undefined
  if (path[0] && rootDef?.page) {
    const b = path[0]
    const api: BlockApi = { id: b.id, props: b.props, open: () => {}, update: (props) => update(b.id, props), start }
    return <div className="sa-fullpage"><BlockContext.Provider value={api}>{rootDef.render(api)}</BlockContext.Provider></div>
  }
  const items: StepItem[] = path.map((b, i) => {
    const def = blocks[b.type]
    const parent = b.parent ? tree.nodes[b.parent] : null
    const siblings = parent && parent.kids.length > 1 ? parent.kids.map((k) => ({ id: k, label: blocks[tree.nodes[k]?.type]?.title?.(tree.nodes[k].props) ?? blocks[tree.nodes[k]?.type]?.label ?? 'A step', cause: tree.nodes[k]?.cause, active: k === b.id })) : undefined
    const api: BlockApi = { id: b.id, props: b.props, open: (type, props, cause) => open(b.id, type, props, cause), update: (props) => update(b.id, props), start }
    const parentStep = parent ? path.findIndex((x) => x.id === parent.id) + 1 : 0
    return {
      id: b.id, at: b.at, siblings,
      node: (
        <BlockFrame id={b.id} step={i + 1} accent={def?.accent} icon={def?.icon} label={def?.label}
          title={def?.title?.(b.props) ?? def?.label ?? b.type} subtitle={def?.subtitle?.(b.props)}
          cause={b.cause} from={parent ? { id: parent.id, step: parentStep, onPath: true } : undefined} onReveal={revealBlock}
          onRemove={b.parent ? () => remove(b.id) : undefined}>
          <BlockContext.Provider value={api}>
            {def ? def.render(api) : <p className="sa-note sa-section__empty">This screen cannot draw a block of kind “{b.type}”.</p>}
          </BlockContext.Provider>
        </BlockFrame>
      ),
    }
  })
  return <Steps items={items} onSwitch={switchBranch} empty={emptyView} after={after} />
}

/** Start a fresh thread from outside the blocks (the sidebar): the thread listens for it. */
export function startThread(type: string, props: Record<string, unknown> = {}) {
  window.dispatchEvent(new CustomEvent('sa-thread-start', { detail: { type, props } }))
}
