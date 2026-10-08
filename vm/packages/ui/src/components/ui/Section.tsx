// The building blocks every block is made of, on the design system's primitives: the Section card (quiet head,
// hover-only view controls, a Settle body), the Kpi tile, the Skeleton, EmptyRows and the Pager.

import { type ReactNode } from 'react'
import { Icon } from './Icon'
import { ACCENT, type Accent } from '../../design/index'
import Settle from './Settle'

/**
 * A section card. `tinted` gives it the accent band with a solid icon tile (a primary section on a screen);
 * otherwise a quiet header strip with the note on the right (a supporting section).
 */
export function Section({ title, subtitle, note, icon, accent = 'series-1', tinted = false, soft = false, actions, hoverActions, children, footer, className = '' }: {
  title: ReactNode
  subtitle?: ReactNode
  note?: ReactNode
  icon: string
  accent?: Accent
  tinted?: boolean
  soft?: boolean
  actions?: ReactNode
  /** Controls for the view itself (how a chart is drawn): shown when the card is hovered. */
  hoverActions?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  const hover = hoverActions && <span className="sa-section__hover" data-copy="skip">{hoverActions}</span>
  const style = { '--accent': ACCENT[accent] } as React.CSSProperties
  return (
    <section className={`sa-card sa-section ${className}`} style={style}>
      {tinted ? (
        <div className="sa-section__head sa-section__head--tinted">
          <span className={`sa-section__tile${soft ? ' sa-section__tile--soft' : ''}`}><Icon icon={icon} /></span>
          <div className="sa-section__heading">
            <h2 className="sa-section__title">{title}</h2>
            {subtitle && <div className="sa-section__subtitle">{subtitle}</div>}
          </div>
          {note && <span className="sa-section__note">{note}</span>}
          {hover}
          {actions}
        </div>
      ) : (
        <div className="sa-section__head">
          <Icon icon={icon} className="sa-section__icon" />
          <h3 className="sa-section__title" title={typeof title === 'string' ? title : undefined}>{title}</h3>
          {subtitle && <span className="sa-section__subtitle" title={typeof subtitle === 'string' ? subtitle : undefined}>{subtitle}</span>}
          <span className="sa-section__end">
            {note && <span className="sa-section__note" title={typeof note === 'string' ? note : undefined}>{note}</span>}
            {hover}
            {actions}
          </span>
        </div>
      )}
      <Settle innerClassName="sa-section__content">{children}</Settle>
      {footer && <div data-copy="skip" className="sa-section__foot">{footer}</div>}
    </section>
  )
}

/** A headline figure: small uppercase label, the number in its meaning's color, and a footnote that explains it. */
export function Kpi({ label, value, foot, accent = 'series-1', loading, onClick }: { label: string; value: ReactNode; foot?: ReactNode; accent?: Accent; loading?: boolean; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div'
  const style = { '--accent': ACCENT[accent] } as React.CSSProperties
  return (
    <Tag data-copy="line" onClick={onClick} className={`sa-card sa-kpi${onClick ? ' sa-card--lift sa-kpi--click' : ''}`} style={style}>
      <div className="sa-label sa-kpi__label">
        <span className="sa-kpi__label-text" title={label}>{label}</span>
        {onClick && <Icon icon="mdi:arrow-right" />}
      </div>
      <div className="sa-kpi__value-row">
        {loading ? <Skeleton w={130} h={20} /> : <div className="sa-figure sa-key sa-kpi__value">{value}</div>}
      </div>
      <div className="sa-kpi__foot" title={typeof foot === 'string' ? foot : undefined}>{loading ? <Skeleton w="70%" h={10} /> : foot}</div>
    </Tag>
  )
}

export function Skeleton({ w = '100%', h = 12, className = '' }: { w?: number | string; h?: number; className?: string }) {
  return <div aria-hidden className={`sa-skeleton ${className}`} style={{ width: w, height: h }} />
}

/** What a table body shows while it loads, and when it has nothing. */
export function EmptyRows({ loading, text, cols, rows = 4 }: { loading: boolean; text: ReactNode; cols: number; rows?: number }) {
  if (!loading)
    return (
      <tr>
        <td colSpan={cols} className="c sa-faint" style={{ paddingTop: 28, paddingBottom: 28 }}>{text}</td>
      </tr>
    )
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}>
          <td className="l"><Skeleton w={160} h={11} /><Skeleton w={110} h={9} /></td>
          {Array.from({ length: cols - 1 }, (_, j) => (
            <td key={j}><Skeleton w={70} h={11} className="sa-skeleton--end" /></td>
          ))}
        </tr>
      ))}
    </>
  )
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = page * pageSize
  return (
    <div className="sa-pager" data-copy="skip">
      <span className="sa-pager__count">{total === 0 ? 'Nothing' : `${from + 1}–${Math.min(total, from + pageSize)} of ${total}`}</span>
      <div className="sa-pager__nav">
        <button className="sa-btn" disabled={page === 0} onClick={() => onPage(page - 1)}><Icon icon="lucide:chevron-left" className="sa-btn__icon" />Previous</button>
        <span className="sa-pager__page">{page + 1} / {pages}</span>
        <button className="sa-btn" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next<Icon icon="lucide:chevron-right" className="sa-btn__icon" /></button>
      </div>
    </div>
  )
}
