// ARRANGE (the framework's, from slob): moving a block's cards up or down, one place at a time, and keeping that order
// in this browser. Every surface on AppShell has it: the shell holds the switch, every BlockFrame's body and every page
// wrapped in <Arranged> is a column of cards it arranges — nothing for a screen to write.
//
// A small "Arrange" button at the bottom of the page turns it on. The page stays as it is, but nothing inside a
// card answers a click: a click selects the whole card (a ring shows it), ↑ and ↓ move it one place within its own
// block — never out of it — and the card slides to its new place, the page following it to the middle of the screen.
// Delete (or Backspace) hides the selected card; hidden cards are not shown, except while arranging, faded, where
// "Show this card" brings one back; "Reset this screen" puts every card on the screen back where the code has it. Moves and hides are a draft until kept: Enter or Done keeps them; Esc or Cancel
// puts every card back as it was when arranging began.
//
// How, safely: no block's code changes and no component is moved. Every block lays its cards out in one column, so
// Arrange only sets each card's place in that column (CSS `order`) and whether it shows. The layout is kept in
// localStorage per block's scope (a block's kind and title, or a page's address with its ids taken out): { order: card ids, hidden: card ids }, a few bytes. It is applied before the page is painted, so a
// block never shows the code's order and then jumps. With nothing kept, the code's order stands; a card kept that is
// gone is skipped, and a new card takes its place from the code among the rest.
//
// What is a card, and its id (the only contract a block has with Arrange, and it needs no code from the block):
//   a Section               its title                   components/ui Section — renaming a title resets its kept place
//   an element with data-card  that value               for a card that is not a Section (a row of figures: "figures")
//   a row of Sections       their titles, joined        cards side by side move as one
// Anything else in the column — the filter line, an error note, a loading placeholder — is not a card and never moves.
// Two cards with the same id in one block are told apart by their order (a second "Plans" is "Plans#2").
//
// The one piece of logic, how a kept order meets the cards present, is arranged() — tested in test/arrange.test.tsx.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Icon } from '../ui/Icon'

const KEY = (scope: string) => `sa.arrange:${scope}`

/** A block's layout: its cards' order, and which are hidden. */
export interface Layout {
  order: string[]
  hidden: string[]
}
const EMPTY: Layout = { order: [], hidden: [] }

function kept(scope: string): Layout {
  try {
    const v = JSON.parse(localStorage.getItem(KEY(scope)) ?? 'null')
    // A plain list is the first shape it was kept in (order only).
    if (Array.isArray(v)) return { order: v.map(String), hidden: [] }
    if (v && typeof v === 'object') return { order: (v.order ?? []).map(String), hidden: (v.hidden ?? []).map(String) }
    return EMPTY
  } catch {
    return EMPTY
  }
}
function keep(scope: string, layout: Layout) {
  try {
    localStorage.setItem(KEY(scope), JSON.stringify(layout))
  } catch {
    /* a convenience only */
  }
}

interface State {
  on: boolean
  start: () => void
  /** Ends arranging: keep the drafts (Enter, Done) or drop them (Esc, Cancel). */
  finish: (keepIt: boolean) => void
  selected: { scope: string; id: string } | null
  select: (s: { scope: string; id: string } | null) => void
  /** Moves and hides not yet kept, per block. */
  drafts: Map<string, Layout>
  /** Whether the selected card is hidden (so the button bar offers to show it), and doing so. */
  selectedHidden: boolean
  showSelected: () => void
  /** Bumped when arranging ends, so every block lays its cards out again from what is kept. */
  round: number
  /** The blocks on screen now (each card list adds itself), and putting all of them back as they were. */
  scopes: Set<string>
  resetScreen: () => void
  /** How many cards each block on screen holds: Arrange is offered only where there are cards to arrange. */
  report: (scope: string, cards: number) => void
  arrangeable: boolean
}
const Ctx = createContext<State>({ on: false, start: () => {}, finish: () => {}, selected: null, select: () => {}, drafts: new Map(), round: 0, selectedHidden: false, showSelected: () => {}, scopes: new Set(), resetScreen: () => {}, report: () => {}, arrangeable: false })
export const useArranging = () => useContext(Ctx)

