// THE ANSWER COMPONENT — the one way the platform draws an answer, wherever it appears: markdown, split at its marker
// lines into its text and the cards they name, drawn in the order written (answer/cards.ts, the contract: a card is rows;
// a program's own cards — `:::kpis summary` — carry their type). DRAWN TO BE READ, like a reply, not a dashboard: its
// words on the page (no box), its tables plain and its charts quiet — each opened to work with (CardView reading) — and,
// in one quiet line under it, the period it covers, who answered and where (`about`), beside how it was worked out (the
// narrator's beats). Prose is never a state: it has no controls.

import { useMemo, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { Section } from '../ui/Section'
import { markdownToHtml } from '../../lib/markdown'
import { readBlock, type Beat, type Block } from '../../answer/blocks'
import { readCard, markerOf, type Card } from '../../answer/cards'
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
  /** It has just come: its words and cards appear one after another. */
  arriving?: boolean
  /** Said in the quiet line under it, beside the period (where it was answered: its intent). */
  about?: ReactNode
}


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
    const marker = markerOf(line)
    if (!marker) { buf.push(line); continue }
    const m = [line, marker.kind, marker.name] as const
    flush()
    const found = byName.get(line.trim()) ?? byName.get(m[2])
    const data = found?.data
    // a card as the engine read it; a program's own card (its type); else read here by the contract (a program's carried file)
    if (isCard(data)) { out.push({ marker: line.trim(), card: data, block: null }); continue }
    if (data && typeof data === 'object' && !(data as any).type && marker.card) {
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

/** The answer's words: on the page, as a reply reads — or a titled section when the caller gives a title. */
function Body({ title, ms, footer, children }: { title?: string; ms?: number; footer?: ReactNode; children: ReactNode }) {
  if (title) return <Section icon="lucide:message-square-text" accent="neutral" title={title} note={ms ? `${(ms / 1000).toFixed(1)} s` : undefined} footer={footer}>{children}</Section>
  return <div className="sa-answer-doc">{children}{footer && <div data-copy="skip" className="sa-answer-doc__foot">{footer}</div>}</div>
}

export default function Answer({ markdown, blocks, agent, calls = [], ms, beats = [], title, footer, arriving = false, about, ...cb }: AnswerProps) {
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
  const firstText = parts.findIndex((p) => 'html' in p)
  // The quiet line under the answer: the time it covers, who answered, where — never above the answer.
  const meta = (periods.length > 0 || agent || about) ? (
    <p className="sa-answer-meta" data-copy="skip">
      {periods.map((p, i) => <span key={i}>{p.label}{p.detail ? ` · ${p.detail}` : ''}</span>)}
      {agent && <span>Answered by {agent.name}</span>}
      {about && <span>{about}</span>}
    </p>
  ) : null
  return (<div className={arriving ? 'sa-answer-arrive' : undefined} style={{ display: 'contents' }}>
    {parts.map((p, i) => 'html' in p
      ? <Body key={i} title={i === firstText ? title : undefined} ms={i === firstText ? ms : undefined} footer={i === firstText ? standsOn : undefined}>
          <div className="sa-prose sa-prose--read" dangerouslySetInnerHTML={{ __html: p.html }} />
          {i === firstText && footer}
        </Body>
      : p.card ? <CardView key={i} card={p.card} reading />
      : p.block ? <BlockView key={i} block={p.block} {...cb} />
      : <Section key={i} icon="lucide:circle-help" accent="neutral" title={partName(p.marker)}><p className="sa-note sa-section__empty">This part of the answer could not be shown. Ask again to have it drawn.</p></Section>)}
    {firstText < 0 && (footer || standsOn) && <Body footer={standsOn}>{footer}</Body>}
    {meta}
    <BeatsDisclosure beats={beats} end={ended} />
  </div>)
}
