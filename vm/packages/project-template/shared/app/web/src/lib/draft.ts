// Commit on close — the interaction rule for every control that edits a question and stays open while it is used.
//
// While a control is open (a multi-select, a picker, a popover) it edits a DRAFT and sends nothing. When it closes
// (a click outside, Escape, Enter, blur) the draft is compared with the value that was in force when it opened,
// normalised (order-independent for sets); if they are the same, nothing is sent; if they differ, ONE change is
// sent with the whole of it. The person sees the draft honestly while it is open — a tick appears at once.
//
// Controls that close on choose (a single-choice select, a stepper's click, a preset) commit on choose; a text or
// number input commits on blur or Enter. Those need no draft.
//
// `Draft` is the rule as a value, so it can be tested without a renderer; `useDraft` is the same thing as a hook.

import { useCallback, useEffect, useRef, useState } from 'react'

/** The same value, whatever the order of a set: arrays are compared sorted, objects by their JSON. */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(normal(a)) === JSON.stringify(normal(b))
const normal = (v: unknown): unknown => (Array.isArray(v) ? [...v].map(normal).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort().map(([k, x]) => [k, normal(x)])) : v)

export class Draft<T> {
  private current: T
  private commit: (value: T) => void
  private same: (a: T, b: T) => boolean
  private opened: T
  private draft: T
  private isOpen = false
  constructor(current: T, commit: (value: T) => void, same: (a: T, b: T) => boolean = sameValue) { this.current = current; this.commit = commit; this.same = same; this.opened = current; this.draft = current }
  /** What the control shows: the draft while open, the question's value while closed. */
  get value(): T { return this.isOpen ? this.draft : this.current }
  get open(): boolean { return this.isOpen }
  /** Whether the draft differs from what was in force when the control opened. */
  get dirty(): boolean { return this.isOpen && !this.same(this.draft, this.opened) }
  /** The question changed underneath (an answer arrived): a closed control follows it. */
  follow(current: T) { this.current = current; if (!this.isOpen) { this.draft = current; this.opened = current } }
  start() { this.opened = this.current; this.draft = this.current; this.isOpen = true }
  set(next: T) { if (this.isOpen) this.draft = next }
  /** Close: one commit with the whole change, or none. */
  close() { if (!this.isOpen) return; this.isOpen = false; if (!this.same(this.draft, this.opened)) this.commit(this.draft) }
  /** Close without committing (Escape may mean "leave it"). */
  cancel() { this.isOpen = false; this.draft = this.current }
}

export function useDraft<T>(current: T, commit: (value: T) => void, same: (a: T, b: T) => boolean = sameValue) {
  const commitRef = useRef(commit)
  commitRef.current = commit
  const draft = useRef(new Draft<T>(current, (v) => commitRef.current(v), same))
  const [, tick] = useState(0)
  const rerender = () => tick((n) => n + 1)
  useEffect(() => { draft.current.follow(current); rerender() }, [current])
  const start = useCallback(() => { draft.current.start(); rerender() }, [])
  const set = useCallback((v: T) => { draft.current.set(v); rerender() }, [])
  const close = useCallback(() => { draft.current.close(); rerender() }, [])
  const cancel = useCallback(() => { draft.current.cancel(); rerender() }, [])
  const d = draft.current
  return { value: d.value, open: d.open, dirty: d.dirty, start, set, close, cancel }
}
