import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import { CloudGate } from './App.js'

// The user app is served behind the platform (/u, or a project's own subdomain): a person signs in (Clerk) and reaches
// their project through the hub — never an engine directly.
const PUBLISHABLE_KEY = 'pk_test_YXB0LWFsaWVuLTIxLmNsZXJrLmFjY291bnRzLmRldiQ'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/"><CloudGate /></ClerkProvider>
  </StrictMode>
)
