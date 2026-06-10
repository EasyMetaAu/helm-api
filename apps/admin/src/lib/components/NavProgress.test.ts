import { render, screen, waitFor } from '@testing-library/svelte';
import type { Writable } from 'svelte/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NavProgress from './NavProgress.svelte';

// The bar is a pure consumer of SvelteKit's `navigating` store: non-null while a
// navigation (and its page `load`, where the API call happens) runs, null when
// idle. Replace the virtual module with a writable store we drive by hand so we
// can assert the full show → fill → hide lifecycle deterministically.
vi.mock('$app/stores', async () => {
  const { writable } = await import('svelte/store');
  return {
    navigating: writable(null),
    page: writable({ url: new URL('http://localhost/') }),
  };
});

// Re-import the (now-mocked) store to drive it from the test. It is the very same
// instance the component subscribes to.
const { navigating } = (await import('$app/stores')) as unknown as {
  navigating: Writable<unknown>;
};

// Minimal Navigation-like object — the component only checks truthiness.
const startNav = () => navigating.set({ to: { url: new URL('http://localhost/keys') } });

const bar = () => screen.getByTestId('nav-progress');
const valueNow = () => Number(bar().getAttribute('aria-valuenow'));

describe('NavProgress', () => {
  beforeEach(() => {
    navigating.set(null);
  });

  it('stays hidden and at zero while no navigation is in progress', () => {
    render(NavProgress);
    expect(bar()).toHaveAttribute('aria-hidden', 'true');
    expect(valueNow()).toBe(0);
  });

  it('appears and reports forward progress the moment a navigation starts', async () => {
    render(NavProgress);
    startNav();
    await waitFor(() => {
      expect(bar()).toHaveAttribute('aria-hidden', 'false');
      expect(valueNow()).toBeGreaterThan(0);
    });
  });

  it('snaps to 100% and then hides once the navigation resolves', async () => {
    render(NavProgress);
    startNav();
    await waitFor(() => expect(bar()).toHaveAttribute('aria-hidden', 'false'));

    navigating.set(null);
    await waitFor(() => expect(valueNow()).toBe(100));
    await waitFor(() => expect(bar()).toHaveAttribute('aria-hidden', 'true'));
  });
});
