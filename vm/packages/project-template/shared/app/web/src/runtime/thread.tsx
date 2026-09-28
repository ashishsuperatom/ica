// The decision thread — a TREE of blocks, shown as its active root→leaf PATH.
//
// A block is one Question and its Answer. Every block remembers the block it was opened from (its parent). What you
// see is the active path from the root down to where you are. Two gestures:
//
//   • deepen  — open from the LAST block: a child is appended, the path grows down.
//   • fork    — open from an EARLIER block: a NEW branch starts there and becomes the active path; the branch you
//               were on stays in the tree as a sibling, reachable from the BranchBar at the fork point (and via
//               browser Back, since every structural state rides in history.state).
//
//   start(focus)                 a fresh tree whose root opens a capability (app:start)
//   open(fromId, ops, cause)     a child of fromId asking the parent's question after `ops` (app:move) — the child is
//                                created when the answer arrives; a refusal is a toast and nothing changes
//   edit(id, ops)                a block changing itself in place (a chip, a window, an assumption)
//   switchBranch(childId)        make a sibling branch the active path
//   remove(id)                   drop a block and its subtree
//
// history.state carries the tree's shape (questions, edges, steps — never the answers, which can run to a megabyte);
// the answers live in memory beside the shape, keyed by revision. Back/Forward restore a shape and pick its answers
// back up; a block whose answer is not in memory (a reload) asks again.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Client } from '@/lib/client'
import { notify } from '@/lib/toast'
import type { About, Answer, Filter, Headline, Op, Question, Request, Said, SaidBlock, SayContext } from '@/lib/wire'
import { readSaidBlock } from '@/lib/wire'
import { AnswerCache, reconcile } from '@/lib/cache'

/** Answers seen this page session, shown at once while the same question is asked again (lib/cache). */
const cache = new AnswerCache(40)

export interface Node {
  id: string
  parentId: string | null
  from?: { id: string; step: number }
  cause?: string
  at: string
  step: number
  childOrder: string[]
  activeChild?: string
  /** What the block is asking; replaced by the answer's own question when one arrives. */
  question: Question
  answer?: Answer
  /** An in-place edit, or the block's first answer, is on its way. */
  busy: boolean
  /** The block could not be answered at all (an error, a dropped connection) — a refusal is never this. */
  error?: string
  /** A child is being opened from this block: what it was called. */
  pending?: string
  /** What the block was called before its answer arrived (the move's label). */
  placeholder?: string
  /** The one block that is not a question: where the numbers come from (app:about). Its focus is 'about'. */
  about?: About
  /** The answer shown is one seen earlier (at this time); the fresh one is on its way. */
  earlier?: string
  /** A reading: prose the reader wrote for a typed question, asked from the block above. Its `question` is that
   * block's question, kept for the context of further asks; it is never a state — nothing moves from it. */
  said?: Said
  kind?: 'said'
  /** The latest narrated line while a reading is on its way. */
  beat?: string
  /** Every narrated line of the reading, with when it arrived — kept after the answer as the story of the work. */
  beats?: Beat[]
  /** The answer as the agent says it, piece by piece, until the reading lands. */
  partial?: string
  /** The blocks the pieces' marker lines named, resolved as they were said. */
  partialBlocks?: SaidBlock[]
}
export interface Beat { text: string; at: number }

interface ThreadState { nodes: Record<string, Node>; rootId: string | null; activeLeafId: string | null; nextStep: number; rev: number; threadId: string }
type Shape = Omit<Node, 'answer' | 'busy' | 'error' | 'pending' | 'said' | 'about' | 'earlier' | 'partial' | 'partialBlocks'>
interface Saved { rev: number; nodes: Record<string, Shape>; rootId: string | null; activeLeafId: string | null; nextStep: number; threadId: string }

export interface Sibling { id: string; cause?: string; label: string; active: boolean }

