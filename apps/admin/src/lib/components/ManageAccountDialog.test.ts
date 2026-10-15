import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { expect, it, vi } from 'vitest';
import ManageAccountDialog from './ManageAccountDialog.svelte';
const api = vi.hoisted(() => ({
  getAccountTimezone: vi.fn(async () => ({
    override: null,
    effective: 'America/New_York',
    source: 'ipapi.is',
    checkedAt: 1,
  })),
  setAccountTimezone: vi.fn(async () => {}),
}));
vi.mock('$lib/api/oauth.js', () => ({
  ...api,
  getAccountModels: async () => ({
    available: [],
    enabled: [],
    modelsMode: 'auto',
    canPull: false,
  }),
  getAccountProxy: async () => null,
  getAccountSchedule: async () => ({ priority: 50, schedulable: true }),
  setAccountModels: vi.fn(),
  setAccountProxy: vi.fn(),
  setAccountSchedule: vi.fn(),
}));
it('shows detected timezone, saves manual override and clears to automatic', async () => {
  render(ManageAccountDialog, {
    providerId: 'xai',
    providerName: 'Grok',
    account: 'work',
    onsaved: vi.fn(),
    onclose: vi.fn(),
  });
  await fireEvent.click(screen.getByRole('tab', { name: 'Timezone' }));
  await waitFor(() => expect(screen.getByText(/America\/New_York/)).toBeInTheDocument());
  const field = screen.getByLabelText('Timezone override');
  await fireEvent.input(field, { target: { value: 'America/Los_Angeles' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(api.setAccountTimezone).toHaveBeenLastCalledWith('xai', 'work', 'America/Los_Angeles'),
  );
  await fireEvent.input(field, { target: { value: '' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.setAccountTimezone).toHaveBeenLastCalledWith('xai', 'work', null));
});
