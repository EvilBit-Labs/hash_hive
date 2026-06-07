import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

// Port + proxy target both read from env so the same config drives
// regular `just dev` (3000 → 4000) AND the Playwright E2E suite, which
// runs on a distinct port lane (3400 → 4400) so it can coexist with a
// running dev backend instead of silently colliding on 4000.
function parsePort(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`${name} must be an integer in [1, 65535]; got ${JSON.stringify(raw)}`)
  }
  return n
}

const DEV_FRONTEND_PORT = parsePort(process.env['PORT'], 3000, 'PORT')
const DEV_BACKEND_PROXY_TARGET = process.env['VITE_API_PROXY_TARGET'] ?? 'http://localhost:4000'

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: DEV_FRONTEND_PORT,
    proxy: {
      '/api': {
        target: DEV_BACKEND_PROXY_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
})
