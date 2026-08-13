import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import { App, CloudGate } from './App.js'

// Cloud mode (served at /u behind the worker hub) requires login via Clerk.
// Local dev (VITE_HUB_URL unset) talks straight to the code-engine, no auth.
const HUB = import.meta.env.VITE_HUB_URL as string | undefined
const PUBLISHABLE_KEY = 'pk_test_YXB0LWFsaWVuLTIxLmNsZXJrLmFjY291bnRzLmRldiQ'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {HUB
      ? <ClerkProvider publishableKey={PUBLISHABLE_KEY}><CloudGate /></ClerkProvider>
      : <App />}
  </StrictMode>
)
