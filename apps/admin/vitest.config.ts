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
      // SvelteKit's virtual $app/* modules are not available without the kit
      // vite plugin — stub the ones our components import (base path, page store).
      '$app/paths': fileURLToPath(new URL('./src/lib/test/app-paths.mock.ts', import.meta.url)),
      '$app/stores': fileURLToPath(new URL('./src/lib/test/app-stores.mock.ts', import.meta.url)),
      '$app/navigation': fileURLToPath(
        new URL('./src/lib/test/app-navigation.mock.ts', import.meta.url),
      ),
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
