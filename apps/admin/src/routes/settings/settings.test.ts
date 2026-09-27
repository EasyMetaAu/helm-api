import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { RuntimeSettings } from '$lib/api/settings.js';
import SettingsPage from './+page.svelte';

vi.mock('$lib/api/cleanup.js', () => ({
  archiveDownloadUrl: vi.fn(),
  getCleanupStatus: vi.fn(() => Promise.resolve({ lastRun: null, archives: [] })),
  runCleanupNow: vi.fn(),
  vacuumDatabase: vi.fn(),
}));

vi.mock('$lib/api/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/api/settings.js')>();
  return { ...actual, saveSettings: vi.fn() };
});

describe('settings default lane options', () => {
  it('offers only configured lanes without hard-coding balanced', () => {
    render(SettingsPage, {
      data: {
        settings: { default_lane: 'premium' } as RuntimeSettings,
        lanes: ['economy', 'premium'],
      },
    });

    const select = screen.getByTestId('default-lane') as HTMLSelectElement;
    expect(Array.from(select.options, (option) => option.value)).toEqual(['economy', 'premium']);
    expect(select.value).toBe('premium');
  });
});

describe('settings navigation and labels', () => {
  const data = {
    settings: { default_lane: 'balanced' } as RuntimeSettings,
    lanes: ['balanced'],
  };

  it('offers an in-page section index linking to every group', () => {
    render(SettingsPage, { data });
    const nav = screen.getByRole('navigation', { name: /settings sections/i });
    const hrefs = Array.from(nav.querySelectorAll('a'), (a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['#traffic', '#observability', '#retention', '#maintenance']);
    for (const href of hrefs) {
      expect(document.querySelector(href ?? '')).not.toBeNull();
    }
  });

  it('gives the key-queue and account-queue timeouts distinct labels', () => {
    render(SettingsPage, { data });
    expect(screen.getByText('Key queue wait timeout (ms)')).toBeInTheDocument();
    expect(screen.getByText('Account queue wait timeout (ms)')).toBeInTheDocument();
    expect(screen.queryByText('Queue wait timeout (ms)')).toBeNull();
  });
});
