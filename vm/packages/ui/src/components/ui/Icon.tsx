// THE ICON — every icon the design system shows. Icons are fetched when first shown, so until one arrives its place is
// held: a square of the size it will have (its width and height, else 1em, and whatever its class gives it), empty, so
// nothing beside it moves when it comes.

import { Icon as Iconify, type IconProps } from '@iconify/react'

export function Icon(props: IconProps) {
  const { className, width, height, style, fallback } = props
  const w = width ?? height ?? '1em', h = height ?? width ?? '1em'
  return <Iconify {...props} fallback={fallback ?? <span aria-hidden className={className} style={{ display: 'inline-block', flexShrink: 0, width: w, height: h, ...(style as object) }} />} />
}
