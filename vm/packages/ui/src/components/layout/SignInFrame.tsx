// The screen before a person is in: the sign-in (or what is happening) centred in the window, with a heading only when
// one is given — the sign-in card names itself. Every app's sign-in looks the same and takes the design system's look.
import type { ReactNode } from 'react'
import { PageHeader } from '../semantic'

export default function SignInFrame({ title, subtitle, children }: { title?: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sa-signin">
      <div className="sa-stack sa-stack--4">
        {title && <PageHeader title={title} subtitle={subtitle} />}
        {children}
      </div>
    </div>
  )
}
