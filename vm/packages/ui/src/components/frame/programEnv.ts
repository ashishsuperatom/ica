// What a program's view may reach besides its STATE: the surface's request to the platform (the project's hub), for
// reads a control needs while it is open — the members a filter can take, the description of the views. Changes still go
// through intents only.

import { createContext, useContext, type ReactNode } from 'react'

export interface ProgramEnv {
  request: (payload: Record<string, unknown>) => Promise<any>
  /** A file an answer gives (a `file` block), downloaded through the person's door; absent where the surface has none. */
  download?: (file: { session: string; hash: string; name: string }) => Promise<void>
  /** An image given with a question, to show: a URL for it (read through the person's door), or null. */
  preview?: (file: { session: string; hash: string; name: string }) => Promise<string | null>
  /** Something to connect, as the surface draws it (a connection's own sign-in, a connector's form); absent where it has none. */
  connect?: (target: string) => ReactNode
}
export const ProgramEnvContext = createContext<ProgramEnv | null>(null)
/** Inside a program's view: the surface's request, or null where the surface gives none (a test, a static page). */
export const useProgramEnv = (): ProgramEnv | null => useContext(ProgramEnvContext)
