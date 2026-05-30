import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vitest/config';

// Admin lives outside the node-only root vitest project (it imports `.svelte`
// and needs a DOM). This config gives component/page tests the Svelte compiler
// + jsdom + @testing-library setup, and is wired into the repo-wide `pnpm test`
// via `test.projects` in the root vitest.config.ts.
export default defineConfig({
  plugins: [svelte(), svelteTesting()],
  resolve: {
    alias: {
      // SvelteKit normally injects $lib; the standalone test config must too.
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
    },
  },
  test: {
    name: 'admin',
    include: ['src/**/*.test.ts'],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
  },
});
