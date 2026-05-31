// Test-only stub for SvelteKit's virtual `$app/stores` module (aliased in the
// standalone admin vitest config). Provides a minimal `page` store so layout/
// page components that read `$page.url.pathname` render under jsdom.
import { readable } from 'svelte/store';

export const page = readable({ url: new URL('http://localhost/') });
export const navigating = readable(null);
export const updated = readable(false);
