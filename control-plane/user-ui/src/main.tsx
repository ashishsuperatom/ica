import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import { CLERK_DEVELOPMENT_KEY, CLERK_PRODUCTION_KEY } from '../../shared/clerk'
import { CloudGate } from './App.js'
// The design system's styles from the first screen — the sign-in too (Workspace, which imported them, loads after it).
import '@superatom/ui/design.css'

// The user app is served behind the platform (/u, or a project's own subdomain): a person signs in (Clerk) and reaches
// their project through the hub — never an engine directly.
// Production on the platform, the development instance on a local dev server (shared/clerk.ts).
const PUBLISHABLE_KEY = import.meta.env.DEV ? CLERK_DEVELOPMENT_KEY : CLERK_PRODUCTION_KEY

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/"><CloudGate /></ClerkProvider>
  </StrictMode>
)
