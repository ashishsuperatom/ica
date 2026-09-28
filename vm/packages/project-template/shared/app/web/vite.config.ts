import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const TRANSPORT = '{{PLATFORM}}/clients/transport.ts'

// base './' — the built app is hosted under a sub-path, so every asset is addressed relative to index.html.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // The one link to the platform repo: the transport (parts and parcels) is shared by both ends of the wire.
      '@superatom/transport': TRANSPORT,
    },
  },
  server: { port: 5173 },
  test: { environment: 'node', include: ['src/test/**/*.test.ts', 'src/test/**/*.test.tsx'] },
})
