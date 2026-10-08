// Choose several things from a long list, with groups that choose many at once, and an "all" choice that means none
// named (slob's MultiSelect). The same look as Select and the same keyboard habits, extended to many.
//
// WAI-ARIA: the trigger role="combobox"; the search box role="combobox" with aria-activedescendant; the list
// role="listbox" aria-multiselectable; groups role="group". Keys: ↓/Enter/Space open · ↑↓ move · Home/End · Enter
// toggles · typing filters · Esc closes · Tab closes. A polite live region says what each toggle did.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'
import { Popover } from './Select'

export interface MultiOption { value: string; label: string; note?: ReactNode; cells?: ReactNode[]; search?: string }
export interface MultiGroup { value: string; label: string; values: string[] }

interface Props {
  label: string
  noun: [string, string]
  value: string[]
  onChange: (v: string[]) => void
  options: MultiOption[]
  groups?: MultiGroup[]
  groupsLabel?: string
  allLabel: string
  columns?: Array<{ label: string; width: number }>
  disabled?: boolean
  /** As a chip among filters rather than a field. */
  variant?: 'field' | 'chip'
  /** The list opened: the caller starts a draft (lib/draft). */
  onOpen?: () => void
  /** The list closed, however it closed: the caller commits the draft, once, if it changed. */
  onClose?: () => void
}

type Row = { kind: 'all' } | { kind: 'group'; group: MultiGroup } | { kind: 'option'; option: MultiOption }

