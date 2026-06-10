import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// All API calls go through FastAPI
const API = 'http://localhost:8000'

export default defineConfig({
  root: '.',
  // Absolute base so asset URLs (`/assets/...`) resolve correctly under
  // nested routes like `/play/<code>`. With `./` the browser would resolve
  // them against the current path, yielding `/play/assets/...` → 404.
  base: '/',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: [
      '0.0.0.0',
    ],
    proxy: {
      '/auth': { target: API, changeOrigin: true },
      '/chat': { target: API, changeOrigin: true },
      '/game': { target: API, changeOrigin: true },
      '/leaderboard': { target: API, changeOrigin: true },
      '/multiplayer': { target: API, changeOrigin: true },
      '/social': { target: API, changeOrigin: true },
      '/user': { target: API, changeOrigin: true },
      '/health': { target: API, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    css: true,
    // Unit tests live under src/. Keep vitest out of the e2e suites:
    // cypress/ (*.cy.ts) and e2e-pw/ (Playwright *.spec.ts, which throws
    // if imported outside the Playwright runner).
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