export function ArrangeProvider({ children }: { children: ReactNode }) {
  const [on, setOn] = useState(false)
  const [selected, select] = useState<State['selected']>(null)
  const [round, setRound] = useState(0)
  const drafts = useRef(new Map<string, Layout>()).current
  // Bumped by any draft change, so the button bar knows whether the selected card is hidden.
  const [, setTick] = useState(0)
  const selectedHidden = Boolean(selected && (drafts.get(selected.scope) ?? kept(selected.scope)).hidden.includes(selected.id))
  const showSelected = useCallback(() => {
    if (!selected) return
    const l = drafts.get(selected.scope) ?? kept(selected.scope)
    drafts.set(selected.scope, { ...l, hidden: l.hidden.filter((h) => h !== selected.id) })
    setTick((t) => t + 1)
    window.dispatchEvent(new CustomEvent('sa-arrange-redraw', { detail: selected.scope }))
  }, [selected, drafts])
  const start = useCallback(() => {
    drafts.clear()
    select(null)
    setOn(true)
  }, [drafts])
  const finish = useCallback(
    (keepIt: boolean) => {
      if (keepIt) for (const [scope, layout] of drafts) keep(scope, layout)
      drafts.clear()
      select(null)
      setOn(false)
      setRound((r) => r + 1)
    },
    [drafts],
  )
  useEffect(() => {
    if (!on) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish(false)
      // Enter keeps — unless a button has the focus (Cancel, Done): then that button's own press decides.
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault()
        finish(true)
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [on, finish])
  const scopes = useRef(new Set<string>()).current
  // Every block on the screen back to the code's order, nothing hidden — a draft like any move: Enter keeps, Esc undoes.
  const resetScreen = useCallback(() => {
    for (const scope of scopes) {
      drafts.set(scope, EMPTY)
      window.dispatchEvent(new CustomEvent('sa-arrange-redraw', { detail: scope }))
    }
    setTick((t) => t + 1)
  }, [scopes, drafts])
  const counts = useRef(new Map<string, number>()).current
  const [arrangeable, setArrangeable] = useState(false)
  const report = useCallback((scope: string, cards: number) => {
    if (cards > 0) counts.set(scope, cards); else counts.delete(scope)
    setArrangeable([...counts.values()].some((n) => n >= 2))
  }, [counts])
  const value = { on, start, finish, selected, select, drafts, round, selectedHidden, showSelected, scopes, resetScreen, report, arrangeable }
  return (
    <Ctx.Provider value={value}>
      <div className={on ? 'sa-arrange-root sa-arranging' : 'sa-arrange-root'}>{children}</div>
    </Ctx.Provider>
  )
}

/** The column holding the cards: where the cards are — going down through what wraps them (a page's header beside its
 *  panel, a single wrapper) towards the element that holds the most of them, until an element holds cards itself. */
function columnOf(root: HTMLElement): HTMLElement {
  const isCard = (x: Element) => x.matches('section, [data-card]')
  let el = root
  for (;;) {
    const kids = [...el.children] as HTMLElement[]
    if (!kids.length || kids.some(isCard)) return el
    const best = kids.map((k) => ({ k, n: k.querySelectorAll('section, [data-card]').length })).sort((a, b) => b.n - a.n)[0]
    if (!best || best.n === 0) return el
    el = best.k
  }
}

/**
 * Each element of the column with its id, in the code's order. A card is a Section (its id is its title) or anything
 * marked data-card; everything else — the filter line, an error note, a loading placeholder that comes and goes — has
 * no id and stays where it is, so it can never shift a kept order.
 */
function cardsOf(col: HTMLElement) {
  const seen = new Map<string, number>()
  return [...col.children].map((el) => {
    const h = el as HTMLElement
    const titleOf = (x: Element) => x.querySelector('h2, h3')?.textContent?.trim()
    // A row of cards side by side is one card: it moves as one.
    const inner = h.matches('section') ? [] : [...h.querySelectorAll(':scope > section, :scope > * > section')]
    const named =
      h.dataset.card ??
      (h.matches('section') && titleOf(h) ? `card:${titleOf(h)}` : null) ??
      (inner.length ? `cards:${inner.map(titleOf).filter(Boolean).join(' + ')}` : null)
    // Two cards of one name: the second is name#2, so each has its own place.
    const n = named === null ? 0 : (seen.get(named) ?? 0) + 1
    if (named !== null) seen.set(named, n)
    const id = named === null ? null : n > 1 ? `${named}#${n}` : named
    // Marked, so arranging disables everything inside it and draws its ring (design/motion.css).
    h.toggleAttribute('data-arrange-card', id !== null)
    return { el: h, id }
  })
}

/** The order to show: the kept order for the cards that are here, any new card at its place from the code. */
export function arranged(ids: string[], order: string[]): string[] {
  const present = order.filter((id) => ids.includes(id))
  for (const [i, id] of ids.entries()) {
    if (present.includes(id)) continue
    const before = ids.slice(0, i).reverse().find((x) => present.includes(x))
    present.splice(before ? present.indexOf(before) + 1 : 0, 0, id)
  }
  return present
}

/** Lays the cards out; says how many can be moved. */
function place(col: HTMLElement, layout: Layout): number {
  const cards = cardsOf(col)
  const movable = cards.filter((c) => c.id !== null).map((c) => c.id!)
  const seq = arranged(movable, layout.order)
  // The movable cards fill the places the movable cards had in the code; everything else stays where it was.
  let k = 0
  cards.forEach((c, i) => {
    const id = c.id === null ? null : seq[k++]
    const target = id === null ? c.el : cards.find((x) => x.id === id)!.el
    target.style.order = String(i)
  })
  // Hidden: not shown, except while arranging (design/motion.css), where it is faded and can be brought back.
  for (const c of cards) c.el.toggleAttribute('data-arrange-hidden', c.id !== null && layout.hidden.includes(c.id))
  return movable.length
}

/**
 * Slides the cards from where they were to where they now are (FLIP). `follow`: the card to bring to the middle of the
 * screen — measured once it is in its new place and before the slide starts, since mid-slide it is still drawn where it
 * was (the scroll had aimed there).
 */
function slide(col: HTMLElement, change: () => void, follow?: HTMLElement) {
  const els = [...col.children] as HTMLElement[]
  const before = new Map(els.map((e) => [e, e.getBoundingClientRect().top]))
  change()
  const after = new Map(els.map((e) => [e, e.getBoundingClientRect().top]))
  follow?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  for (const e of els) {
    const dy = (before.get(e) ?? 0) - (after.get(e) ?? 0)
    if (Math.abs(dy) > 1) e.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' })
  }
}

/** Arranges the cards inside `root` for the block at `scope` (its own address). */
export function useArrange(root: RefObject<HTMLElement | null>, scope: string) {
  const { on, selected, select, drafts, round, scopes, report } = useArranging()
  const current = () => drafts.get(scope) ?? kept(scope)
  useEffect(() => {
    scopes.add(scope)
    return () => {
      scopes.delete(scope)
    }
  }, [scope, scopes])

  // Before paint, and again whenever the block's cards change (data arrives, a card appears).
  useLayoutEffect(() => {
    const r = root.current
    if (!r) return
    let frame = 0
    const apply = () => { report(scope, place(columnOf(r), current())) }
    // After a cancel, the cards slide back to the kept order; otherwise they are simply placed.
    if (round > 0) slide(columnOf(r), apply)
    else apply()
    const watch = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(apply)
    })
    watch.observe(r, { childList: true, subtree: true })
    // "Show this card" (the button bar) changes a draft: this block lays out again.
    const redraw = (e: Event) => (e as CustomEvent).detail === scope && slide(columnOf(r), apply)
    window.addEventListener('sa-arrange-redraw', redraw)
    return () => {
      watch.disconnect()
      cancelAnimationFrame(frame)
      report(scope, 0)
      window.removeEventListener('sa-arrange-redraw', redraw)
    }
  }, [root, scope, round])

  // Arranging: a click selects a card; ↑/↓ move it.
  useEffect(() => {
    const r = root.current
    if (!r || !on) return
    const col = columnOf(r)
    col.dataset.arrangeColumn = ''
    const click = (e: MouseEvent) => {
      const card = [...col.children].find((c) => c.contains(e.target as Node)) as HTMLElement | undefined
      if (!card) return
      e.preventDefault()
      e.stopPropagation()
      const id = cardsOf(col).find((c) => c.el === card)?.id
      select(id ? { scope, id } : null)
    }
    r.addEventListener('click', click, true)
    return () => {
      r.removeEventListener('click', click, true)
      delete col.dataset.arrangeColumn
    }
  }, [root, scope, on, select])

  useEffect(() => {
    const r = root.current
    if (!r) return
    const col = columnOf(r)
    for (const c of cardsOf(col)) c.el.toggleAttribute('data-arrange-selected', Boolean(on && selected?.scope === scope && c.id === selected.id))
    if (!on || selected?.scope !== scope) return
    const key = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const layout = current()
      const cards = cardsOf(col)
      const card = cards.find((c) => c.id === selected.id)?.el
      // Delete or Backspace hides the selected card; on a hidden one, brings it back.
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        const hidden = layout.hidden.includes(selected.id) ? layout.hidden.filter((h) => h !== selected.id) : [...layout.hidden, selected.id]
        drafts.set(scope, { ...layout, hidden })
        place(col, drafts.get(scope)!)
        select({ ...selected }) // the button bar reads whether it is hidden now
        return
      }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      e.preventDefault()
      const seq = arranged(cards.filter((c) => c.id !== null).map((c) => c.id!), layout.order)
      const i = seq.indexOf(selected.id)
      const j = e.key === 'ArrowUp' ? i - 1 : i + 1
      if (i < 0 || j < 0 || j >= seq.length) return
      ;[seq[i], seq[j]] = [seq[j], seq[i]]
      // A draft until Enter or Done keeps it.
      drafts.set(scope, { ...layout, order: seq })
      slide(col, () => place(col, drafts.get(scope)!), card)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [root, scope, on, selected, drafts])
}

