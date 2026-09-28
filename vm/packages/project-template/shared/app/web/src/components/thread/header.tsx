// How a block names itself in its frame once it knows what it shows (a SKU's name, after it loads).

import { createContext, useContext, useEffect, type ReactNode } from 'react'

export interface Header {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}

export const HeaderContext = createContext<(h: Header) => void>(() => {})

export function useBlockHeader(header: Header, deps: unknown[]) {
  const set = useContext(HeaderContext)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => set(header), deps)
}

/**
 * What a block puts on the clipboard when its copy button is pressed. A block that knows its data better than its
 * screen does (a receipt, a form) returns its own text; blocks that register nothing are copied by `blockToText`.
 */
export type CopyText = () => string | Promise<string>

export const CopyContext = createContext<(fn: CopyText | null) => void>(() => {})

export function useBlockCopy(fn: CopyText, deps: unknown[]) {
  const register = useContext(CopyContext)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    register(fn)
    return () => register(null)
  }, deps)
}
