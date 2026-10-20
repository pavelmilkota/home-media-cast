import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// swc emits decorator metadata, which Nest's DI needs and esbuild does not provide.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  resolve: {
    // Test against the shared package's source so `pnpm test` works without building it first.
    alias: {
      '@home-media-cast/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: { include: ['src/**/*.spec.ts'] },
});
