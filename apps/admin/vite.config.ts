import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Tailwind v4 is wired through its first-party Vite plugin (no postcss.config /
// tailwind.config needed — the token + recipe layer lives in src/app.css via
// `@theme` and `@layer components`). The plugin MUST come before sveltekit().
export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
});
