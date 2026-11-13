import { useState } from 'react'
import { defineViews, view } from '@superatom/ui'

export function UnsettledTrips(props: { count: number }) {
  const [open, setOpen] = useState(false)
  return <section onClick={() => setOpen(!open)}>{props.count} unsettled trips{open ? ' (open)' : ''}</section>
}

export const views = defineViews({
  UnsettledTrips: view(UnsettledTrips, { doc: 'How many trips are left to settle', reads: ['count'] }),
})
