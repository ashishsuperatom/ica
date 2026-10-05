// ── <Intent> — the one way a screen changes STATE ────────────────────────────────────────────────────────────────────
//
// A control is wrapped in <Intent ops={…} to="current">: it renders the intent as an attribute (typed in TSX, no JSON
// written by hand) and one listener, delegated from the screen's root, sends it. Because every intent is in the
// markup, every intent on screen can be listed — by an agent, a test, or the trace — without clicking anything.

import { createElement, type ReactNode } from 'react'
import type { Destination, Op } from '@superatom/platform-types'
import { checkOp } from '@superatom/platform-types'

export const INTENT_ATTR = 'data-sa-intent'

/** What a control sends: ops, an action a package suggested, or a call — and where the result goes. The session, the
 *  person and the time are added by whoever carries it to the session. */
export interface ScreenIntent {
  ops?: Op[]
  action?: { package: string; id: string }
  call?: { package: string; fn: string; params?: Record<string, unknown> }
  to: Destination
  /** The block the control is in; left out, the session's current block. */
  block?: string
}

export interface IntentProps extends Omit<ScreenIntent, 'to'> {
  to?: Destination
  /** The element to render: a button unless said otherwise. Anything else is made focusable and keyboard operable. */
  as?: 'button' | 'a' | 'div' | 'span' | 'li' | 'tr' | 'td'
  label?: string
  className?: string
  /** A hint shown on hover (why one would take it). */
  title?: string
  disabled?: boolean
  children?: ReactNode
}

function problemsOf(i: ScreenIntent): string[] {
  const out: string[] = []
  if (i.to !== 'new' && i.to !== 'current') out.push(`to must be new or current, not ${JSON.stringify(i.to)}`)
  if (!i.ops?.length && !i.action && !i.call) out.push('an intent carries ops, an action or a call')
  i.ops?.forEach((op, n) => out.push(...checkOp(op, `ops[${n}]`)))
  return out
}

export function Intent({ ops, action, call, to = 'current', block, as = 'button', label, className, title, disabled, children }: IntentProps) {
  const intent: ScreenIntent = { ...(ops ? { ops } : {}), ...(action ? { action } : {}), ...(call ? { call } : {}), to, ...(block ? { block } : {}) }
  const bad = problemsOf(intent)
  // A broken intent is a bug in the program that wrote it: it is shown, not sent.
  if (bad.length) return createElement('span', { className: 'sa-intent-broken', role: 'alert' }, `This control is broken: ${bad.join('; ')}`)
  const props: Record<string, unknown> = { [INTENT_ATTR]: JSON.stringify(intent), className, title, 'aria-label': label, 'aria-disabled': disabled || undefined }
  if (as === 'button') Object.assign(props, { type: 'button', disabled })
  else Object.assign(props, { role: 'button', tabIndex: disabled ? -1 : 0 })
  return createElement(as, props, children ?? label)
}

/** The intent an element carries, or null. */
export function readIntent(el: Element): ScreenIntent | null {
  const raw = el.getAttribute(INTENT_ATTR)
  if (!raw) return null
  try { const i = JSON.parse(raw) as ScreenIntent; return problemsOf(i).length ? null : i } catch { return null }
}

/** Every intent on screen under a root, in document order, with what a person reads on it. */
export function listIntents(root: ParentNode): { intent: ScreenIntent; text: string; disabled: boolean }[] {
  return [...root.querySelectorAll(`[${INTENT_ATTR}]`)].flatMap((el) => {
    const intent = readIntent(el)
    return intent ? [{ intent, text: (el.getAttribute('aria-label') || el.textContent || '').trim(), disabled: el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled === true }] : []
  })
}

/** The one listener: a click, or Enter / Space on a focused control, sends the nearest intent with its element (so a
 *  screen can tell where it was, e.g. which block). Returns a function that removes it. `trace` sees every intent sent, and every one refused because its control is disabled. */
export function listenIntents(root: HTMLElement | Document, send: (i: ScreenIntent, el: Element) => void, trace?: (e: { intent: ScreenIntent; sent: boolean; at: string }) => void): () => void {
  const fire = (target: EventTarget | null, ev: Event) => {
    const el = (target as Element | null)?.closest?.(`[${INTENT_ATTR}]`)
    if (!el) return
    const intent = readIntent(el)
    if (!intent) return
    ev.preventDefault()
    const disabled = el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled === true
    trace?.({ intent, sent: !disabled, at: new Date().toISOString() })
    if (!disabled) send(intent, el)
  }
  const onClick = (ev: Event) => fire(ev.target, ev)
  const onKey = (ev: Event) => {
    const k = (ev as KeyboardEvent).key
    const el = ev.target as Element | null
    // A real button already turns Enter and Space into a click.
    if ((k === 'Enter' || k === ' ') && el && el.tagName !== 'BUTTON') fire(el, ev)
  }
  // A control that commits on change (a select, a stepper, a draft closed) sends its intent from its element.
  const onSend = (ev: Event) => {
    const intent = (ev as CustomEvent<ScreenIntent>).detail
    if (!intent || problemsOf(intent).length) return
    trace?.({ intent, sent: true, at: new Date().toISOString() })
    send(intent, ev.target as Element)
  }
  root.addEventListener('click', onClick)
  root.addEventListener('keydown', onKey)
  root.addEventListener(SEND_EVENT, onSend)
  return () => { root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey); root.removeEventListener(SEND_EVENT, onSend) }
}

const SEND_EVENT = 'sa-intent'
/** Send an intent from a control that commits on change rather than on a click (a select, a stepper): it bubbles from
 *  the element to the screen's one listener, which knows the block the element is in. A broken intent is not sent. */
export function sendIntent(from: Element, intent: Omit<ScreenIntent, 'to'> & { to?: Destination }): boolean {
  const i: ScreenIntent = { to: 'current', ...intent }
  const bad = problemsOf(i)
  if (bad.length) { console.warn(`[intent] not sent: ${bad.join('; ')}`); return false }
  from.dispatchEvent(new CustomEvent(SEND_EVENT, { detail: i, bubbles: true }))
  return true
}
