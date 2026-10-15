// TYPE ANYWHERE TO ASK (the user app's own): a letter typed, or text pasted, while nothing that takes text has the focus
// (no field, no open dialog) goes into the ask bar (#sa-ask) — the field focused, the caret at the end. No click first.

/** What the page is doing when a key or a paste arrives. */
export interface Moment { key?: string; mods?: boolean; composing?: boolean; pasted?: string; fieldFocused: boolean; dialogOpen: boolean; askReady: boolean }
/** The text the ask bar takes for this moment, or null (it is someone else's). */
export function textForAsk(m: Moment): string | null {
  if (m.fieldFocused || m.dialogOpen || !m.askReady) return null
  if (m.pasted !== undefined) return m.pasted || null
  if (m.mods || m.composing || !m.key || !/^[A-Za-z]$/.test(m.key)) return null
  return m.key
}

const takesText = (el: Element | null) => !!el && el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.getAttribute('role') === 'textbox')
const ask = () => document.getElementById('sa-ask') as HTMLTextAreaElement | null
const moment = (target: EventTarget | null): Omit<Moment, 'key' | 'mods' | 'composing' | 'pasted'> => {
  const el = ask()
  return { fieldFocused: takesText(target as Element) || takesText(document.activeElement), dialogOpen: !!document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]'), askReady: !!el && !el.disabled }
}
/** The words added as if typed: React's own change (the value set through the field's setter, then an input event). */
function put(text: string) {
  const el = ask(); if (!el) return
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  set?.call(el, el.value + text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.focus(); el.setSelectionRange(el.value.length, el.value.length)
}

/** Listen on the page; returns the stop. */
export function typeToAsk(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    const t = textForAsk({ key: e.key, mods: e.ctrlKey || e.metaKey || e.altKey, composing: e.isComposing, ...moment(e.target) })
    if (t !== null) { e.preventDefault(); put(t) }
  }
  const onPaste = (e: ClipboardEvent) => {
    const t = textForAsk({ pasted: e.clipboardData?.getData('text/plain') ?? '', ...moment(e.target) })
    if (t !== null) { e.preventDefault(); put(t) }
  }
  document.addEventListener('keydown', onKey); document.addEventListener('paste', onPaste)
  return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('paste', onPaste) }
}
