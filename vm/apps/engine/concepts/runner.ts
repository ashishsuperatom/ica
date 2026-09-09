// ── RUNNING A CONCEPT ─────────────────────────────────────────────────────────────────────────────────────
//
// The author writes a function. Everything else — the context, the execution, the recording — happens here,
// deterministically, the same way every time. That division exists because boilerplate is what an agent gets
// wrong: an import path, an escape, a forgotten await. Written once by a tool, it cannot drift the way
// boilerplate rewritten on each occasion does.
//
// NO WRAPPER FILE IS GENERATED. The original plan was to emit a module with the right imports around the
// author's function, run it, and delete it. That turned out to be unnecessary: `ctx` is an ARGUMENT, so a
// concept file has nothing to import, and the runner can simply load it and call it. Which also removes an
// entire class of bug — this repository has shipped a broken generated file three times, always an escape
// that looked right in the template and was wrong once written out.
//
// A CONCEPT THAT WILL NOT RUN CANNOT BE SAVED. The failure is recorded with the run so the author can read
// it, and the record is marked with the error so nothing downstream can persist it by mistake.

import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { query as dsQuery } from '@superatom/scaffold'
import type { ConceptCtx, ConceptMeta, ConceptResult } from '@superatom/scaffold'
import { NodeStore, putRun, runId as makeRunId, sourceHash, type ConceptRunRecord } from '@superatom/node-store'

export interface TryOpts {
  /** Path to the author's file: `meta` + a default function, no imports. */
  file: string
  params?: unknown
  store: NodeStore
  /** Where a query goes. Defaults to the datasource seam every unit already uses. */
  query?: ConceptCtx['query']
  /** Live progress, so a long concept is distinguishable from a stuck one. */
  onEvent?: (e: Record<string, unknown>) => void
  /** Wall clock before the run is abandoned. Catches the ordinary hang — a query that never returns, an
   *  await that never settles. A synchronous infinite loop cannot be interrupted from inside JavaScript at
   *  all, which is the other reason this runs as its own process: that case is survivable by killing it, and
   *  the engine is untouched either way. */
  timeoutMs?: number
}

/** How much of a distribution is kept ON THE RECORD. The value is the point; the distribution is evidence,
 *  and a hundred thousand rows in a scratch table helps nobody. Truncation is stated rather than silent —
 *  a shortened list that does not say it was shortened is a wrong answer about the data. */
const DISTRIBUTION_KEPT = 200

export interface TryResult extends ConceptRunRecord {
  /** True when the concept ran AND every invariant held — the only state from which a save is allowed. */
  ok: boolean
}

