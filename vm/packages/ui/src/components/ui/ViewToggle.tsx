// How a set of figures is drawn — as a table or as a picture — is the reader's choice, not the page's. On a step the
// choice waits behind one quiet button (ViewMenu, through useOneView): the figures are drawn plainly first. The toggle
// pair (ViewToggle) is for the control plane's own pages. The choice says nothing about the data, so it lives in this
// browser (lib/remember), never on the server.
//
// Accessibility: the pair is a radio group — one is checked, Tab lands on it, arrows move between them, each is
// named. Choosing a format is a menu, opened from the picture button, closed on Escape or a click elsewhere.

import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { recall, remember } from '../../lib/remember'

/** The reader's choice for one named section, remembered across visits. */
export function useView<V extends string>(name: string, allowed: readonly V[], fallback: V) {
  const [view, setView] = useState<V>(() => {
    const saved = recall<V | null>(`view.${name}`, null)
    return saved && allowed.includes(saved) ? saved : fallback
  })
  useEffect(() => remember(`view.${name}`, view), [name, view])
  return [view, setView] as const
}

export interface ViewOption<V extends string> { value: V; icon: string; label: string }

/** The table, as every toggle offers it first. */
export const TABLE_VIEW: ViewOption<'table'> = { value: 'table', icon: 'lucide:table', label: 'Table' }

/** ONE VIEW AT A TIME, DRAWN PLAINLY — how every section with a chart is drawn on a step: it opens on its chart (the first
 *  picture), and the other ways to read the same figures (the table, a ring for parts of a whole) are NOT shown: a small
 *  quiet button at the end of its heading (ViewMenu) opens them, and choosing one converts the view in place. Never two
 *  views side by side. Display only, remembered per browser (rule 12). Returns the view in force and that button. */
export function useOneView<V extends string>(name: string, pictures: ViewOption<V>[]) {
  const [view, setView] = useView<V | 'table'>(name, ['table', ...pictures.map((p) => p.value)], pictures[0]?.value ?? 'table')
  const shown: V | 'table' = view === 'table' || pictures.some((p) => p.value === view) ? view : (pictures[0]?.value ?? 'table')
  const menu = <ViewMenu<V | 'table'> label="Show as" value={shown} onChange={setView} options={[...pictures, TABLE_VIEW]} />
  return [shown, menu] as const
}

/** The view options of a section, behind one quiet icon button: a menu of the ways to read it, the one in force ticked.
 *  Keyboard: Enter or Space opens, the arrows move, Escape closes and returns to the button. */
export function ViewMenu<V extends string>({ label, value, options, onChange }: { label: string; value: V; options: ViewOption<V>[]; onChange: (v: V) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && (setOpen(false), button.current?.focus())
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  useEffect(() => { if (open) box.current?.querySelector<HTMLButtonElement>('[aria-checked="true"], [role="menuitemradio"]')?.focus() }, [open])
  const move = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return
    e.preventDefault()
    const items = [...(box.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }
  if (options.length < 2) return null
  return (
    <span ref={box} className="sa-viewmenu">
      <button ref={button} type="button" className="sa-icon-btn sa-icon-btn--sm" aria-haspopup="menu" aria-expanded={open} aria-label={`${label}…`} title={`${label}…`} onClick={() => setOpen(!open)}>
        <Icon icon="lucide:ellipsis" aria-hidden />
      </button>
      {open && (
        <span role="menu" aria-label={label} className="sa-toggle__menu" onKeyDown={move}>
          {options.map((o) => (
            <button key={o.value} type="button" role="menuitemradio" aria-checked={o.value === value} onClick={() => (setOpen(false), onChange(o.value), button.current?.focus())} className="sa-toggle__item">
              <Icon icon={o.icon} aria-hidden />
              {o.label}
              {o.value === value && <Icon icon="lucide:check" className="sa-toggle__check" aria-hidden />}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

export default function ViewToggle<V extends string>({ name, label, value, options, onChange }: { name?: string; label: string; value: V; options: ViewOption<V>[]; onChange: (v: V) => void }) {
  const table = options.find((o) => o.value === ('table' as V)) ?? options[0]
  const visuals = options.filter((o) => o.value !== table.value)
  const onTable = value === table.value

  const [preferred, setPreferred] = useState<V>(() => {
    const saved = name ? recall<V | null>(`visual.${name}`, null) : null
    return visuals.find((v) => v.value === value)?.value ?? (saved && visuals.some((v) => v.value === saved) ? saved : visuals[0]?.value) ?? value
  })
  useEffect(() => {
    if (visuals.some((v) => v.value === value)) {
      setPreferred(value)
      if (name) remember(`visual.${name}`, value)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, name])
  const picture = visuals.find((v) => v.value === preferred) ?? visuals[0] ?? table

  const [menu, setMenu] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  const pictureButton = useRef<HTMLButtonElement>(null)
  const tableButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!menu) return
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setMenu(false)
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && (setMenu(false), pictureButton.current?.focus())
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', escape) }
  }, [menu])

  const arrows = (e: React.KeyboardEvent, to: 'table' | 'picture') => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return
    e.preventDefault()
    if (to === 'table') { onChange(table.value); tableButton.current?.focus() }
    else { onChange(picture.value); pictureButton.current?.focus() }
  }

  return (
    <span ref={box} className="sa-toggle-wrap">
      <span role="radiogroup" aria-label={label} className="sa-toggle">
        <button ref={tableButton} type="button" role="radio" aria-checked={onTable} aria-label={table.label} title={table.label} tabIndex={onTable ? 0 : -1}
          onClick={() => (setMenu(false), onChange(table.value))} onKeyDown={(e) => arrows(e, 'picture')} className="sa-toggle__btn" data-on={onTable}>
          <Icon icon={table.icon} aria-hidden />
        </button>
        {visuals.length > 0 && (
          <button ref={pictureButton} type="button" role="radio" aria-checked={!onTable}
            aria-haspopup={!onTable && visuals.length > 1 ? 'menu' : undefined} aria-expanded={!onTable && visuals.length > 1 ? menu : undefined}
            aria-label={onTable || visuals.length === 1 ? picture.label : `${picture.label} — choose another`}
            title={onTable || visuals.length === 1 ? picture.label : `${picture.label} · click again to change`}
            tabIndex={onTable ? -1 : 0} onClick={() => (onTable ? onChange(picture.value) : visuals.length > 1 && setMenu(!menu))} onKeyDown={(e) => arrows(e, 'table')}
            className="sa-toggle__btn" data-on={!onTable}>
            <Icon icon={picture.icon} aria-hidden />
            {visuals.length > 1 && <Icon icon="lucide:chevron-down" className="sa-toggle__caret" aria-hidden />}
          </button>
        )}
      </span>
      {menu && (
        <span role="menu" aria-label={label} className="sa-toggle__menu">
          {visuals.map((v) => (
            <button key={v.value} type="button" role="menuitemradio" aria-checked={v.value === value} onClick={() => (setMenu(false), onChange(v.value), pictureButton.current?.focus())} className="sa-toggle__item">
              <Icon icon={v.icon} aria-hidden />
              {v.label}
              {v.value === value && <Icon icon="lucide:check" className="sa-toggle__check" aria-hidden />}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}
