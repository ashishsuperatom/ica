// THE ANSWER COMPONENT — the one way the platform draws an answer, wherever it appears: markdown, split at its marker
// lines into its text and the cards they name, drawn in the order written (answer/cards.ts, the contract: a card is rows;
// a program's own cards — `:::kpis summary` — carry their type). DRAWN TO BE READ, like a reply, not a dashboard: its
// words on the page (no box), its tables plain and its charts quiet — each opened to work with (CardView reading) — and,
// in one quiet line under it, the period it covers, who answered and where (`about`), beside how it was worked out (the
// narrator's beats). Prose is never a state: it has no controls.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSeen, SeenContext } from '../../lib/inview'
import { Icon } from '../ui/Icon'
import { Section } from '../ui/Section'
import { markdownToHtml } from '../../lib/markdown'
import { readBlock, type Beat, type Block } from '../../answer/blocks'
import { readCard, markerOf, type Card } from '../../answer/cards'
import { CardView } from './CardView'
import { chartKind } from '../../answer/chart'
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
  /** Told once the arrival has begun: the page lets the answer go from its arrivals (drawn again, it is simply there). */
  onArrived?: () => void
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

export default function Answer({ markdown, blocks, agent, calls = [], ms, beats = [], title, footer, arriving = false, onArrived, about, ...cb }: AnswerProps) {
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
  const took = beats.length ? Math.max(1, Math.round((ended - beats[0].at) / 1000)) : ms ? Math.max(1, Math.round(ms / 1000)) : null
  // JUST COME: it unfolds part by part — each paragraph and heading in turn, a table's head then its rows one by one (the
  // total last), a chart drawn in, the line under it last. Every part holds its place from the start: nothing jumps.
  const delays = useMemo(() => { let t = 0; return parts.map((p) => { const d = t; t += 'html' in p ? 140 * Math.max(1, (p.html.match(/<(p|h[1-6]|ul|ol|table|blockquote|pre)\b/g) ?? []).length) + 60 : p.card ? (chartKind(p.card.hint) ? 650 : 260 + 70 * Math.min(p.card.rows.length, 8)) : 300; return { d, end: t } }) }, [parts])
  // Once it began unfolding it goes on, however long the reader takes to scroll to the rest (a later redraw never stops it).
  const [unfolding] = useState(arriving)
  useEffect(() => { if (unfolding) onArrived?.() }, [])   // eslint-disable-line react-hooks/exhaustive-deps
  // ONE CLOCK FOR THE ANSWER: each part, when it comes into view, takes the next free moment after the part before it has
  // finished — top to bottom, whenever the reader scrolls (parts seen together still come one after another).
  const clock = useRef(0)
  const reveal = (i: number, node: ReactNode, whole = false) => (unfolding ? <RevealPart key={i} index={i} clock={clock} lasts={Math.max(200, delays[i].end - delays[i].d)} whole={whole}>{node}</RevealPart> : node)
  const footDelay = delays.length ? delays[delays.length - 1].end : 0
  delays[parts.length] = { d: footDelay, end: footDelay + 300 }
  return (<div style={{ display: 'contents' }}>
    {parts.map((p, i) => reveal(i, 'html' in p
      ? <Body key={i} title={i === firstText ? title : undefined} ms={i === firstText ? ms : undefined} footer={i === firstText ? standsOn : undefined}>
          <div className="sa-prose sa-prose--read" dangerouslySetInnerHTML={{ __html: p.html }} />
          {i === firstText && footer}
        </Body>
      : p.card ? <CardView key={i} card={p.card} reading />
      : p.block ? <BlockView key={i} block={p.block} {...cb} />
      : <Section key={i} icon="lucide:circle-help" accent="neutral" title={partName(p.marker)}><p className="sa-note sa-section__empty">This part of the answer could not be shown. Ask again to have it drawn.</p></Section>,
      !('html' in p) && !(p.card && !chartKind(p.card.hint))))}
    {firstText < 0 && (footer || standsOn) && <Body footer={standsOn}>{footer}</Body>}
    {reveal(parts.length, <AnswerFoot periods={periods} took={took} below={(agent || about || beats.length) ? <>
      {(agent || about) && <p className="sa-answer-foot__about">{agent && <span>Answered by {agent.name}</span>}{about && <span>{about}</span>}</p>}
      <BeatsDisclosure beats={beats} end={ended} time={false} />
    </> : null} />, true)}
  </div>)
}

/** A part of an answer just come: it unfolds when it is on screen, in its turn — after the part before it (the answer's
 *  clock); one below the window waits, holding its place, and unfolds when it is scrolled to, after a short pause so it is
 *  seen unfolding. */
const SCROLLED_TO = 300
function RevealPart({ index, clock, lasts, whole, children }: { index: number; clock: { current: number }; lasts: number; whole: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const born = useRef(Date.now())
  const seen = useSeen(ref)
  const [d, setD] = useState<number | null>(null)
  useEffect(() => {
    if (!seen || d !== null) return
    const now = Date.now(), late = now - born.current > 500
    const start = Math.max(now + (late ? SCROLLED_TO : 0), clock.current || now)
    clock.current = start + lasts
    setD(start - now)
  }, [seen])   // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={ref} data-part={index} className={`sa-reveal${whole ? ' sa-reveal--whole' : ''}`} data-wait={d === null ? true : undefined} style={{ ['--d' as any]: `${d ?? 0}ms` }}><SeenContext.Provider value={d !== null}>{children}</SeenContext.Provider></div>
}

/** UNDER AN ANSWER, ON ONE LINE: the time it covers on the left, how long it took on the right. The line is a toggle: what
 *  is below it — where it was answered (its intent), how it was worked out — shows on a click and goes on the next. */
function AnswerFoot({ periods, took, below }: { periods: { label: string; detail?: string }[]; took: number | null; below: ReactNode }) {
  const [open, setOpen] = useState(false)
  if (!periods.length && took === null && !below) return null
  const row = <>
    <span className="sa-answer-foot__when">{periods.map((p, i) => <span key={i}>{p.label}{p.detail ? ` · ${p.detail}` : ''}</span>)}</span>
    {took !== null && <span className="sa-answer-foot__took">{took} s</span>}
  </>
  return (
    <div className="sa-answer-foot" data-copy="skip" data-open={open || undefined}>
      {below ? <button type="button" className="sa-answer-foot__row" aria-expanded={open} onClick={() => setOpen(!open)}>{row}</button> : <div className="sa-answer-foot__row">{row}</div>}
      {open && below && <div className="sa-answer-foot__below">{below}</div>}
    </div>
  )
}
