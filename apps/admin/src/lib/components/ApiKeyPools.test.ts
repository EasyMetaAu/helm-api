import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '$lib/i18n';
import ApiKeyPools from './ApiKeyPools.svelte';
afterEach(async () => {
  vi.unstubAllGlobals();
  await setLocale('en');
});
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
    expect(screen.queryByRole('button', { name: 'Try recovery' })).toBeNull();
  });
  it.each([{ deniedModels: [] }, { deniedModels: ['m'] }])(
    'uses localized usage and a compact action menu ($deniedModels)',
    async ({ deniedModels }) => {
      await setLocale('zh-hans');
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
                usage: [{ account: 'a', requests: 3, tokens: 1250, costUsd: 0.000003 }],
                accounts: [
                  {
                    id: 'a',
                    name: 'Primary',
                    mask: '••••1234',
                    enabled: true,
                    priority: 50,
                    models: null,
                    state: 'ready',
                    reason: null,
                    nextRetryAt: null,
                    probeUntil: null,
                    deniedModels,
                  },
                ],
              },
            ],
          }),
        ),
      );
      render(ApiKeyPools);
      await screen.findByText('Primary');
      expect(screen.getByRole('button', { name: '管理' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '删除' }).closest('details')?.open).toBe(false);
      expect(screen.queryByRole('button', { name: '尝试恢复' }) !== null).toBe(
        deniedModels.length > 0,
      );
      expect(screen.getByText('$0.000003')).toBeTruthy();
      expect(document.body.textContent).not.toMatch(/requests|Pause|tokens/);
      const menu = screen.getByText('更多操作').closest('details')!;
      await fireEvent.click(menu.querySelector('summary')!);
      menu.open = true;
      expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy();
      expect(screen.getByRole('button', { name: '删除' })).toBeTruthy();
    },
  );
});

it.each([true, false])(
  'tests the selected account and shows the actual result (ok=%s)',
  async (ok) => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      url.endsWith('/test')
        ? Response.json({
            ok,
            model: 'm',
            durationMs: 42,
            ...(ok ? { response: 'OK' } : { error: 'insufficient_quota', upstreamStatus: 429 }),
          })
        : Response.json({
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
                    id: 'selected',
                    name: 'Selected key',
                    mask: '••••1234',
                    enabled: false,
                    priority: 50,
                    models: null,
                    state: 'ready',
                    reason: null,
                    nextRetryAt: null,
                    probeUntil: null,
                    deniedModels: [],
                  },
                ],
              },
            ],
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(ApiKeyPools);
    await screen.findByText('Selected key');
    await fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByRole('dialog').textContent).toContain('Selected key');
    await fireEvent.click(screen.getByRole('button', { name: 'Run test' }));
    await screen.findByText(ok ? 'OK' : /insufficient_quota/);
    expect(fetchMock).toHaveBeenCalledWith(
      '/admin/api/api-key-pools/openai/accounts/selected/test',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ model: 'm' }) }),
    );
  },
);
