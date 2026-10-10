// The screen before a person is in: the name, one line on what this is, and the sign-in (or what is happening) under
// it, centred in the window. Every app's sign-in looks the same and takes the design system's type and colours.
import type { ReactNode } from 'react'
import { PageHeader } from '../semantic'

export default function SignInFrame({ title = 'Superatom', subtitle, children }: { title?: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sa-signin">
      <div className="sa-stack sa-stack--4">
        <PageHeader title={title} subtitle={subtitle} />
        {children}
      </div>
    </div>
  )
}