interface ThreadApi {
  blocks: Node[]
  rev: number
  start: (focus: string, where?: Filter[]) => void
  /** An empty thread: the Home page. */
  home: () => void
  /** The sources block — a child of the leaf, or a fresh thread when there is none. */
  openAbout: () => void
  /** A typed question, read in prose by the thread's reader, as a child of the active leaf. */
  say: (text: string) => void
  /** A reading is on its way for this thread. */
  saying: boolean
  threadId: string
  open: (fromId: string, ops: Op[], cause: string) => void
  edit: (id: string, ops: Op[]) => void
  remove: (id: string) => void
  switchBranch: (childId: string) => void
  siblingsOf: (id: string) => Sibling[]
}

const ThreadContext = createContext<ThreadApi | null>(null)
const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const newThreadId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : uid())
const EMPTY: ThreadState = { nodes: {}, rootId: null, activeLeafId: null, nextStep: 1, rev: 0, threadId: '' }

function activePath(s: ThreadState): Node[] {
  const out: Node[] = []
  const seen = new Set<string>()
  for (let id = s.rootId; id && s.nodes[id] && !seen.has(id); id = s.nodes[id].activeChild ?? null) { seen.add(id); out.push(s.nodes[id]) }
  return out
}
function deepest(nodes: Record<string, Node>, id: string): string {
  const seen = new Set<string>()
  let cur = id
  while (nodes[cur]?.activeChild && !seen.has(cur)) { seen.add(cur); cur = nodes[cur].activeChild! }
  return cur
}
function shapeOf(s: ThreadState): Saved {
  const nodes: Record<string, Shape> = {}
  for (const [k, n] of Object.entries(s.nodes)) { const { answer: _a, busy: _b, error: _e, pending: _p, about: _ab, earlier: _ea, said: _sd, beat: _bt, beats: _bs, partial: _pt, partialBlocks: _pb, ...rest } = n; nodes[k] = rest }
  return { rev: s.rev, nodes, rootId: s.rootId, activeLeafId: s.activeLeafId, nextStep: s.nextStep, threadId: s.threadId }
}
const isSaved = (v: unknown): v is Saved => typeof v === 'object' && v !== null && typeof (v as Saved).rev === 'number' && typeof (v as Saved).nodes === 'object'

/** Scroll a block into view: the frame gives every block the id `block-<id>`. */
export function revealBlock(id: string) {
  const el = document.getElementById(`block-${id}`)
  if (!el) return
  el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
}