/** The switch, at the bottom, quiet: rarely used. While on, it says what to do, with Cancel beside Done. */
export function ArrangeButton() {
  const { on, start, finish, selectedHidden, showSelected, resetScreen, arrangeable } = useArranging()
  // Offered only where there is something to arrange: a block (or page) with two cards or more.
  if (!on && !arrangeable) return null
  return (
    <div className="sa-arrange-bar" data-copy="skip">
      {on ? (
        <>
          <span className="sa-arrange-bar__say">Click a card · ↑ ↓ move · Delete hides · Enter keeps · Esc cancels</span>
          {selectedHidden && <button type="button" onClick={showSelected} className="sa-arrange-bar__btn sa-arrange-bar__btn--accent" title="Bring this card back"><Icon icon="lucide:eye" /> Show this card</button>}
          <button type="button" onClick={resetScreen} className="sa-arrange-bar__btn" title="Every card on this screen back to its usual place, nothing hidden (Enter keeps, Esc undoes)"><Icon icon="lucide:rotate-ccw" /> Reset this screen</button>
          <button type="button" onClick={() => finish(false)} className="sa-arrange-bar__btn" title="Put every card back where it was (Esc)"><Icon icon="lucide:x" /> Cancel</button>
          <button type="button" onClick={() => finish(true)} className="sa-arrange-bar__btn sa-arrange-bar__btn--done" title="Keep this order (Enter)"><Icon icon="lucide:check" /> Done</button>
        </>
      ) : (
        <button type="button" onClick={start} className="sa-arrange-bar__btn sa-arrange-bar__btn--quiet" title="Arrange the cards: move a card up or down within its block"><Icon icon="lucide:arrow-up-down" /> Arrange</button>
      )}
    </div>
  )
}

/** A column of cards that Arrange arranges, kept under `scope` (a block's kind and title; a page's address). */
export function Arranged({ scope, children, className }: { scope: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useArrange(ref, scope)
  return <div ref={ref} className={className ?? 'sa-arranged'}>{children}</div>
}
