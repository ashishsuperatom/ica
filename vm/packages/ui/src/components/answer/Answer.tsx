// THE ANSWER COMPONENT — the one way the platform draws an answer, wherever it appears: markdown, split at its marker
// lines into its text and the cards they name, drawn in the order written (answer/cards.ts, the contract: a card is rows;
// a program's own cards — `:::kpis summary` — carry their type); the period the answer covers on its own line; who answered; what it stands on (its calls); and, kept
// under a quiet line, how it was worked out (the narrator's beats). Prose is never a state: it has no controls.

import { useMemo, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { Section } from '../ui/Section'
import { markdownToHtml } from '../../lib/markdown'
import { readBlock, type Beat, type Block } from '../../answer/blocks'
import { readCard, type Card } from '../../answer/cards'
import { CardView } from './CardView'
import { BeatsDisclosure } from '../blocks/Beats'
import { BlockView, type BlockCallbacks } from '../blocks'

/** A part of an answer by its kind, in words (never its marker line or file name). */
const partName = (marker: string) => { const k = /^:::(\w+)/.exec(marker.trim())?.[1] ?? ''; return ['bar', 'bars', 'line'].includes(k) ? 'A chart' : k === 'table' ? 'A table' : k === 'kpis' ? 'Key figures' : 'A part of the answer' }

export interface AnswerCall { id: string; canonical: string; ms: number; refused?: string; error?: string }
export interface AnswerProps extends BlockCallbacks {
  markdown: string
  /** The data each marker names: by the marker's name (`trips.json`) or its whole line. Read into blocks, never trusted. */
  blocks?: Record<string, unknown> | Array<{ marker: string; block: unknown; error?: string }>
  agent?: { name: string; how?: string; terms?: string[] } | null
  calls?: AnswerCall[]
  ms?: number
  beats?: Beat[]
  title?: string
  /** Shown under the prose (the answer's own controls, never a block's). */
  footer?: ReactNode
}

const MARKER = /^\s*:::(\w[\w-]*)\s+(\S+)\s*$/

/** The markdown split into prose and the blocks its markers name, in order. */
type Part = { html: string } | { marker: string; card?: Card; block: Block | null; error?: string }
const isCard = (v: unknown): v is Card => !!v && typeof v === 'object' && (v as any).kind === 'table' && !('type' in (v as object))
export function answerParts(markdown: string, blocks: AnswerProps['blocks']): Part[] {
  const byName = new Map<string, { data: unknown; error?: string }>()
  if (Array.isArray(blocks)) for (const b of blocks) byName.set(b.marker.trim(), { data: b.block, error: b.error })
  else for (const [k, v] of Object.entries(blocks ?? {})) byName.set(k, { data: v })
  const out: Part[] = []
  let buf: string[] = []
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ html: markdownToHtml(t) }); buf = [] }
  for (const line of String(markdown ?? '').split('\n')) {
    if (/^\s*:::period\s/.test(line)) continue
    const m = MARKER.exec(line)
    if (!m) { buf.push(line); continue }
    flush()
    const found = byName.get(line.trim()) ?? byName.get(m[2])
    const data = found?.data
    // a card as the engine read it; a program's own card (its type); else read here by the contract (a program's carried file)
    if (isCard(data)) { out.push({ marker: line.trim(), card: data, block: null }); continue }
    if (data && typeof data === 'object' && !(data as any).type && ['table', 'bar', 'line', 'pie', 'chart'].includes(m[1])) {
      const r = readCard(m[1], data)
      out.push('card' in r ? { marker: line.trim(), card: r.card, block: null } : { marker: line.trim(), block: null, error: r.problems.join('; ') }); continue
    }
    const block = data && typeof data === 'object' ? readBlock((data as any).type ? data : { type: m[1], ...(data as object) }) : null
    out.push({ marker: line.trim(), block, ...(found?.error ? { error: found.error } : {}) })
  }
  flush()
  return out
}

