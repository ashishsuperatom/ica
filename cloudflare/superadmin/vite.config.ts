import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Admin SPA only. The worker is bundled by `wrangler deploy` (main = src/worker.ts),
// not by a vite plugin — so we control exactly where each SPA's files land. Admin is
// served under /admin/ (base + router basename); user-ui builds into dist/client/u.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: { outDir: 'dist/client/admin', emptyOutDir: true },
})
