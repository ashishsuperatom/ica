// ── The answer as callers send it → the report this service draws ─────────────────
// Callers send the platform's answer in its one shape (types.ts AnswerIn): the markdown as written and its cards. Read
// at the door, once, into the report — its words and its cards as sections, in the order written; the time it covers as
// its period — so every representation (html, png, csv) is drawn from the same stored report.

import type { Answer, AnswerIn, AnswerSection, AnswerCardIn } from './types.js'

/** The answer's parts in order — its words and its cards (clients/protocol.ts partsOf, kept in step). */
function partsOf(a: AnswerIn): ({ text: string } | { card: AnswerCardIn | null })[] {
  const out: ({ text: string } | { card: AnswerCardIn | null })[] = []
  let buf: string[] = []
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ text: t }); buf = [] }
  for (const line of String(a.markdown ?? '').split('\n')) {
    if (/^\s*:::(period|answer)\b/.test(line)) continue
    const m = /^\s*:::(\w[\w-]*)\s+(\S+)\s*$/.exec(line)
    if (!m) { buf.push(line); continue }
    flush()
    out.push({ card: a.cards?.[m[2]] ?? null })
  }
  flush()
  return out
}

export function normalise(input: AnswerIn): Answer {
  const sections: AnswerSection[] = partsOf(input).map((p): AnswerSection =>
    'text' in p ? { kind: 'text', body: p.text }
      : p.card ? { kind: 'table', ...(p.card.title ? { title: p.card.title } : {}), columns: p.card.columns.map((c) => c.label), rows: p.card.text }
      : { kind: 'text', body: 'A table here could not be shown.' })
  const period = (input.periods ?? []).map((p) => `${p.label}${p.detail ? ` (${p.detail})` : ''}`).filter(Boolean).join(' · ')
  return { status: input.status, ...(input.category ? { category: input.category } : {}), ...(period ? { period } : {}), sections }
}