export function ThreadProvider({ client, children }: { client: Client; children: ReactNode }) {
  const [state, setState] = useState<ThreadState>(EMPTY)
  const live = useRef(state)
  const snapshots = useRef(new Map<number, ThreadState>())
  const scrollTo = useRef<string | null>(null)

  /** Structural changes push a history entry; a block's own answer arriving replaces the current one. */
  const commit = useCallback((next: ThreadState, push: boolean) => {
    live.current = next
    snapshots.current.set(next.rev, next)
    setState(next)
    const saved = shapeOf(next)
    if (push) history.pushState(saved, '', location.href)
    else history.replaceState(saved, '', location.href)
  }, [])

  const patch = useCallback((id: string, change: Partial<Node>) => {
    const s = live.current
    const n = s.nodes[id]
    if (!n) return
    commit({ ...s, nodes: { ...s.nodes, [id]: { ...n, ...change } } }, false)
  }, [commit])

  /** Ask for a block's answer: show one seen earlier at once if there is one, always send the request, and put the
   * fresh answer in place — the same object when nothing changed, so nothing re-renders. */
  const ask = useCallback((id: string, request: Request, question: Question | undefined, onFail: (why: string, refused: boolean) => void) => {
    const seen = cache.lookup(request, question)
    if (seen) patch(id, { answer: seen.answer, question: seen.answer.question, earlier: seen.at, placeholder: undefined })
    client.request(request).then((r) => {
      const n = live.current.nodes[id]
      if (!n) return
      if (r.t === 'app:answer') {
        cache.remember(request, r.answer)
        const answer = reconcile(n.answer, r.answer)
        if (r.answer.dropped?.length) notify(`Dropped on the way: ${r.answer.dropped.join(', ')}`, 'note')
        patch(id, { busy: false, earlier: undefined, placeholder: undefined, ...(answer === n.answer ? {} : { answer, question: answer.question }) })
      } else onFail(r.t === 'app:refused' ? r.reason : r.t === 'app:error' ? r.error : 'unexpected reply', r.t === 'app:refused')
    }, (e: unknown) => onFail(e instanceof Error ? e.message : String(e), false))
  }, [client, patch])

  /** Ask for a block's own question again (after a restore without its answer). */
  const refetch = useCallback((id: string) => {
    const n = live.current.nodes[id]
    if (!n || n.kind === 'said') return
    patch(id, { busy: true, error: undefined })
    if (n.question.focus === 'about') {
      client.request({ t: 'app:about' }).then((r) => {
        if (!live.current.nodes[id]) return
        if (r.t === 'app:about') patch(id, { busy: false, about: r.about })
        else patch(id, { busy: false, error: r.t === 'app:refused' ? r.reason : r.t === 'app:error' ? r.error : 'unexpected reply' })
      }, (e: unknown) => patch(id, { busy: false, error: e instanceof Error ? e.message : String(e) }))
      return
    }
    ask(id, { t: 'app:ask', question: n.question }, n.question, (why) => patch(id, { busy: false, error: why }))
  }, [client, patch, ask])

  // Back / Forward: pick the revision's answers back up from memory, else rebuild the shape and ask again.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const saved = e.state
      if (!isSaved(saved)) return
      const snap = snapshots.current.get(saved.rev)
      let next: ThreadState
      if (snap) next = { ...snap, nodes: Object.fromEntries(Object.entries(snap.nodes).map(([k, n]) => [k, { ...n, busy: false, pending: undefined }])) }
      else next = { rev: saved.rev, rootId: saved.rootId, activeLeafId: saved.activeLeafId, nextStep: saved.nextStep, threadId: saved.threadId || newThreadId(), nodes: Object.fromEntries(Object.entries(saved.nodes).map(([k, n]) => [k, { ...n, busy: false, ...(n.kind === 'said' ? { error: 'This reading was not kept; ask again from the block above.' } : {}) }])) }
      live.current = next
      snapshots.current.set(next.rev, next)
      setState(next)
      for (const n of activePath(next)) if (!n.answer && !n.about && !n.error) refetch(n.id)
      if (next.activeLeafId) requestAnimationFrame(() => revealBlock(next.activeLeafId!))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [refetch])

  useEffect(() => {
    if (!scrollTo.current) return
    const id = scrollTo.current
    scrollTo.current = null
    requestAnimationFrame(() => revealBlock(id))
  }, [state.rev])

  const start = useCallback((focus: string, where?: Filter[]) => {
    const id = uid()
    const root: Node = { id, parentId: null, at: new Date().toISOString(), step: 1, childOrder: [], question: { focus, where: where ?? [] }, busy: true }
    scrollTo.current = id
    commit({ nodes: { [id]: root }, rootId: id, activeLeafId: id, nextStep: 2, rev: live.current.rev + 1, threadId: newThreadId() }, true)
    ask(id, { t: 'app:start', focus, ...(where ? { where } : {}) }, undefined, (why) => patch(id, { busy: false, error: why }))
  }, [commit, patch, ask])

  const open = useCallback((fromId: string, ops: Op[], cause: string) => {
    const s = live.current
    const parent = s.nodes[fromId]
    if (!parent) return
    // The child appears at once — a placeholder named after the move, asking — so the click is seen to have
    // landed; the answer fills it, a refusal removes it and says why.
    const id = uid()
    const focused = ops.find((o): o is Extract<Op, { op: 'focus' }> => o.op === 'focus')
    const child: Node = { id, parentId: fromId, from: { id: parent.id, step: parent.step }, cause, at: new Date().toISOString(), step: s.nextStep, childOrder: [], question: { ...parent.question, ...(focused ? { focus: focused.on } : {}) }, busy: true, placeholder: cause }
    const nodes = { ...s.nodes, [id]: child, [fromId]: { ...parent, childOrder: [...parent.childOrder, id], activeChild: id } }
    scrollTo.current = id
    commit({ ...s, nodes, activeLeafId: id, nextStep: s.nextStep + 1, rev: s.rev + 1 }, true)
    const drop = () => {
      const t = live.current
      if (!t.nodes[id]) return
      const p = t.nodes[fromId]
      const rest: Record<string, Node> = {}
      for (const [k, v] of Object.entries(t.nodes)) if (k !== id) rest[k] = v
      if (p) { const remaining = p.childOrder.filter((c) => c !== id); rest[fromId] = { ...p, childOrder: remaining, activeChild: p.activeChild === id ? remaining[remaining.length - 1] : p.activeChild } }
      const leaf = p ? deepest(rest, (rest[fromId].activeChild ?? fromId)) : t.rootId ?? ''
      commit({ ...t, nodes: rest, activeLeafId: t.activeLeafId === id ? leaf : t.activeLeafId, rev: t.rev + 1 }, false)
    }
    ask(id, { t: 'app:move', question: parent.question, ops }, undefined, (why, refused) => { drop(); notify(why, refused ? 'refused' : 'error') })
  }, [commit, patch, ask])

  const openAbout = useCallback(() => {
    const s = live.current
    const id = uid()
    const parent = s.activeLeafId ? s.nodes[s.activeLeafId] : undefined
    const node: Node = { id, parentId: parent?.id ?? null, ...(parent ? { from: { id: parent.id, step: parent.step }, cause: 'Chose the app name in the sidebar' } : {}), at: new Date().toISOString(), step: parent ? s.nextStep : 1, childOrder: [], question: { focus: 'about', where: [] }, busy: true, placeholder: 'Where the numbers come from' }
    const nodes = parent ? { ...s.nodes, [id]: node, [parent.id]: { ...parent, childOrder: [...parent.childOrder, id], activeChild: id } } : { [id]: node }
    scrollTo.current = id
    commit({ nodes, rootId: parent ? s.rootId : id, activeLeafId: id, nextStep: (parent ? s.nextStep : 1) + 1, rev: s.rev + 1, threadId: parent ? s.threadId : newThreadId() }, true)
    client.request({ t: 'app:about' }).then((r) => {
      if (!live.current.nodes[id]) return
      if (r.t === 'app:about') patch(id, { busy: false, about: r.about, placeholder: undefined })
      else patch(id, { busy: false, error: r.t === 'app:refused' ? r.reason : r.t === 'app:error' ? r.error : 'unexpected reply' })
    }, (e: unknown) => patch(id, { busy: false, error: e instanceof Error ? e.message : String(e) }))
  }, [client, commit, patch])

  const home = useCallback(() => {
    commit({ ...EMPTY, rev: live.current.rev + 1 }, true)
  }, [commit])

  /** What the reader is told about a block: its question, title, headline figures and notes — never its rows. */
  const contextOf = (n: Node): SayContext => {
    const a = n.answer
    const kpis = a?.blocks.find((b) => b.type === 'kpis')
    const fig = a?.blocks.find((b) => b.type === 'figure')
    const headline: Headline[] = kpis && kpis.type === 'kpis' ? kpis.items.map((i) => ({ label: i.label, value: i.value, unit: i.unit })) : fig && fig.type === 'figure' ? [{ label: fig.label, value: fig.value, unit: fig.unit }] : []
    // The asks the block made, in the graph's own shape: the composer starts from a question that already works.
    const asked = (a?.asked ?? []).filter((x): x is { question: unknown; rows?: number } => !!x && typeof x === 'object' && 'question' in (x as object)).map((x) => ({ question: x.question, rows: typeof x.rows === 'number' ? x.rows : undefined }))
    return { question: n.question, title: a?.title ?? n.placeholder ?? n.question.focus, headline, notes: a?.notes ?? [], asked }
  }

  /** A question with no block to hang from: it starts a thread of its own, its reading the first block, and its words
   *  pick the agent that answers (the application routes a thread's first question). */
  const askFresh = useCallback((words: string) => {
    const id = uid()
    const threadId = newThreadId()
    const root: Node = { id, parentId: null, at: new Date().toISOString(), step: 1, childOrder: [], question: { focus: '', where: [] }, busy: true, placeholder: words, kind: 'said', cause: 'Asked' }
    scrollTo.current = id
    commit({ nodes: { [id]: root }, rootId: id, activeLeafId: id, nextStep: 2, rev: live.current.rev + 1, threadId }, true)
    const drop = (why: string, refused: boolean) => { patch(id, { busy: false, error: why }); notify(why, refused ? 'refused' : 'error') }
    client.request({ t: 'app:say', text: words, threadId, question: { focus: '', where: [] }, title: '', headline: [], notes: [], asked: [], path: [] }, { onBeat: (text) => { const n = live.current.nodes[id]; if (!n) return; const last = n.beats?.[n.beats.length - 1]; patch(id, { beat: text, beats: last?.text === text ? n.beats : [...(n.beats ?? []), { text, at: Date.now() }] }) }, onPart: (text, blocks) => { const n = live.current.nodes[id]; if (!n) return; const named = Array.isArray(blocks) ? blocks.map(readSaidBlock).filter((b) => b.marker) : []; patch(id, { partial: n.partial ? `${n.partial}\n${text}` : text, ...(named.length ? { partialBlocks: [...(n.partialBlocks ?? []), ...named] } : {}) }) } }).then((r) => {
      if (!live.current.nodes[id]) return
      if (r.t === 'app:said') patch(id, { busy: false, said: r.said, placeholder: undefined, beat: undefined, partial: undefined, partialBlocks: undefined })
      else drop(r.t === 'app:refused' ? r.reason : r.t === 'app:error' ? r.error : 'unexpected reply', r.t === 'app:refused')
    }, (e: unknown) => drop(e instanceof Error ? e.message : String(e), false))
  }, [client, commit, patch])

  const say = useCallback((text: string) => {
    const s = live.current
    const leaf = s.activeLeafId ? s.nodes[s.activeLeafId] : undefined
    const words = text.trim()
    if (!words) return
    if (!leaf) { askFresh(words); return }
    // Asked from the nearest block above that is a state: a reading is prose, and nothing is asked from it.
    const chain = activePath(s)
    const from = [...chain].reverse().find((n) => n.kind !== 'said' && n.question.focus !== 'about') ?? leaf
    const path = chain.filter((n) => n.kind !== 'said' && n.question.focus !== 'about' && n !== from).map(contextOf)
    const id = uid()
    const child: Node = { id, parentId: leaf.id, from: { id: leaf.id, step: leaf.step }, cause: `Asked from ${from.answer?.title ?? from.question.focus}`, at: new Date().toISOString(), step: s.nextStep, childOrder: [], question: from.question, busy: true, placeholder: words, kind: 'said' }
    const nodes = { ...s.nodes, [id]: child, [leaf.id]: { ...leaf, childOrder: [...leaf.childOrder, id], activeChild: id } }
    scrollTo.current = id
    commit({ ...s, nodes, activeLeafId: id, nextStep: s.nextStep + 1, rev: s.rev + 1 }, true)
    const ctx = contextOf(from)
    const drop = (why: string, refused: boolean) => {
      const t = live.current
      if (!t.nodes[id]) return
      const p = t.nodes[leaf.id]
      const rest: Record<string, Node> = {}
      for (const [k, v] of Object.entries(t.nodes)) if (k !== id) rest[k] = v
      if (p) { const remaining = p.childOrder.filter((c) => c !== id); rest[leaf.id] = { ...p, childOrder: remaining, activeChild: p.activeChild === id ? remaining[remaining.length - 1] : p.activeChild } }
      commit({ ...t, nodes: rest, activeLeafId: t.activeLeafId === id ? deepest(rest, rest[leaf.id]?.activeChild ?? leaf.id) : t.activeLeafId, rev: t.rev + 1 }, false)
      notify(why, refused ? 'refused' : 'error')
    }
    client.request({ t: 'app:say', text: words, threadId: s.threadId, question: from.question, title: ctx.title, headline: ctx.headline, notes: ctx.notes, asked: ctx.asked, path }, { onBeat: (text) => { const n = live.current.nodes[id]; if (!n) return; const last = n.beats?.[n.beats.length - 1]; patch(id, { beat: text, beats: last?.text === text ? n.beats : [...(n.beats ?? []), { text, at: Date.now() }] }) }, onPart: (text, blocks) => { const n = live.current.nodes[id]; if (!n) return; const named = Array.isArray(blocks) ? blocks.map(readSaidBlock).filter((b) => b.marker) : []; patch(id, { partial: n.partial ? `${n.partial}\n${text}` : text, ...(named.length ? { partialBlocks: [...(n.partialBlocks ?? []), ...named] } : {}) }) } }).then((r) => {
      if (!live.current.nodes[id]) return
      if (r.t === 'app:said') patch(id, { busy: false, said: r.said, placeholder: undefined, beat: undefined, partial: undefined, partialBlocks: undefined })
      else drop(r.t === 'app:refused' ? r.reason : r.t === 'app:error' ? r.error : 'unexpected reply', r.t === 'app:refused')
    }, (e: unknown) => drop(e instanceof Error ? e.message : String(e), false))
  }, [client, commit, patch, askFresh])

  const edit = useCallback((id: string, ops: Op[]) => {
    const n = live.current.nodes[id]
    if (!n) return
    patch(id, { busy: true })
    ask(id, { t: 'app:move', question: n.question, ops }, undefined, (why, refused) => { patch(id, { busy: false }); notify(why, refused ? 'refused' : 'error') })
  }, [patch, ask])

  const switchBranch = useCallback((childId: string) => {
    const s = live.current
    const child = s.nodes[childId]
    if (!child?.parentId) return
    const parent = s.nodes[child.parentId]
    if (!parent || parent.activeChild === childId) return
    const nodes = { ...s.nodes, [parent.id]: { ...parent, activeChild: childId } }
    const leaf = deepest(nodes, childId)
    scrollTo.current = childId
    const next = { ...s, nodes, activeLeafId: leaf, rev: s.rev + 1 }
    commit(next, true)
    for (const n of activePath(next)) if (!n.answer && !n.about && !n.error && !n.busy) refetch(n.id)
  }, [commit, refetch])

  const remove = useCallback((id: string) => {
    const s = live.current
    const node = s.nodes[id]
    if (!node || !node.parentId) return // never remove the root
    const parent = s.nodes[node.parentId]
    const doomed = new Set<string>()
    const stack = [id]
    while (stack.length) { const n = stack.pop()!; if (doomed.has(n)) continue; doomed.add(n); for (const c of s.nodes[n]?.childOrder ?? []) stack.push(c) }
    const nodes: Record<string, Node> = {}
    for (const [k, v] of Object.entries(s.nodes)) if (!doomed.has(k)) nodes[k] = v
    const remaining = parent.childOrder.filter((c) => c !== id)
    const nextActive = parent.activeChild === id ? remaining[remaining.length - 1] : parent.activeChild
    nodes[parent.id] = { ...parent, childOrder: remaining, activeChild: nextActive }
    const leaf = deepest(nodes, nextActive ?? parent.id)
    commit({ ...s, nodes, activeLeafId: leaf, rev: s.rev + 1 }, true)
  }, [commit])

  const path = useMemo(() => activePath(state), [state])
  const siblingsOf = useCallback((id: string): Sibling[] => {
    const n = state.nodes[id]
    if (!n?.parentId) return []
    const p = state.nodes[n.parentId]
    if (!p || p.childOrder.length < 2) return []
    return p.childOrder.filter((cid) => state.nodes[cid]).map((cid) => { const c = state.nodes[cid]; return { id: cid, cause: c.cause, label: c.kind === 'said' ? (c.said?.text ?? c.placeholder ?? 'a reading') : c.answer?.title ?? c.answer?.label ?? c.question.focus, active: cid === p.activeChild } })
  }, [state])

  const saying = path.some((n) => n.kind === 'said' && n.busy)
  const api = useMemo<ThreadApi>(() => ({ blocks: path, rev: state.rev, threadId: state.threadId, saying, start, home, openAbout, say, open, edit, remove, switchBranch, siblingsOf }), [path, state.rev, state.threadId, saying, start, home, openAbout, say, open, edit, remove, switchBranch, siblingsOf])
  return <ThreadContext.Provider value={api}>{children}</ThreadContext.Provider>
}

export function useThread(): ThreadApi {
  const t = useContext(ThreadContext)
  if (!t) throw new Error('useThread outside ThreadProvider')
  return t
}
