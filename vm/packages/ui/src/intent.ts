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

export function Intent({ ops, action, call, to = 'current', block, as = 'button', label, className, disabled, children }: IntentProps) {
  const intent: ScreenIntent = { ...(ops ? { ops } : {}), ...(action ? { action } : {}), ...(call ? { call } : {}), to, ...(block ? { block } : {}) }
  const bad = problemsOf(intent)
  // A broken intent is a bug in the program that wrote it: it is shown, not sent.
  if (bad.length) return createElement('span', { className: 'sa-intent-broken', role: 'alert' }, `This control is broken: ${bad.join('; ')}`)
  const props: Record<string, unknown> = { [INTENT_ATTR]: JSON.stringify(intent), className, 'aria-label': label, 'aria-disabled': disabled || undefined }
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

/** The one listener: a click, or Enter / Space on a focused control, sends the nearest intent. Returns a function that
 *  removes it. `trace` sees every intent sent, and every one refused because its control is disabled. */
export function listenIntents(root: HTMLElement | Document, send: (i: ScreenIntent) => void, trace?: (e: { intent: ScreenIntent; sent: boolean; at: string }) => void): () => void {
  const fire = (target: EventTarget | null, ev: Event) => {
    const el = (target as Element | null)?.closest?.(`[${INTENT_ATTR}]`)
    if (!el) return
    const intent = readIntent(el)
    if (!intent) return
    ev.preventDefault()
    const disabled = el.getAttribute('aria-disabled') === 'true' || (el as HTMLButtonElement).disabled === true
    trace?.({ intent, sent: !disabled, at: new Date().toISOString() })
    if (!disabled) send(intent)
  }
  const onClick = (ev: Event) => fire(ev.target, ev)
  const onKey = (ev: Event) => {
    const k = (ev as KeyboardEvent).key
    const el = ev.target as Element | null
    // A real button already turns Enter and Space into a click.
    if ((k === 'Enter' || k === ' ') && el && el.tagName !== 'BUTTON') fire(el, ev)
  }
  root.addEventListener('click', onClick)
  root.addEventListener('keydown', onKey)
  return () => { root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey) }
}