/** Load a concept file, run it once with `params`, and record what happened. */
export async function tryConcept(opts: TryOpts): Promise<TryResult> {
  const path = resolve(opts.file)
  const source = await readFile(path, 'utf8')
  const params = opts.params ?? {}
  const id = makeRunId(source, params)
  const started = Date.now()

  const caveats: string[] = []
  const verifications: TryResult['verifications'] = []
  const emit = (e: Record<string, unknown>) => { try { opts.onEvent?.(e) } catch { /* a watcher cannot break a run */ } }

  // The SAME primitives a unit gets, minus `use` — so this body is already valid inside a program, which is
  // where it will end up when an agent copies and adapts it.
  const ctx: ConceptCtx = {
    query: opts.query ?? ((sourceId, sql, p) => dsQuery(sourceId, sql, p)),
    decide: (label, condition, reason) => { emit({ t: 'decide', label, took: !!condition, reason }); return condition },
    verify: async (label, holds, detail) => {
      const t0 = Date.now()
      let ok = false
      try { ok = !!(await holds()) }
      catch (e: any) {
        // A check that could not run has not passed. Kept distinguishable from a check that ran and failed,
        // without ever letting a broken check read as a satisfied one.
        verifications.push({ label, ok: false, detail: `check threw: ${e?.message ?? e}`, ms: Date.now() - t0 })
        emit({ t: 'verify', label, ok: false })
        throw new Error(`verification "${label}" could not run: ${e?.message ?? e}`)
      }
      verifications.push({ label, ok, detail, ms: Date.now() - t0 })
      emit({ t: 'verify', label, ok })
      if (!ok) throw new Error(`verification failed: ${label}${detail ? ` — ${detail}` : ''}`)
    },
    caveat: (text) => { const t = String(text).slice(0, 500); caveats.push(t); emit({ t: 'caveat', text: t }) },
    log: (message) => emit({ t: 'log', text: String(message).slice(0, 1000) }),
  }

  let result: ConceptResult | undefined
  let meta: ConceptMeta | undefined
  let error: string | undefined
  const timeoutMs = opts.timeoutMs ?? 120_000
  try {
    // Cache-busted: an author iterates on one file, and a stale module would silently run the previous
    // attempt — the most confusing failure available in a loop like this one.
    const mod: any = await import(`${pathToFileURL(path).href}?v=${Date.now()}`)
    meta = mod.meta
    if (typeof mod.default !== 'function') throw new Error('no default export — a concept is a function (ctx, params)')
    if (!meta?.name) throw new Error('meta.name is missing — a concept must say what a user would call it')
    if (!Array.isArray(meta.sources)) throw new Error('meta.sources is missing — declare which datasources this reads')
    // NOT FATAL, but said every time. A measure that does not state its grain can be double-counted by a
    // fan-out join with every invariant still passing; one that does not state additivity gets summed across
    // a dimension where that is meaningless. Both are silent failures downstream, so the omission is made
    // noisy here — the only place anyone is looking at this concept.
    for (const [field, why] of [
      ['grain', 'what one row is — the guard against double counting'],
      ['additive', 'whether this may be summed across a dimension'],
      ['unit', 'what the number counts'],
      ['time', "'snapshot' | 'during' | 'trailing' — how it relates to time"],
    ] as const) {
      if ((meta as any)[field] === undefined) emit({ t: 'log', text: `meta.${field} is not declared — ${why}` })
    }
    // Declared parameters that arrived, and arrivals nobody declared. Neither is fatal — a default may
    // legitimately cover a missing one — but both are reported, because a parameter silently ignored is a
    // concept that looks like it responded to an input it never read.
    for (const k of Object.keys(meta.params ?? {})) {
      if (!(k in (params as any))) emit({ t: 'log', text: `parameter "${k}" is declared but was not supplied` })
    }
    for (const k of Object.keys((params as any) ?? {})) {
      if (meta.params && !(k in meta.params)) emit({ t: 'log', text: `parameter "${k}" was supplied but is not declared in meta.params` })
    }

    let timer: NodeJS.Timeout | undefined
    result = await Promise.race([
      Promise.resolve(mod.default(ctx, params)),
      new Promise<never>((_, reject) => {
        // NOT unref'd, deliberately. An unref'd timer does not hold the process open, so a concept that
        // hangs would let the process EXIT before the timeout could fire — the hang would be reported as
        // nothing at all, which is the one outcome worse than a slow failure. `finally` clears it, so a run
        // that finishes never waits on it.
        timer = setTimeout(() => reject(new Error(
          `still running after ${Math.round(timeoutMs / 1000)}s — abandoned. A query that never returns is the usual cause; ` +
          `check what this concept asks the datasource for.`)), timeoutMs)
      }),
    ]).finally(() => { if (timer) clearTimeout(timer) }) as ConceptResult
    if (!result || (result.value === undefined && result.distribution === undefined)) {
      // Neither is not a concept: something must be computed, or there is nothing to be atomic ABOUT.
      throw new Error('returned neither `value` nor `distribution` — a concept computes something')
    }
  } catch (e: any) {
    // The author's own message first: a stack whose first frame is inside the module loader tells them
    // nothing about the line they wrote.
    error = [e?.message, e?.stack].filter(Boolean).join('\n').slice(0, 4000)
  }

  // Truncate for STORAGE only — what the author was shown is what the concept returned.
  const stored: ConceptResult | undefined = result && Array.isArray(result.distribution) && result.distribution.length > DISTRIBUTION_KEPT
    ? { ...result, distribution: result.distribution.slice(0, DISTRIBUTION_KEPT) }
    : result
  if (stored !== result) caveats.push(`distribution truncated to ${DISTRIBUTION_KEPT} of ${result!.distribution!.length} rows in the stored record`)

  const record: ConceptRunRecord = {
    runId: id, sourceHash: sourceHash(source), name: meta?.name, params,
    result: stored, caveats, verifications, source, meta, ms: Date.now() - started, error, at: Date.now(),
  }
  putRun(opts.store.db, record)
  return { ...record, ok: !error }
}
