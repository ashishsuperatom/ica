// How a set of figures is drawn — as a table or as a picture — is the reader's choice, not the page's. Two buttons,
// always: the table, then the picture; further formats live behind the picture (click it again to choose). The
// choice says nothing about the data, so it lives in this browser (lib/remember), never on the server.
//
// Accessibility: the pair is a radio group — one is checked, Tab lands on it, arrows move between them, each is
// named. Choosing a format is a menu, opened from the picture button, closed on Escape or a click elsewhere.

import { useEffect, useRef, useState } from 'react'
import { Icon } from '@iconify/react'
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
