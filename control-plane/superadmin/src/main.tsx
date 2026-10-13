import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import { CLERK_DEVELOPMENT_KEY, CLERK_PRODUCTION_KEY } from '../../shared/clerk'
import { App } from './App.js'
// The platform's design tokens (colours, type, radii) — the console's own names are bound to them (App.tsx CSS).
import '../../../vm/packages/ui/src/design/tokens.css'

// Production on the platform, the development instance on a local dev server (shared/clerk.ts).
const PUBLISHABLE_KEY = import.meta.env.DEV ? CLERK_DEVELOPMENT_KEY : CLERK_PRODUCTION_KEY

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <App />
    </ClerkProvider>
  </StrictMode>
)