export default function MultiSelect({ label, noun, value, onChange, options, groups = [], groupsLabel = 'Groups', allLabel, columns = [], disabled, variant = 'field', onOpen, onClose }: Props) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [said, setSaid] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const listbox = useRef<HTMLDivElement>(null)
  const chosen = useMemo(() => new Set(value), [value])
  const count = (n: number) => `${n} ${n === 1 ? noun[0] : noun[1]}`

  const rows = useMemo<Row[]>(() => {
    const term = q.trim().toLowerCase()
    const hit = (s: string) => !term || s.toLowerCase().includes(term)
    return [
      ...(hit(allLabel) ? [{ kind: 'all' } as Row] : []),
      ...groups.filter((g) => hit(g.label)).map((group) => ({ kind: 'group', group }) as Row),
      ...options.filter((o) => hit(`${o.label} ${o.search ?? (typeof o.note === 'string' ? o.note : '')}`)).map((option) => ({ kind: 'option', option }) as Row),
    ]
  }, [q, options, groups, allLabel])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => { const t = e.target as Node; if (root.current?.contains(t) || list.current?.contains(t)) return; setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])
  // Open and close are told once each, whichever way they happen (a click, Escape, Tab, a click outside).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) onOpen?.()
    if (!open && wasOpen.current) onClose?.()
    wasOpen.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  useEffect(() => { if (open) { setQ(''); setActive(0); setTimeout(() => search.current?.focus(), 0) } }, [open])
  useEffect(() => { listbox.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) }, [active, open])

  const close = (focus = true) => { setOpen(false); if (focus) trigger.current?.focus() }

  const toggle = (row: Row) => {
    if (row.kind === 'all') { onChange([]); setSaid(`${allLabel} chosen`); return }
    if (row.kind === 'group') {
      const all = row.group.values.every((v) => chosen.has(v))
      const next = all ? value.filter((v) => !row.group.values.includes(v)) : [...new Set([...value, ...row.group.values])]
      onChange(next)
      setSaid(`${row.group.label} ${all ? 'removed' : 'added'} · ${count(next.length)} chosen`)
      return
    }
    const v = row.option.value
    const next = chosen.has(v) ? value.filter((x) => x !== v) : [...value, v]
    onChange(next)
    setSaid(`${row.option.label} ${chosen.has(v) ? 'removed' : 'added'} · ${next.length ? `${count(next.length)} chosen` : allLabel}`)
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') (e.preventDefault(), setActive((i) => Math.min(i + 1, rows.length - 1)))
    else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((i) => Math.max(i - 1, 0)))
    else if (e.key === 'Home') (e.preventDefault(), setActive(0))
    else if (e.key === 'End') (e.preventDefault(), setActive(rows.length - 1))
    else if (e.key === 'Enter') (e.preventDefault(), rows[active] && toggle(rows[active]))
    else if (e.key === 'Escape') (e.preventDefault(), close())
    else if (e.key === 'Tab') close(false)
  }

  const names = value.map((v) => options.find((o) => o.value === v)?.label ?? v)
  const summary = value.length === 0 ? allLabel : value.length === 1 ? names[0] : `${count(value.length)}: ${names.slice(0, 2).join(', ')}${value.length > 2 ? ` +${value.length - 2}` : ''}`
  const rowId = (i: number) => `${id}-row-${i}`
  const isChosen = (row: Row) => (row.kind === 'all' ? value.length === 0 : row.kind === 'group' ? row.group.values.length > 0 && row.group.values.every((v) => chosen.has(v)) : chosen.has(row.option.value))

  const renderRow = (row: Row, i: number) => {
    const selected = isChosen(row)
    const partly = row.kind === 'group' && !selected && row.group.values.some((v) => chosen.has(v))
    const text = row.kind === 'all' ? allLabel : row.kind === 'group' ? row.group.label : row.option.label
    return (
      <div key={row.kind === 'all' ? '__all' : row.kind === 'group' ? `g-${row.group.value}` : row.option.value} id={rowId(i)} role="option" aria-selected={selected} data-active={i === active}
        onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => toggle(row)} className="sa-option">
        <span aria-hidden className="sa-option__box" data-state={selected ? 'on' : partly ? 'part' : 'off'}>
          {selected ? <Icon icon="lucide:check" /> : partly ? <Icon icon="lucide:minus" /> : null}
        </span>
        <span className="sa-option__body">
          <span className="sa-option__line">
            <span className={`sa-option__label${selected ? ' sa-option__label--selected' : ''}`} title={text}>{text}</span>
            {row.kind === 'option' && row.option.cells?.map((cell, ci) => <span key={ci} className="sa-option__cell" style={{ width: columns[ci]?.width }}>{cell}</span>)}
          </span>
          {row.kind === 'group' && <span className="sa-option__note">{partly ? `${row.group.values.filter((v) => chosen.has(v)).length} of ${count(row.group.values.length)} chosen` : count(row.group.values.length)}</span>}
          {row.kind === 'option' && row.option.note && <span className="sa-option__note">{row.option.note}</span>}
        </span>
      </div>
    )
  }

  const indexed = rows.map((row, i) => ({ row, i }))
  const sections = [
    { heading: null as string | null, items: indexed.filter((x) => x.row.kind === 'all') },
    { heading: groupsLabel, items: indexed.filter((x) => x.row.kind === 'group') },
    { heading: noun[1].replace(/^./, (c) => c.toUpperCase()), items: indexed.filter((x) => x.row.kind === 'option') },
  ].filter((sec) => sec.items.length)

  return (
    <div className="sa-select" ref={root}>
      <button ref={trigger} type="button" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`} aria-label={`${label}: ${summary}`} disabled={disabled}
        onClick={() => !disabled && setOpen(!open)}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) (e.preventDefault(), setOpen(true)) }}
        className={variant === 'chip' ? 'sa-combobox sa-combobox--chip' : 'sa-input sa-combobox'} data-set={variant === 'chip' && value.length > 0}>
        {variant === 'chip' && <span className="sa-combobox__label">{label}</span>}
        <span className="sa-combobox__value" title={summary}>{summary}</span>
        <Icon icon="lucide:chevron-down" className="sa-combobox__caret" />
      </button>
      <span id={`${id}-help`} className="sr-only">Up and down arrows move through the list. Enter adds or removes the highlighted item. Type to filter. Escape closes.</span>
      <span aria-live="polite" className="sr-only">{said}</span>
      {open &&
        createPortal(
          <Popover ref={list} anchor={root.current} onClose={() => close(false)}>
            <div className="sa-popover__search">
              <Icon icon="lucide:search" />
              <input ref={search} value={q} onChange={(e) => (setQ(e.target.value), setActive(0))} onKeyDown={onKey} role="combobox" aria-expanded aria-autocomplete="list" aria-label={`Find ${noun[1]}`}
                aria-controls={`${id}-list`} aria-activedescendant={rows[active] ? rowId(active) : undefined} aria-describedby={`${id}-help`}
                placeholder={`${noun[1].replace(/^./, (c) => c.toUpperCase())}…`} title={`Find ${noun[1]} or a ${groupsLabel.toLowerCase().replace(/s$/, '')}`} className="sa-popover__input" />
            </div>
            <div ref={listbox} id={`${id}-list`} role="listbox" aria-multiselectable="true" aria-label={label} className="sa-listbox sa-scroll">
              {rows.length === 0 && <div className="sa-listbox__empty" title={`Nothing matches “${q.trim()}”`}>Nothing matches “{q.trim()}”</div>}
              {sections.map((sec) =>
                sec.heading ? (
                  <div key={sec.heading} role="group" aria-label={sec.heading}>
                    <div aria-hidden className="sa-label sa-listbox__group-head">
                      <span>{sec.heading}</span>
                      {sec.items[0]?.row.kind === 'option' && columns.map((c) => <span key={c.label} className="sa-listbox__col" style={{ width: c.width }}>{c.label}</span>)}
                    </div>
                    {sec.items.map(({ row, i }) => renderRow(row, i))}
                  </div>
                ) : (
                  sec.items.map(({ row, i }) => renderRow(row, i))
                ),
              )}
            </div>
            {value.length > 0 && (
              <div className="sa-popover__foot">
                <span className="sa-popover__foot-text" title={names.join(', ')}>{count(value.length)} chosen</span>
                <button type="button" className="sa-btn sa-btn--link" onMouseDown={(e) => e.preventDefault()} onClick={() => toggle({ kind: 'all' })}>Clear</button>
              </div>
            )}
          </Popover>,
          document.body,
        )}
    </div>
  )
}
