// One block in the thread: a slim header — step, what it is, what opened it — and its controls (copy, collapse,
// remove), then the block's own content. The whole header opens and closes the block.

import { useRef, useState, type ReactNode } from 'react'
import { Icon } from '@iconify/react'
import { revealBlock, useThread, type Node } from '@/runtime/thread'
import { capabilityOf, useApp } from '@/lib/catalog'
import { notify } from '@/lib/toast'
import { ACCENT, type Accent } from '@/design'
import { CopyContext, HeaderContext, type CopyText, type Header } from './header'
import { blockToText } from './copy'


export default function BlockFrame({ block, children }: { block: Node; children: ReactNode }) {
  const { catalog } = useApp()
  const { remove, blocks } = useThread()
  const [header, setHeader] = useState<Header>({})
  const [collapsed, setCollapsed] = useState(false)
  const [copied, setCopied] = useState(false)
  const content = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const copyFn = useRef<CopyText | null>(null)
  const from = block.from && blocks.find((b) => b.id === block.from!.id)
  const cap = capabilityOf(catalog, block.question.focus)
  const isAbout = block.about || block.question.focus === 'about'
  const isSaid = block.kind === 'said'
  const label = isSaid ? 'Reader' : isAbout ? 'About' : cap?.label ?? block.question.focus
  const title = header.title ?? (isSaid ? block.said?.text ?? block.placeholder : block.answer?.title ?? block.placeholder) ?? label
  const accent = ACCENT[isSaid || isAbout ? 'neutral' : ((catalog.scenarios.find((s) => s.key === cap?.scenario)?.accent ?? 'series-1') as Accent)]
  const asking = block.busy && !block.answer && !block.about && !block.said

  const copy = async () => {
    try {
      const name = titleRef.current?.innerText.trim() || label
      const heading = name === label ? `${label} (step ${block.step})` : `${label}: ${name} (step ${block.step})`
      const words = block.answer?.words ? `${heading}\n${block.answer.words}` : heading
      const text = copyFn.current ? `${words}\n\n${await copyFn.current()}` : content.current ? blockToText(content.current, words) : words
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      notify(`${name} copied`, 'note')
    } catch (err) {
      notify(`Could not copy: ${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  return (
    <article id={`block-${block.id}`} className="sa-block">
      <header
        role="button" tabIndex={0} aria-expanded={!collapsed}
        onClick={() => setCollapsed(!collapsed)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && (e.preventDefault(), setCollapsed(!collapsed))}
        className="sa-block__head" title={collapsed ? 'Open this step' : 'Collapse this step'}
      >
        <span className="sa-badge" style={{ background: accent }} title={isSaid ? `Step ${block.step} · a reading` : `Step ${block.step}`}>{asking ? <span className="sa-spinner" /> : isSaid ? <Icon icon="lucide:book-open-text" /> : block.step}</span>
        <div className="sa-block__heading">
          <div className="sa-block__title-row">
            {title !== label && <span className="sa-label sa-block__kind" title={isSaid ? 'Prose from the reader: it stands on the calls it lists, and a person moves on from the block above it' : undefined}>{label}</span>}
            <h2 ref={titleRef} className="sa-block__title" title={typeof title === 'string' ? title : undefined}>{title}</h2>
            {block.busy && !asking && <span className="sa-spinner sa-faint" aria-label="Working" />}
            {block.earlier && <span className="sa-label sa-block__kind" title="Shown from earlier this session while the question is asked again">from earlier · {new Date(block.earlier).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}</span>}
          </div>
          <div className="sa-block__subtitle" title={block.cause ?? (typeof header.subtitle === 'string' ? header.subtitle : block.answer?.said ?? cap?.whenToUse)}>
            {block.cause && block.from ? (
              <>
                {block.cause}{' '}
                <button className="sa-block__link" onClick={(e) => { e.stopPropagation(); block.from && revealBlock(block.from.id) }} disabled={!from}>
                  (step {block.from.step}{from ? '' : ', not on this path'})
                </button>
              </>
            ) : (
              header.subtitle ?? block.answer?.said ?? cap?.whenToUse
            )}
            {block.cause && header.subtitle && <> · {header.subtitle}</>}
          </div>
        </div>
        <div className="sa-block__end" onClick={(e) => e.stopPropagation()}>
          {!collapsed && header.actions && <span className="sa-block__actions">{header.actions}</span>}
          <span className="sa-block__tools" data-shown={copied}>
            <button className="sa-icon-btn" onClick={copy} title="Copy as text" aria-label="Copy as text">
              <Icon icon={copied ? 'lucide:check' : 'lucide:copy'} style={copied ? { color: 'var(--win)' } : undefined} />
            </button>
            <button className="sa-icon-btn sa-icon-btn--rotate" data-collapsed={collapsed} onClick={() => setCollapsed(!collapsed)} title={collapsed ? 'Open' : 'Collapse'} aria-label={collapsed ? 'Open' : 'Collapse'}>
              <Icon icon="lucide:chevron-down" />
            </button>
            {block.parentId && (
              <button className="sa-icon-btn" onClick={() => remove(block.id)} title="Remove from the thread" aria-label="Remove from the thread"><Icon icon="lucide:x" /></button>
            )}
          </span>
        </div>
      </header>
      <HeaderContext.Provider value={setHeader}>
        <CopyContext.Provider value={(fn) => (copyFn.current = fn)}>
          <div ref={content} className="sa-block__body" hidden={collapsed}>{children}</div>
        </CopyContext.Provider>
      </HeaderContext.Provider>
    </article>
  )
}
