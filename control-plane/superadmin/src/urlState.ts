// WHERE ONE IS, IN THE URL: a page's top-level place (which item is open, which month, which folder) as one search
// parameter — so a link sent to someone opens the same place, and a reload keeps it. The same shape as useState
// (value, set), so a page swaps one for the other; the URL is the one state (replaced as one moves, not pushed).
import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

export function useUrlState(name: string): [string | null, (value: string | null | ((was: string | null) => string | null)) => void] {
  const [params, setParams] = useSearchParams()
  const value = params.get(name)
  const set = useCallback((v: string | null | ((was: string | null) => string | null)) => setParams((p) => {
    const next = new URLSearchParams(p)
    const to = typeof v === 'function' ? v(p.get(name)) : v
    if (to) next.set(name, to); else next.delete(name)
    return next
  }, { replace: true }), [name, setParams])
  return [value, set]
}
