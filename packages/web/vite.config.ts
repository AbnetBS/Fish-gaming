import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * The dev server proxies /api and /ws to the Fastify backend so the browser
 * only ever talks to one origin. That keeps cookies, CORS and CSP simple, and
 * means the same relative URLs work in production where the API serves the
 * built client directly.
 */
const API_TARGET = process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT_WEB ?? 5173),
    strictPort: false,
    allowedHosts: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true, ws: false },
      '/ws': { target: API_TARGET, ws: true, changeOrigin: true },
    },
  },
  preview: { host: '0.0.0.0', port: 4173, allowedHosts: true },
  test: {
    // Client tests target pure logic (motion maths, particle bounds, formatters),
    // so they run in plain Node without a DOM.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          engine: ['./src/game/Engine.ts', './src/game/Renderer.ts'],
        },
      },
    },
  },
});
