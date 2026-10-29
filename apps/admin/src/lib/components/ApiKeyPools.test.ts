import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApiKeyPools from './ApiKeyPools.svelte';
afterEach(() => vi.unstubAllGlobals());
describe('API key provider management', () => {
  it('imports multiple keys and clears the credential input after success', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method
        ? new Response(null, { status: 204 })
        : Response.json({
            pools: [
              {
                id: 'openai',
                configured: true,
                timezone: 'Asia/Shanghai',
                strategy: 'round_robin',
                models: ['m'],
                accounts: [],
                usage: [],
              },
            ],
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(ApiKeyPools);
    await screen.findByRole('button', { name: 'Add API keys' });
    await fireEvent.click(screen.getByRole('button', { name: 'Add API keys' }));
    const input = screen.getByLabelText('API keys (one per line)');
    await fireEvent.input(input, { target: { value: 'sk-proj-test-first\nsk-proj-test-second' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save API keys' }));
    await waitFor(() => expect(screen.queryByLabelText('API keys (one per line)')).toBeNull());
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body)).accounts).toHaveLength(2);
    expect(document.body.textContent).not.toContain('sk-proj-test-first');
  });
  it('shows quota recovery separately from a manual pause and does not claim a balance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          pools: [
            {
              id: 'openai',
              configured: true,
              timezone: 'Asia/Shanghai',
              strategy: 'round_robin',
              models: ['m'],
              usage: [],
              accounts: [
                {
                  id: 'a',
                  name: 'Account A',
                  mask: '••••1234',
                  enabled: false,
                  priority: 50,
                  models: null,
                  state: 'quota_exhausted',
                  reason: 'insufficient_quota',
                  nextRetryAt: 1793462400000,
                  probeUntil: null,
                  deniedModels: [],
                },
              ],
            },
          ],
        }),
      ),
    );
    render(ApiKeyPools);
    await screen.findByText('Account A');
    expect(screen.getByText('Paused manually')).toBeTruthy();
    expect(screen.getByText('insufficient_quota')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try recovery' }).hasAttribute('disabled')).toBe(
      true,
    );
  });
});
