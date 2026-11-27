import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import ManagedProviders from './ManagedProviders.svelte';
afterEach(() => vi.unstubAllGlobals());
it('adds a Kimi API provider from the UI and clears the secret after save', async () => {
  const requests: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method) {
        requests.push(JSON.parse(String(init.body)));
        return Response.json({ saved: true });
      }
      return Response.json({ configured: true, providers: [], pools: [] });
    }),
  );
  render(ManagedProviders, { onOAuth: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
  await fireEvent.click(screen.getByRole('button', { name: 'API key' }));
  await fireEvent.change(screen.getByLabelText('Provider preset'), { target: { value: 'kimi' } });
  await fireEvent.input(screen.getByLabelText('API key'), {
    target: { value: 'vendor-private-key' },
  });
  await fireEvent.input(screen.getByLabelText('Model alias'), { target: { value: 'kimi/pro' } });
  await fireEvent.input(screen.getByLabelText('Upstream model ID'), {
    target: { value: 'k3.1-pro' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    provider: { id: 'kimi', label: 'Kimi', base_url: 'https://api.kimi.ai/coding/v1' },
    key: 'vendor-private-key',
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.body.textContent).not.toContain('vendor-private-key');
});
it('hands OAuth selection to the existing authorization flow', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ configured: true, providers: [], pools: [] })),
  );
  const onOAuth = vi.fn();
  render(ManagedProviders, { onOAuth });
  await fireEvent.click(await screen.findByRole('button', { name: 'Add provider' }));
  await fireEvent.click(screen.getByRole('button', { name: 'OAuth login' }));
  expect(onOAuth).toHaveBeenCalledOnce();
});
