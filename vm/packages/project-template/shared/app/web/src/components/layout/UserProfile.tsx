// Who is signed in: their name and email from the session, in the platform's profile.

import { UserProfile as Profile } from '@superatom/ui'
import { viewer } from '@/lib/session'
import { useApp } from '@/lib/catalog'

export default function UserProfile({ showName = false }: { showName?: boolean }) {
  const user = viewer()
  return <Profile name={user.name} email={user.email} context={useApp().catalog.project.name} showName={showName} />
}
