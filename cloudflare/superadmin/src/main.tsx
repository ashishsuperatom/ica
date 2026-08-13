import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/react'
import { App } from './App.js'

const PUBLISHABLE_KEY = 'pk_test_YXB0LWFsaWVuLTIxLmNsZXJrLmFjY291bnRzLmRldiQ'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY}>
      <App />
    </ClerkProvider>
  </StrictMode>
)
