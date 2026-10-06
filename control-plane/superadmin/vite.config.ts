import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// The platform's UI framework, from the vm workspace; one copy of each library for the console and the framework.
const vm = (p: string) => fileURLToPath(new URL(`../../vm/packages/${p}`, import.meta.url))

// Admin SPA only. The worker is bundled by `wrangler deploy` (main = src/worker.ts),
// not by a vite plugin — so we control exactly where each SPA's files land. Admin is
// served under /admin/ (base + router basename); user-ui builds into dist/client/u.
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  resolve: {
    alias: [
      { find: '@superatom/ui/design.css', replacement: vm('ui/src/design/index.css') },
      { find: /^@superatom\/ui$/, replacement: vm('ui/src/index.ts') },
      { find: '@superatom/platform-types', replacement: vm('platform-types/src/index.ts') },
    ],
    dedupe: ['react', 'react-dom', '@iconify/react', 'echarts', 'echarts-for-react', 'marked'],
  },
  build: { outDir: 'dist/client/admin', emptyOutDir: true },
  // Dev (`vite`, scripts/ui-dev.sh): the console on :5175 with hot reload against the live platform — its socket goes
  // to wss://superatom.site already; /api is forwarded there.
  server: { port: 5175, proxy: { '/api': { target: process.env.VITE_API_PROXY || 'https://superatom.site', changeOrigin: true, secure: true } } },
})
