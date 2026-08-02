import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * The built app is served by the engine's own Node server, so the base is '/'
 * and output lands in ui/dist where that server looks for it.
 *
 * In dev, /api and /preview proxy through to the engine server — the preview
 * iframe must be same-origin with the app so the parent can call __seek on it
 * directly.
 */
export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5179,
    proxy: {
      '/api': 'http://127.0.0.1:5178',
      '/preview': 'http://127.0.0.1:5178',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
