// THE ANSWER LINTER — the platform's checks on every answer the composer gives, before anyone reads it. Each check finds
// one common issue and says, in a sentence, what the composer is to put right; one that can be put right without the
// composer also says how (its fix). The session seam runs them: an answer with problems goes back to the composer once,
// with every problem said; what is still wrong after that is fixed where a check can fix it, and told to the operators.
//
// A check is generic — about how any answer is given, never about one domain's data.

import type { SaidBlock } from './answer-card.js'

export interface Answered { markdown: string; blocks: SaidBlock[] }
export interface Check {
  id: string
  /** What the composer is told to put right, or null: nothing wrong. */
  find(a: Answered): string | null
  /** The answer put right without the composer, where it can be. */
  fix?(a: Answered): Answered
}

/** The lines outside fenced code: code is shown as written. */
const fenced = (lines: string[]) => { let inside = false; return lines.map((l) => { if (/^\s*```/.test(l)) { inside = !inside; return true } return inside }) }
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l)
const isRule = (l: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)

/** The markdown tables in an answer: where each starts and ends (a header row, its rule, its rows). */
function tablesIn(markdown: string): { from: number; to: number }[] {
  const lines = markdown.split('\n'), code = fenced(lines), out: { from: number; to: number }[] = []
  for (let i = 0; i + 1 < lines.length; i++) {
    if (code[i] || !isRow(lines[i]) || !isRule(lines[i + 1])) continue
    let j = i + 2
    while (j < lines.length && !code[j] && isRow(lines[j])) j++
    out.push({ from: i, to: j })
    i = j - 1
  }
  return out
}

/** Data the answer shows is a table block (`:::table <name>`), drawn by the platform — never a table written in markdown. */
const markdownTable: Check = {
  id: 'markdown-table',
  find: (a) => tablesIn(a.markdown).length
    ? 'It writes data as a markdown table. Write the data to a file the way your answer rules say, and show it with its `:::table <name>.json` line; the words say what it shows.'
    : null,
  fix: (a) => {
    const lines = a.markdown.split('\n'), blocks = [...a.blocks], taken = new Set(blocks.map((b) => b.marker))
    let n = 0
    const name = () => { let m: string; do m = `table-${++n}`; while (taken.has(m)); taken.add(m); return m }
    for (const t of tablesIn(a.markdown).reverse()) {
      const head = cells(lines[t.from])
      const columns = head.map((label, k) => ({ key: `c${k + 1}`, label: label.replace(/\*\*/g, '') || `Column ${k + 1}` }))
      const rows = lines.slice(t.from + 2, t.to).map((l) => Object.fromEntries(cells(l).slice(0, columns.length).map((v, k) => [`c${k + 1}`, v.replace(/\*\*/g, '')])))
      const marker = name()
      blocks.push({ marker, block: { type: 'table', title: '', columns, rows } } as SaidBlock)
      lines.splice(t.from, t.to - t.from, `:::table ${marker}`)
    }
    return { markdown: lines.join('\n'), blocks }
  },
}

export const CHECKS: Check[] = [markdownTable]

/** What is wrong with an answer: each check that found something, with what the composer is told. */
export function lint(a: Answered, checks = CHECKS): { check: string; says: string }[] {
  return checks.flatMap((c) => { const says = c.find(a); return says ? [{ check: c.id, says }] : [] })
}

/** The answer with what can be fixed fixed, and which checks fixed it; what no check can fix stays as it is. */
export function fixed(a: Answered, checks = CHECKS): Answered & { fixed: string[] } {
  let out = a
  const done: string[] = []
  for (const c of checks) if (c.fix && c.find(out)) { out = c.fix(out); done.push(c.id) }
  return { ...out, fixed: done }
}
