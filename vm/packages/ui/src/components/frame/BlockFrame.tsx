// One step of a thread: a slim header — its step badge, what it is, what opened it (linking to that step) — with its
// tools (copy, collapse, remove) shown on hover, then the step's own content. The whole header opens and closes it.
// Nothing here knows what a step shows: the caller gives the words and the content.

import { useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { useArrange } from './arrange'
import { notify } from '../../lib/toast'
import { CopyContext, HeaderContext, type CopyText, type Header } from './header'
import { blockToText } from './copy'

export interface FrameProps {
  /** Where Arrange keeps this block's card order (default: its kind and title). */
  arrangeScope?: string
  id: string
  step: number
  /** The step's colour (a token's value or a var()). */
  accent?: string
  /** What kind of step it is, shown small above the title when the title says something else. */
  label?: string
  title: ReactNode
  /** Why it was opened, in words ("Selected Retail in the worklist"), and the step that opened it. */
  cause?: string
  from?: { id: string; step: number; onPath: boolean }
  subtitle?: ReactNode
  /** Working: a spinner in the badge before it has anything to show, beside the title after. */
  busy?: boolean
  icon?: string
  onReveal?: (id: string) => void
  onRemove?: () => void
  /** Text for the clipboard before the content (the question in words). */
  words?: string
  children: ReactNode
}

export default function BlockFrame(p: FrameProps) {
  const [header, setHeader] = useState<Header>({})
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const copyFn = useRef<CopyText | null>(null)
  const title = header.title ?? p.title
  const label = p.label ?? ''
  const copy = async () => {
    try {
      const name = titleRef.current?.innerText.trim() || label || `Step ${p.step}`
      const heading = label && name !== label ? `${label}: ${name} (step ${p.step})` : `${name} (step ${p.step})`
      const words = p.words ? `${heading}\n${p.words}` : heading
      const text = copyFn.current ? `${words}\n\n${await copyFn.current()}` : content.current ? blockToText(content.current, words) : words
      await navigator.clipboard.writeText(text)
      setCopied(true); setTimeout(() => setCopied(false), 1500)
      notify(`${name} copied`, 'note')
    } catch (err) { notify(`Could not copy: ${err instanceof Error ? err.message : String(err)}`, 'error') }
  }
  // Working shows ONE sign: before the step has anything to show, the badge spins (and the step's own skeleton fills
  // it); once it has content and is being changed in place, the badge keeps its icon and a spinner sits by the title.
  const empty = !content.current?.textContent?.trim()
  const toggle = () => setCollapsed(!collapsed)
  // Its cards can be arranged (Arrange, at the bottom of the page): kept per kind of block and its title.
  useArrange(content, p.arrangeScope ?? `block:${label}:${typeof p.title === 'string' ? p.title : ''}`)
  return (
    <article id={`block-${p.id}`} className="sa-block" data-block={p.id}>
      <header role="button" tabIndex={0} aria-expanded={!collapsed} onClick={toggle}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), toggle())}
        className="sa-block__head" title={collapsed ? 'Open this step' : 'Collapse this step'}>
        <span className="sa-badge" style={{ background: p.accent ?? 'var(--series-1)' }} title={`Step ${p.step}`}>
          {p.busy && empty ? <span className="sa-spinner" aria-label="Working" /> : p.icon ? <Icon icon={p.icon} /> : p.step}
        </span>
        <div className="sa-block__heading">
          <div className="sa-block__title-row">
            {label && title !== label && <span className="sa-label sa-block__kind">{label}</span>}
            <h2 ref={titleRef} className="sa-block__title" title={typeof title === 'string' ? title : undefined}>{title}</h2>
            {p.busy && !empty && <span className="sa-spinner sa-faint" aria-label="Working" />}
          </div>
          <div className="sa-block__subtitle" title={p.cause ?? (typeof (header.subtitle ?? p.subtitle) === 'string' ? String(header.subtitle ?? p.subtitle) : undefined)}>
            {p.cause && p.from ? (<>
              {p.cause}{' '}
              <button className="sa-block__link" onClick={(e) => { e.stopPropagation(); p.from?.onPath && p.onReveal?.(p.from.id) }} disabled={!p.from.onPath}>
                (step {p.from.step}{p.from.onPath ? '' : ', not on this path'})
              </button>
            </>) : (header.subtitle ?? p.subtitle)}
            {p.cause && (header.subtitle ?? p.subtitle) && <> · {header.subtitle ?? p.subtitle}</>}
          </div>
        </div>
        <div className="sa-block__end" onClick={(e) => e.stopPropagation()}>
          {!collapsed && header.actions && <span className="sa-block__actions">{header.actions}</span>}
          <span className="sa-block__tools" data-shown={copied}>
            <button className="sa-icon-btn" onClick={copy} title="Copy as text" aria-label="Copy as text">
              <Icon icon={copied ? 'lucide:check' : 'lucide:copy'} style={copied ? { color: 'var(--win)' } : undefined} />
            </button>
            <button className="sa-icon-btn sa-icon-btn--rotate" data-collapsed={collapsed} onClick={toggle} title={collapsed ? 'Open' : 'Collapse'} aria-label={collapsed ? 'Open' : 'Collapse'}><Icon icon="lucide:chevron-down" /></button>
            {p.onRemove && <button className="sa-icon-btn" onClick={p.onRemove} title="Remove from the thread" aria-label="Remove from the thread"><Icon icon="lucide:x" /></button>}
          </span>
        </div>
      </header>
      <HeaderContext.Provider value={setHeader}>
        <CopyContext.Provider value={(fn) => (copyFn.current = fn)}>
          <div ref={content} className="sa-block__body" hidden={collapsed}>{p.children}</div>
        </CopyContext.Provider>
      </HeaderContext.Provider>
    </article>
  )
}