/** The time an answer covers, from its `:::period <when> · <what kind>` lines. */
export function periodsOf(markdown: string): Array<{ label: string; detail?: string }> {
  const out: Array<{ label: string; detail?: string }> = []
  for (const line of String(markdown ?? '').split('\n')) {
    const m = /^\s*:::period\s+(.+?)\s*$/.exec(line); if (!m) continue
    const [label, ...rest] = m[1].split(/\s+·\s+/)
    out.push({ label: label.trim(), ...(rest.length ? { detail: rest.join(' · ').trim() } : {}) })
  }
  return out
}

/** The answer's words: a plain card, or a titled section when the caller gives a title. */
function Body({ title, ms, footer, children }: { title?: string; ms?: number; footer?: ReactNode; children: ReactNode }) {
  if (title) return <Section icon="lucide:message-square-text" accent="neutral" title={title} note={ms ? `${(ms / 1000).toFixed(1)} s` : undefined} footer={footer}>{children}</Section>
  return (
    <section className="sa-card sa-section sa-answer">
      <div className="sa-section__content">{children}</div>
      {footer && <div data-copy="skip" className="sa-section__foot">{footer}</div>}
    </section>
  )
}

export default function Answer({ markdown, blocks, agent, calls = [], ms, beats = [], title, footer, ...cb }: AnswerProps) {
  const parts = useMemo(() => answerParts(markdown, blocks), [markdown, blocks])
  const periods = useMemo(() => periodsOf(markdown), [markdown])
  const ended = beats.length ? beats[beats.length - 1].at + 1000 : 0
  const standsOn = calls.length ? (<>
    <span className="sa-label">What this stands on</span>
    {calls.map((c) => (
      <span key={c.id || c.canonical} className="sa-pill sa-call" data-state={c.refused ? 'warning' : c.error ? 'critical' : undefined}
        title={`${c.canonical}${c.ms ? ` · ${c.ms} ms` : ''}${c.refused ? ` · refused: ${c.refused}` : ''}${c.error ? ` · error: ${c.error}` : ''}`}>
        {c.refused ? <Icon icon="lucide:ban" /> : c.error ? <Icon icon="lucide:alert-triangle" /> : <Icon icon="lucide:check" />}
        <span className="sa-call__text">{c.canonical || c.id}</span>
        {c.ms > 0 && <span className="sa-call__ms">{c.ms} ms</span>}
      </span>
    ))}
  </>) : undefined
  // text and cards one after another, as written; who answered and the time it covers always first — with the text when
  // the answer opens with text, else on their own above the first card
  const firstText = 'html' in (parts[0] ?? {}) ? 0 : -1
  const head = (agent || periods.length > 0) ? (<>
    {agent && (
      <p className="sa-note sa-section__body"><span className="sa-label">Answered by</span>{' '}<b>{agent.name}</b>
        {agent.how === 'routed' ? ` — picked from the question${agent.terms?.length ? ` (${agent.terms.join(', ')})` : ''}` : ''}</p>
    )}
    {periods.length > 0 && (
      <p className="sa-note sa-section__body"><span className="sa-label">Period</span>{' '}
        {periods.map((p, i) => <span key={i}>{i > 0 && '  ·  '}<b>{p.label}</b>{p.detail ? ` — ${p.detail}` : ''}</span>)}</p>
    )}
  </>) : null
  return (<>
    {firstText < 0 && head && <Body title={title} ms={ms} footer={standsOn}>{head}{footer}</Body>}
    {parts.map((p, i) => 'html' in p
      // The step above is already the answer: its words need no heading of their own — unless the caller names one.
      ? <Body key={i} title={i === firstText ? title : undefined} ms={i === firstText ? ms : undefined} footer={i === firstText ? standsOn : undefined}>
          {i === firstText && head}
          <div className="sa-prose sa-section__body" dangerouslySetInnerHTML={{ __html: p.html }} />
          {i === firstText && footer}
        </Body>
      : p.card ? <CardView key={i} card={p.card} />
      : p.block ? <BlockView key={i} block={p.block} {...cb} />
      : <Section key={i} icon="lucide:circle-help" accent="neutral" title={partName(p.marker)}><p className="sa-note sa-section__empty">This part of the answer could not be shown. Ask again to have it drawn.</p></Section>)}
    <BeatsDisclosure beats={beats} end={ended} />
  </>)
}
