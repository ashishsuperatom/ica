// THE CHECKS ON AN INTENT NODE'S WAYS OUT (docs/intent-graph.md): a way out to a next intent may carry a check — an option
// function (docs/program-contract.md, Options), written by the clone that closed the intent — saying whether that next
// intent makes sense after this answer. It is run exactly as a program's option functions are (@superatom/state
// runOptionFunction): the step frozen, services that only read, within the same time limit. A way out with no check is
// offered as it is; one whose check is late or fails is left out, the reason to the operators.

import { createHash } from 'node:crypto'
import { runOptionFunction, type OptionFunction, type OptionContext } from '@superatom/state'
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

/** The ways out to offer after an answer: each whose check holds (or that has none), with the label said from what is
 *  there when its check gave one. */
export async function offeredNext(edges: NextEdge[], step: { state: any; context: string; history: { question?: string; markdown: string }[] }, services: OptionContext['services'], o: { timeoutMs: number; limit: number; log?: (s: string) => void }) {
  const results = await Promise.all(edges.map(async (e) => {
    if (!e.check) return { e, label: e.label || e.title }
    try {
      const got = await runOptionFunction(await compileCheck(e.check), step.state ?? {}, { context: step.context, history: step.history }, services, o.timeoutMs)
      return got ? { e, label: typeof got.label === 'string' && got.label.trim() ? got.label.trim().slice(0, 200) : e.label || e.title } : null
    } catch (err: any) { o.log?.(`[intent] the check on the way to ${e.to} was left out: ${String(err?.message ?? err).split('\n')[0]}`); return null }
  }))
  return results.filter((x): x is { e: NextEdge; label: string } => !!x).slice(0, o.limit).map(({ e, label }) => ({ id: e.to, title: e.title, label, tag: e.tag, ...(e.kind ? { kind: e.kind } : {}), count: e.count }))
}
