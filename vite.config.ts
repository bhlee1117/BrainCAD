import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

// `base` is set for GitHub Pages project-site hosting
// (https://bhlee1117.github.io/BrainCAD/). Override with BRAINCAD_BASE=/ for
// root-domain or Netlify deploys.
const base = process.env.BRAINCAD_BASE ?? '/BrainCAD/'

export default defineConfig({
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    // Atlas assets are pre-compressed binaries; don't inline them.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
