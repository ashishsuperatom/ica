import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

const TRANSPORT = '{{PLATFORM}}/clients/transport.ts'
// The platform's one UI framework: the design system, the frames, the answer component and its blocks.
const UI = '{{PLATFORM}}/vm/packages/ui/src'

// base './' — the built app is hosted under a sub-path, so every asset is addressed relative to index.html.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/(.*)$/, replacement: path.resolve(__dirname, './src') + '/$1' },
      // The links to the platform repo: the transport (shared by both ends of the wire) and the UI framework.
      { find: '@superatom/transport', replacement: TRANSPORT },
      { find: '@superatom/ui/design.css', replacement: `${UI}/design/index.css` },
      { find: /^@superatom\/ui$/, replacement: `${UI}/index.ts` },
    ],
    // One copy of each library for the app and the framework (it lives outside this folder).
    dedupe: ['react', 'react-dom', '@iconify/react', 'echarts', 'echarts-for-react', 'marked'],
  },
  server: { port: 5173 },
  test: { environment: 'node', include: ['src/test/**/*.test.ts', 'src/test/**/*.test.tsx'] },
})
