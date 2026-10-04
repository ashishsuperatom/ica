import { useState } from 'react'

export function UnsettledTrips(props: { count: number }) {
  const [open, setOpen] = useState(false)
  return <section onClick={() => setOpen(!open)}>{props.count} unsettled trips{open ? ' (open)' : ''}</section>
}
