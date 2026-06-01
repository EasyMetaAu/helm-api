// Test-only stub for SvelteKit's virtual `$app/navigation` module (aliased in the
// standalone admin vitest config). The requests list navigates on row click via
// `goto`; tests import this same `goto` (a vi.fn) to assert the target route.
import { vi } from 'vitest';

export const goto = vi.fn();
export const invalidate = vi.fn();
export const invalidateAll = vi.fn();
