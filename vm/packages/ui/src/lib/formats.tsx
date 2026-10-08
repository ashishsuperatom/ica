// HOW A VALUE IS WRITTEN, BY WHO KNOWS BEST. The platform's formatters (lib/format: money in the project's currency,
// ratios, dates, counts) are the default. A program that needs its own writing exports `formats` from its React side —
// by unit: { INR: (v) => …, MT: { full: (v) => …, short: (v) => … } } — taking a library's (export { formats } from
// '@lib/<name>', or { ...libFormats, … }) when an application writes values its own way everywhere. The screen puts a
// step's programs' formats around the step (FormatsProvider), and every block in it — tables, figures, charts — asks
// useFormat() rather than writing values itself: the program's way wins over the library's, the library's over the
// platform's.

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { fmt as platformFmt, short as platformShort } from './format'

export type UnitFormat = ((v: unknown) => string) | { full: (v: unknown) => string; short?: (v: unknown) => string }
export type Formats = Record<string, UnitFormat>

const FormatsContext = createContext<Formats>({})

/** The formats in force for what is inside: these over any given further out. */
export function FormatsProvider({ formats, children }: { formats?: Formats | null; children?: ReactNode }) {
  const outer = useContext(FormatsContext)
  const merged = useMemo(() => (formats && Object.keys(formats).length ? { ...outer, ...formats } : outer), [outer, formats])
  return <FormatsContext.Provider value={merged}>{children}</FormatsContext.Provider>
}

/** The writers in force here: a value in its unit (fmt), and the short form for an axis or a ring (short). */
export function useFormat(): { fmt: (v: unknown, unit: string | undefined) => string; short: (v: unknown, unit: string | undefined) => string } {
  const f = useContext(FormatsContext)
  return useMemo(() => ({
    fmt: (v, unit) => { const u = unit ? f[unit] : undefined; return u ? (typeof u === 'function' ? u(v) : u.full(v)) : platformFmt(v, unit) },
    short: (v, unit) => { const u = unit ? f[unit] : undefined; return u ? (typeof u === 'function' ? u(v) : (u.short ?? u.full)(v)) : platformShort(v, unit) },
  }), [f])
}

/** Formats a program's React module gives (its `formats` export), checked: only functions or { full, short? } by unit. */
export function formatsOf(mod: Record<string, unknown> | null | undefined): Formats | null {
  const f = mod?.formats
  if (!f || typeof f !== 'object') return null
  const out: Formats = {}
  for (const [unit, w] of Object.entries(f as Record<string, unknown>)) {
    if (typeof w === 'function') out[unit] = w as (v: unknown) => string
    else if (w && typeof w === 'object' && typeof (w as any).full === 'function') out[unit] = w as UnitFormat
  }
  return Object.keys(out).length ? out : null
}
