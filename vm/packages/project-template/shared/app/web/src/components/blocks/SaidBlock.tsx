// A reading: what the composer wrote for a typed question, as prose, then the blocks its script wrote beside it
// (drawn by the same renderers a capability's blocks use), and what it stands on — the calls it made, as chips. A prose block is never a state: no controls, no next moves, no lens; a person moves on from the block
// above it.

import { useMemo } from 'react'
import { Icon } from '@iconify/react'
import { Section } from '@/components/ui/Section'
import { markdownToHtml } from '@/lib/markdown'
import type { Said, SaidBlock } from '@/lib/wire'
import type { Beat } from '@/runtime/thread'
import { BeatsDisclosure } from './Beats'
import { BlockView } from '@/components/blocks'

/** The markdown split at its marker lines: prose pieces and, between them, the block each marker names. */
function pieces(said: Said): Array<{ html: string } | { block: SaidBlock }> {
  const byMarker = new Map(said.blocks.map((b) => [b.marker, b]))
  const out: Array<{ html: string } | { block: SaidBlock }> = []
  let buf: string[] = []
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push({ html: markdownToHtml(t) }); buf = [] }
  for (const line of said.markdown.split('\n')) {
    if (/^\s*:::period\s/.test(line)) continue   // the time the answer covers is drawn on its own line (periodsOf)
    const b = byMarker.get(line.trim())
    if (b) { flush(); out.push({ block: b }) } else buf.push(line)
  }
  flush()
  return out
}

/** The time the answer covers, from its `:::period <when> · <what kind>` lines. */
function periodsOf(markdown: string): Array<{ label: string; detail?: string }> {
  const out: Array<{ label: string; detail?: string }> = []
  for (const line of markdown.split('\n')) {
    const m = /^\s*:::period\s+(.+?)\s*$/.exec(line); if (!m) continue
    const [label, ...rest] = m[1].split(/\s+·\s+/)
    out.push({ label: label.trim(), ...(rest.length ? { detail: rest.join(' · ').trim() } : {}) })
  }
  return out
}

export default function SaidBlock({ said, beats }: { said: Said; beats: Beat[] }) {
  const ended = beats.length ? beats[beats.length - 1].at + 1000 : 0
  const parts = useMemo(() => pieces(said), [said])
  const periods = useMemo(() => periodsOf(said.markdown), [said])
  const prose = parts.filter((p): p is { html: string } => 'html' in p)
  const footer = said.calls.length ? (
    <>
      <span className="sa-label">What this stands on</span>
      {said.calls.map((c) => (
        <span key={c.id || c.canonical} className="sa-pill sa-call" data-state={c.refused ? 'warning' : c.error ? 'critical' : undefined}
          title={`${c.canonical}${c.ms ? ` · ${c.ms} ms` : ''}${c.refused ? ` · refused: ${c.refused}` : ''}${c.error ? ` · error: ${c.error}` : ''}`}>
          {c.refused ? <Icon icon="lucide:ban" /> : c.error ? <Icon icon="lucide:alert-triangle" /> : <Icon icon="lucide:check" />}
          <span className="sa-call__text">{c.canonical || c.id}</span>
          {c.ms > 0 && <span className="sa-call__ms">{c.ms} ms</span>}
        </span>
      ))}
    </>
  ) : undefined
  // The answer is one section: the prose, with what it stands on. Each block the markdown names is its own section,
  // drawn by the renderer a capability's block of that kind uses, in the order the markdown places them.
  return (<>
    <Section icon="lucide:message-square-text" accent="neutral" title="Answer" note={`${(said.ms / 1000).toFixed(1)} s`} footer={footer}>
      {said.agent && (
        <p className="sa-note sa-section__body"><span className="sa-label">Answered by</span>{' '}<b>{said.agent.name}</b>
          {said.agent.how === 'routed' ? ` — picked from the question${said.agent.terms.length ? ` (${said.agent.terms.join(', ')})` : ''}` : ' — this thread’s agent'}</p>
      )}
      {periods.length > 0 && (
        <p className="sa-note sa-section__body"><span className="sa-label">Period</span>{' '}
          {periods.map((p, i) => <span key={i}>{i > 0 && '  ·  '}<b>{p.label}</b>{p.detail ? ` — ${p.detail}` : ''}</span>)}</p>
      )}
      {prose.map((p, i) => <div key={i} className="sa-prose sa-section__body" dangerouslySetInnerHTML={{ __html: p.html }} />)}
    </Section>
    {parts.map((p, i) => 'block' in p
      ? p.block.block
        ? <BlockView key={i} block={p.block.block} />
        : <Section key={i} icon="lucide:circle-help" accent="neutral" title={p.block.marker}><p className="sa-note sa-section__empty">The data for this part could not be read{p.block.error ? ` (${p.block.error})` : ''}.</p></Section>
      : null)}
    <BeatsDisclosure beats={beats} end={ended} />
  </>)
}
