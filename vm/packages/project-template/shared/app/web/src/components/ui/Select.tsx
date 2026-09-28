// The one dropdown in the app: searchable, and a proper combobox for anyone not using a mouse (slob's Select).
//
// ARIA combobox pattern: the trigger is role="combobox" with aria-expanded and aria-controls; the list is a
// role="listbox" of role="option" with aria-selected; the active option is named by aria-activedescendant.
// Keyboard: Enter/Space/↓ opens, ↑↓ moves, Home/End jumps, typing filters, Enter picks, Esc closes and returns focus.
// Added here: `onQuery` (options that come from elsewhere as the person types), `loading`, `autoOpen`.

import { forwardRef, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '@iconify/react'

export interface Option {
  value: string
  label: string
  /** Quiet second line in the list. */
  note?: ReactNode
}

interface Props {
  label: string
  value: string
  onChange: (value: string) => void
  options: Option[]
  /** Shown as the first option; picking it sets "". */
  emptyLabel?: string
  placeholder?: string
  /** Let the user keep what they typed. */
  allowCustom?: boolean
  /** How the trigger reads: a field in a form, a chip among filters, or a cell in a table. */
  variant?: 'field' | 'chip' | 'cell'
  disabled?: boolean
  className?: string
  /** Rendered inside the trigger before the value, e.g. an icon. */
  lead?: ReactNode
  /** Options that come from elsewhere as the person types (a member search): told what was typed, debounced. */
  onQuery?: (q: string) => void
  /** Those options are on their way. */
  loading?: boolean
  /** Open as soon as it is drawn (the second step of a two-step choice). */
  autoOpen?: boolean
  /** A modifier of the choice, in the popover's head above the search box (is / is not). */
  head?: ReactNode
}

/** An acronym stays an acronym in the search line: "Find a CFA", not "Find a cfa". */
const spoken = (label: string) => (label === label.toUpperCase() ? label : label.toLowerCase())

export default function Select({ label, value, onChange, options, emptyLabel, placeholder = 'Select', allowCustom, variant = 'field', disabled, className = '', lead, onQuery, loading, autoOpen, head }: Props) {
  const id = useId()
  const [open, setOpen] = useState(false)
  useEffect(() => { if (autoOpen) setOpen(true) }, [autoOpen])
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const items = useMemo(() => {
    const base = emptyLabel !== undefined ? [{ value: '', label: emptyLabel }, ...options] : options
    const term = q.trim().toLowerCase()
    return term && !onQuery ? base.filter((o) => o.label.toLowerCase().includes(term) || (typeof o.note === 'string' && o.note.toLowerCase().includes(term))) : base
  }, [options, emptyLabel, q, onQuery])

  const current = options.find((o) => o.value === value)
  const chosenEmpty = !value && emptyLabel !== undefined
  const shown = current?.label ?? (value || (chosenEmpty && variant === 'field' ? emptyLabel : ''))

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      const t = e.target as Node
      if (root.current?.contains(t) || list.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  // What was typed goes to whoever supplies the options, a moment after the typing pauses.
  useEffect(() => {
    if (!open || !onQuery) return
    const t = setTimeout(() => onQuery(q), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open])

  useEffect(() => {
    if (open) {
      setQ('')
      setActive(Math.max(0, items.findIndex((o) => o.value === value)))
      setTimeout(() => search.current?.focus(), 0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => { listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus() }
  const pick = (v: string) => { onChange(v); close() }

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((i) => Math.min(i + 1, items.length - 1)))
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((i) => Math.max(i - 1, 0)))
    else if (e.key === 'Home') (e.preventDefault(), setActive(0))
    else if (e.key === 'End') (e.preventDefault(), setActive(items.length - 1))
    else if (e.key === 'Enter') {
      e.preventDefault()
      if (items[active]) pick(items[active].value)
      else if (allowCustom && q.trim()) pick(q.trim())
    } else if (e.key === 'Escape') (e.preventDefault(), close())
    else if (e.key === 'Tab') close(false)
  }

  const chip = variant === 'chip'
  const cell = variant === 'cell'
  const triggerClass = chip ? `sa-combobox sa-combobox--chip ${className}` : cell ? `sa-combobox sa-combobox--cell ${className}` : `sa-input sa-combobox ${className}`

  return (
    <div className="sa-select" ref={root}>
      <button
        ref={trigger} type="button" id={`${id}-trigger`} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-haspopup="listbox"
        aria-label={`${label}${shown ? `: ${shown}` : ''}`} disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) (e.preventDefault(), setOpen(true)) }}
        className={triggerClass} data-set={chip && !!value}
      >
        {lead && <span className="sa-combobox__lead">{lead}</span>}
        {chip && <span className="sa-combobox__label">{label}</span>}
        <span className={`sa-combobox__value${shown ? '' : ' sa-combobox__value--empty'}`} title={shown || undefined}>{shown || placeholder}</span>
        <Icon icon="lucide:chevron-down" className="sa-combobox__caret" />
      </button>

      {open &&
        createPortal(
          <Popover ref={list} anchor={root.current} onClose={() => close(false)}>
            {head && <div className="sa-popover__head" onMouseDown={(e) => e.preventDefault()}>{head}</div>}
            <div className="sa-popover__search">
              <Icon icon="lucide:search" />
              <input
                ref={search} value={q} onChange={(e) => { setQ(e.target.value); setActive(0) }} onKeyDown={onListKey}
                role="searchbox" aria-label={`Find ${spoken(label)}`} aria-controls={`${id}-list`} aria-activedescendant={items[active] ? `${id}-opt-${active}` : undefined}
                placeholder={allowCustom ? 'Search or type…' : 'Search…'} className="sa-popover__input" title={allowCustom ? `Find or type a ${spoken(label)}` : `Find a ${spoken(label)}`}
              />
            </div>
            <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={label} className="sa-listbox sa-scroll">
              {items.length === 0 && (
                <li className="sa-listbox__empty" title={loading ? 'Searching…' : allowCustom ? `Press Enter to use “${q.trim()}”` : `Nothing matches “${q.trim()}”`}>{loading ? 'Searching…' : allowCustom ? `Press Enter to use “${q.trim()}”` : `Nothing matches “${q.trim()}”`}</li>
              )}
              {items.map((o, i) => {
                const selected = o.value === value
                return (
                  <li key={o.value || '__empty'} id={`${id}-opt-${i}`} role="option" aria-selected={selected} data-active={i === active}>
                    <button type="button" tabIndex={-1} onMouseEnter={() => setActive(i)} onClick={() => pick(o.value)} className={`sa-option${selected ? ' sa-option--selected' : ''}`} data-active={i === active}>
                      <span className="sa-option__check" aria-hidden>{selected && <Icon icon="lucide:check" />}</span>
                      <span className="sa-option__body">
                        <span className="sa-option__label" title={o.label}>{o.label}</span>
                        {o.note && <span className="sa-option__note">{o.note}</span>}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </Popover>,
          document.body,
        )}
    </div>
  )
}

/**
 * The list, placed under its trigger and kept on screen. It follows the field while the page scrolls rather than
 * closing, and ignores scrolling inside itself.
 */
export const Popover = forwardRef<HTMLDivElement, { anchor: HTMLElement | null; onClose: () => void; children: ReactNode }>(function Popover({ anchor, onClose, children }, ref) {
  const [box, setBox] = useState<DOMRect | null>(() => anchor?.getBoundingClientRect() ?? null)
  const self = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let frame = 0
    const follow = (e?: Event) => {
      if (e && self.current?.contains(e.target as Node)) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const rect = anchor?.getBoundingClientRect()
        if (!rect) return
        if (rect.bottom < 0 || rect.top > window.innerHeight) onClose()
        else setBox(rect)
      })
    }
    window.addEventListener('scroll', follow, true)
    window.addEventListener('resize', follow)
    return () => { cancelAnimationFrame(frame); window.removeEventListener('scroll', follow, true); window.removeEventListener('resize', follow) }
  }, [anchor, onClose])

  if (!box) return null
  const width = Math.max(box.width, 280)
  const below = window.innerHeight - box.bottom
  const flip = below < 260 && box.top > below
  return (
    <div
      ref={(node) => { self.current = node; if (typeof ref === 'function') ref(node); else if (ref) ref.current = node }}
      className="sa-popover"
      style={{ left: Math.min(Math.max(8, box.left), window.innerWidth - width - 8), top: flip ? undefined : box.bottom + 6, bottom: flip ? window.innerHeight - box.top + 6 : undefined, width, maxHeight: Math.max(200, (flip ? box.top : below) - 16) }}
    >
      {children}
    </div>
  )
})
