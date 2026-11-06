// THE CHECKS ON AN INTENT NODE'S WAYS OUT (docs/intent-graph.md): a way out to a next intent may carry a check — an option
// function (docs/program-contract.md, Options), written by the clone that closed the intent — saying whether that next
// intent makes sense after this answer. It is run exactly as a program's option functions are (@superatom/state
// runOptionFunction): the step frozen, services that only read, within the same time limit. A way out with no check is
// offered as it is. A check judges from DATA — the tables and figures each answer showed (`data`, by name), or a query —
// never from an answer's words. Only a check that ran and said no leaves its question out: one that is late or fails is
// unclear, and its question is offered (the failure to the operators, and into its history for the learner to fix).

import { createHash } from 'node:crypto'
import { runOptionFunction, type OptionFunction, type OptionContext } from '@superatom/state'
import { NEXT_KINDS, FAILS_TO_SKIP, nextLikelihood, type CheckOutcome, type NextKind } from '@superatom/platform-types'
import type { NextEdge } from './intent.js'

const compiled = new Map<string, Promise<OptionFunction>>()

/** A check's source, loaded as a module: its default export. Throws when it does not load or exports no function. */
export function compileCheck(src: string): Promise<OptionFunction> {
  const key = createHash('sha256').update(src).digest('hex')
  if (!compiled.has(key)) {
    if (compiled.size > 500) compiled.delete(compiled.keys().next().value!)
    compiled.set(key, import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`).then((m) => {
      if (typeof m.default !== 'function') throw new Error('a check exports a function as its default')
      return m.default as OptionFunction
    }))
    compiled.get(key)!.catch(() => compiled.delete(key))
  }
  return compiled.get(key)!
}

/** The data an answer showed, for checks: each block by its name (the marker's file, `late.json`), a table's rows capped. */
export const CHECK_ROWS = 1000
export function dataOf(blocks: Record<string, Record<string, unknown>> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [marker, b] of Object.entries(blocks ?? {})) {
    const name = marker.trim().split(/\s+/).at(-1)!.split('/').at(-1)!
    out[name] = Array.isArray((b as any)?.rows) ? { ...b, rows: (b as any).rows.slice(0, CHECK_ROWS) } : b
  }
  return out
}

/** How many next intents an answer offers at most. */
export const NEXT_SHOWN = 3

/** What to offer after an answer (at most NEXT_SHOWN), from a node's ways out: the ones people asked, as they are; then, for each kind of
 *  suggested one (interpolation, extrapolation, novelty), the most likely first (its history: nextLikelihood) — tried one
 *  after another, at most `perKind`, the first whose check holds offered and the rest not tried; one whose check failed
 *  FAILS_TO_SKIP times in a row is not tried. Every check tried is reported (`tried`), to be kept as its history. */
export async function offeredNext(edges: NextEdge[], step: { state: any; context: string; history: { question?: string; markdown: string }[] }, services: OptionContext['services'], o: { timeoutMs: number; perKind?: number; log?: (s: string) => void; tried?: (results: { to: string; owner: string; tag: string; outcome: CheckOutcome }[]) => void }) {
  const results: { to: string; owner: string; tag: string; outcome: CheckOutcome }[] = []
  const check = async (e: NextEdge): Promise<string | null> => {
    if (!e.check) return e.label || e.title
    let outcome: CheckOutcome = 'empty', label: string | null = null
    try {
      const got = await runOptionFunction(await compileCheck(e.check), step.state ?? {}, { context: step.context, history: step.history }, services, o.timeoutMs)
      if (got) { outcome = 'held'; label = typeof got.label === 'string' && got.label.trim() ? got.label.trim().slice(0, 200) : e.label || e.title }
    } catch (err: any) { outcome = 'failed'; label = e.label || e.title; o.log?.(`[intent] the check on the way to ${e.to} failed — offered without it: ${String(err?.message ?? err).split('\n')[0]}`) }
    results.push({ to: e.to, owner: e.owner, tag: e.tag, outcome })
    return label
  }
  // Asked next and judged a follow-up (built on this answer) first; asked next only — the next question in the session,
  // standing on its own — offered only when nothing else fills the places.
  const asked = edges.filter((e) => e.tag === 'asked' && (e.follows ?? 0) > 0)
  const after = edges.filter((e) => e.tag === 'asked' && !(e.follows ?? 0))
  const offered: { id: string; title: string; label: string; tag: 'asked' | 'suggested'; kind?: NextKind; count: number }[] = []
  for (const e of asked) { const label = await check(e); if (label) offered.push({ id: e.to, title: e.title, label, tag: 'asked', count: e.count }) }
  const shown = new Set(offered.map((x) => x.id))
  const perKind = await Promise.all(NEXT_KINDS.map(async (kind) => {
    const pool = edges.filter((e) => e.tag === 'suggested' && e.kind === kind && !shown.has(e.to) && (e.failsInRow ?? 0) < FAILS_TO_SKIP)
      .sort((a, b) => nextLikelihood(b) - nextLikelihood(a))
    for (const e of pool.slice(0, o.perKind ?? 3)) {
      const label = await check(e)
      if (label) return { id: e.to, title: e.title, label, tag: 'suggested' as const, kind, count: e.count }
    }
    return null
  }))
  for (const x of perKind) if (x && !shown.has(x.id)) { offered.push(x); shown.add(x.id) }
  for (const e of after) { if (offered.length >= NEXT_SHOWN) break; if (shown.has(e.to)) continue; const label = await check(e); if (label) { offered.push({ id: e.to, title: e.title, label, tag: 'asked', count: e.count }); shown.add(e.to) } }
  o.tried?.(results)
  if (!offered.length && results.length) o.log?.(`[intent] ${results.length} next intent${results.length === 1 ? '' : 's'} checked, none made sense here (${results.filter((r) => r.outcome === 'empty').map((r) => r.to).join(', ')})`)
  return offered.slice(0, NEXT_SHOWN)
}
