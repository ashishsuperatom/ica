// A sentence shown briefly at the top: a refusal's reason, an error, a note about what was dropped on the way.

import { useEffect, useState } from 'react'

export type ToastKind = 'refused' | 'error' | 'note'
export interface Toast { id: number; text: string; kind: ToastKind }

let seq = 0
let toasts: Toast[] = []
const listeners = new Set<(t: Toast[]) => void>()
const emit = () => { for (const l of listeners) l(toasts) }

export function notify(text: string, kind: ToastKind = 'note') {
  const t = { id: ++seq, text, kind }
  toasts = [...toasts, t]
  emit()
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); emit() }, kind === 'note' ? 4000 : 7000)
}

export function dismiss(id: number) { toasts = toasts.filter((x) => x.id !== id); emit() }

export function useToasts(): Toast[] {
  const [list, setList] = useState(toasts)
  useEffect(() => { listeners.add(setList); return () => { listeners.delete(setList) } }, [])
  return list
}
