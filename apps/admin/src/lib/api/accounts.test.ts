import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSpend, listAccounts, topupAccount } from './accounts.js';

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (no core import).
// These tests pin the Accounts client contract against a mocked fetch.

describe('accounts api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listAccounts GETs /admin/api/accounts', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify([{ account_id: 'a', credit_balance_usd: 5 }]), { status: 200 }),
    );
    const out = await listAccounts();
    expect(fetch).toHaveBeenCalledWith('/admin/api/accounts', expect.objectContaining({}));
    expect(out[0]?.account_id).toBe('a');
  });

  it('getSpend GETs the spend window endpoint', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ account_id: 'a', from: 1, to: 2, spend_usd: 3 }), {
        status: 200,
      }),
    );
    const out = await getSpend('a', 1, 2);
    const [url] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/accounts/a/spend?from=1&to=2');
    expect(out.spend_usd).toBe(3);
  });

  it('topupAccount POSTs the amount and returns the new balance', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ account_id: 'a', balance_after_usd: 15 }), { status: 200 }),
    );
    const out = await topupAccount('a', 10);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/accounts/a/topup');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ amount_usd: 10 });
    expect(out.balance_after_usd).toBe(15);
  });

  it('throws on a non-OK response (fail-closed surfacing)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'credit store not configured' }), { status: 503 }),
    );
    await expect(listAccounts()).rejects.toThrow(/accounts api 503/);
  });
});
