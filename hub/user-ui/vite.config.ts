import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev (`vite`): served at / on :5174, talks straight to the local code-engine (no hub).
// Build (`vite build`): served at /u behind the worker hub; assets emitted into the
// superadmin worker's asset dir so one worker serves both SPAs.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/u/' : '/',
  define: command === 'build'
    ? { 'import.meta.env.VITE_HUB_URL': JSON.stringify('wss://superatom.site') }
    : {},
  build: { outDir: '../superadmin/dist/client/u', emptyOutDir: true },
  server: {
    port: 5174,
    // /api → a worker. Default local wrangler; set VITE_API_PROXY=https://superatom.site to
    // run the UI locally against the DEPLOYED hub+auth (no local worker needed).
    proxy: { '/api': { target: process.env.VITE_API_PROXY || 'http://localhost:8787', changeOrigin: true, secure: true } },
  },
}))
