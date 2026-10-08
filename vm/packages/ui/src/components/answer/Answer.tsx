// THE ANSWER COMPONENT — the one way the platform draws an answer, wherever it appears: markdown, split at its marker
// lines (`:::table trips.json`, `:::kpis summary`), each marker drawn as the block it names by the same renderers every
// block uses; the period the answer covers on its own line; who answered; what it stands on (its calls); and, kept
// under a quiet line, how it was worked out (the narrator's beats). Prose is never a state: it has no controls.

import { useMemo, type ReactNode } from 'react'
import { Icon } from '../ui/Icon'
import { Section } from '../ui/Section'
import { markdownToHtml } from '../../lib/markdown'
import { readBlock, type Beat, type Block } from '../../answer/blocks'
import { BeatsDisclosure } from '../blocks/Beats'
import { BlockView, type BlockCallbacks } from '../blocks'

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
export function answerParts(markdown: string, blocks: AnswerProps['blocks']): Array<{ html: string } | { marker: string; block: Block | null; error?: string }> {
  const byName = new Map<string, { data: unknown; error?: string }>()
  if (Array.isArray(blocks)) for (const b of blocks) byName.set(b.marker.trim(), { data: b.block, error: b.error })
  else for (const [k, v] of Object.entries(blocks ?? {})) byName.set(k, { data: v })
  const out: Array<{ html: string } | { marker: string; block: Block | null; error?: string }> = []
  let buf: string[] = []
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ html: markdownToHtml(t) }); buf = [] }
  for (const line of String(markdown ?? '').split('\n')) {
    if (/^\s*:::period\s/.test(line)) continue
    const m = MARKER.exec(line)
    if (!m) { buf.push(line); continue }
    flush()
    const found = byName.get(line.trim()) ?? byName.get(m[2])
    const data = found?.data
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

export default function Answer({ markdown, blocks, agent, calls = [], ms, beats = [], title = 'Answer', footer, ...cb }: AnswerProps) {
  const parts = useMemo(() => answerParts(markdown, blocks), [markdown, blocks])
  const periods = useMemo(() => periodsOf(markdown), [markdown])
  const prose = parts.filter((p): p is { html: string } => 'html' in p)
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
  return (<>
    {(prose.length > 0 || agent || periods.length > 0) && (
      <Section icon="lucide:message-square-text" accent="neutral" title={title} note={ms ? `${(ms / 1000).toFixed(1)} s` : undefined} footer={standsOn}>
        {agent && (
          <p className="sa-note sa-section__body"><span className="sa-label">Answered by</span>{' '}<b>{agent.name}</b>
            {agent.how === 'routed' ? ` — picked from the question${agent.terms?.length ? ` (${agent.terms.join(', ')})` : ''}` : ''}</p>
        )}
        {periods.length > 0 && (
          <p className="sa-note sa-section__body"><span className="sa-label">Period</span>{' '}
            {periods.map((p, i) => <span key={i}>{i > 0 && '  ·  '}<b>{p.label}</b>{p.detail ? ` — ${p.detail}` : ''}</span>)}</p>
        )}
        {prose.map((p, i) => <div key={i} className="sa-prose sa-section__body" dangerouslySetInnerHTML={{ __html: p.html }} />)}
        {footer}
      </Section>
    )}
    {parts.map((p, i) => 'html' in p ? null
      : p.block ? <BlockView key={i} block={p.block} {...cb} />
      : <Section key={i} icon="lucide:circle-help" accent="neutral" title={p.marker}><p className="sa-note sa-section__empty">The data for this part could not be read{p.error ? ` (${p.error})` : ''}.</p></Section>)}
    <BeatsDisclosure beats={beats} end={ended} />
  </>)
}
