// The Superatom mark, drawn as a vector so it is sharp at any size: a ring, its nucleus, and one electron on the ring.

export default function SuperatomMark({ size = 24, title = 'Superatom' }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label={title} className="sa-mark">
      <circle cx="12" cy="12" r="7.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="12" r="2.9" fill="currentColor" />
      <circle cx="17.35" cy="6.65" r="2.1" fill="currentColor" />
      <circle cx="17.35" cy="6.65" r="1.45" fill="var(--mark-ground, var(--surface))" />
      <circle cx="17.35" cy="6.65" r="1.05" fill="var(--brand-electron)" />
    </svg>
  )
}
