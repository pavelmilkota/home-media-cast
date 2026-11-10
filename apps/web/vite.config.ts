import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    // Use the shared package's source so dev and tests work without building it first.
    alias: {
      '@home-media-cast/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
  // Generous: the app-level specs render the whole shell and run beside the API's 55 workers in `pnpm test`.
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setup-tests.ts'],
    testTimeout: 20_000,
  },
});
