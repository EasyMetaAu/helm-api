import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyView } from './keys.js';
import { createKey, getKeysUsage, listKeys, revokeKey, updateKey } from './keys.js';

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (DoD: no core
// import). These tests pin the client contract against a mocked fetch. The
// backend is the single source of truth: GET returns a redacted KeySummary[]
// (prefix only, no hash/plaintext), POST returns { key_id, plaintext } ONCE, and
// revoke is a soft DELETE that returns { revoked: id } — the UI marks the row
// disabled locally (rotation semantics: generate-new + old disabled, never in-place rewrite).

function summaryRow(
  keyId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key_id: keyId,
    prefix: `helm_live_${keyId}`,
    role: 'user',
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
    rate_limit_rpm: null,
    rate_limit_tpm: null,
    ...overrides,
  };
}

describe('keys api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listKeys GETs /admin/api/keys and returns redacted views (no hash/plaintext)', async () => {
    const rows = [summaryRow('k1'), summaryRow('k2', { role: 'root', disabled: true })];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );

    const keys = await listKeys();

    expect(fetch).toHaveBeenCalledWith('/admin/api/keys', expect.objectContaining({}));
    expect(keys.map((k: ApiKeyView) => k.key_id)).toEqual(['k1', 'k2']);
    expect(keys[0].prefix).toBe('helm_live_k1');
    expect(keys[1].role).toBe('root');
    expect(keys[1].disabled).toBe(true);
    // Redacted shape: never carries a hash or plaintext, even if the server slipped one.
    expect(keys[0]).not.toHaveProperty('hash');
    expect(keys[0]).not.toHaveProperty('plaintext');
  });

  it('getKeysUsage GETs /keys/usage with the window and normalizes rows', async () => {
    const rows = [
      { key_id: 'k1', requests: 7, error_count: 1, cost_usd: 0.042, total_tokens: 1500 },
      // cost_usd null = "not measured" — must survive as null, never coerced to 0.
      { key_id: 'k2', requests: 2, error_count: 0, cost_usd: null, total_tokens: 30 },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );

    const usage = await getKeysUsage({ start: 1000 });

    const url = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('/admin/api/keys/usage');
    expect(url).toContain('start=1000');
    expect(usage[0]).toEqual({
      key_id: 'k1',
      requests: 7,
      error_count: 1,
      cost_usd: 0.042,
      total_tokens: 1500,
    });
    expect(usage[1].cost_usd).toBeNull();
  });

  it('createKey POSTs caps to /admin/api/keys and returns the one-time plaintext', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          key_id: 'key_1',
          plaintext: 'helm_live_SECRET_ONCE',
          prefix: 'helm_live_SECR',
        }),
        {
          status: 201,
        },
      ),
    );

    const result = await createKey({
      role: 'user',
      allowed_lanes: ['economy', 'balanced'],
      allow_custom_model: false,
    });

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/keys');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.role).toBe('user');
    expect(body.allowed_lanes).toEqual(['economy', 'balanced']);
    expect(body.allow_custom_model).toBe(false);
    expect(result.key_id).toBe('key_1');
    expect(result.plaintext).toBe('helm_live_SECRET_ONCE');
    // Server-minted non-sensitive prefix is carried so the UI never slices the
    // plaintext to build a redacted display value.
    expect(result.prefix).toBe('helm_live_SECR');
  });

  it('createKey omits empty optional caps so the strict server schema accepts it', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ key_id: 'key_2', plaintext: 'x' }), { status: 201 }),
    );

    await createKey({ role: 'user' });

    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty('max_lane');
    expect(body).not.toHaveProperty('allowed_lanes');
    expect(body.role).toBe('user');
  });

  it('listKeys surfaces per-key rate limits (null = inherit, number = override)', async () => {
    const rows = [summaryRow('k1'), summaryRow('k2', { rate_limit_rpm: 60, rate_limit_tpm: 0 })];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );
    const keys = await listKeys();
    expect(keys[0].rate_limit_rpm).toBeNull();
    expect(keys[0].rate_limit_tpm).toBeNull();
    expect(keys[1].rate_limit_rpm).toBe(60);
    expect(keys[1].rate_limit_tpm).toBe(0);
  });

  it('listKeys surfaces per-key memory defaults (issue #97 round-trip)', async () => {
    const rows = [
      summaryRow('k1'),
      summaryRow('k2', {
        memory_mode: 'inject',
        memory_project_id: 'proj-1',
        memory_thread_source: 'auto',
      }),
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );
    const keys = await listKeys();
    // Unconfigured key normalizes to the safe defaults…
    expect(keys[0].memory_mode).toBe('off');
    expect(keys[0].memory_project_id).toBeNull();
    expect(keys[0].memory_thread_source).toBe('header');
    // …a configured key round-trips its values (so an edit won't wipe them).
    expect(keys[1].memory_mode).toBe('inject');
    expect(keys[1].memory_project_id).toBe('proj-1');
    expect(keys[1].memory_thread_source).toBe('auto');
  });

  it('listKeys surfaces the key name (null when absent/empty, string when set)', async () => {
    const rows = [summaryRow('k1'), summaryRow('k2', { name: 'Production backend' })];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );
    const keys = await listKeys();
    expect(keys[0].name).toBeNull();
    expect(keys[1].name).toBe('Production backend');
  });

  it('createKey sends the name when set and omits it when blank (strict schema)', async () => {
    // A Response body is single-use, so give each call its own fresh Response.
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ key_id: 'k', plaintext: 'x', prefix: 'p' }), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ key_id: 'k', plaintext: 'x', prefix: 'p' }), { status: 201 }),
      );
    await createKey({ role: 'user', name: 'Mobile app' });
    await createKey({ role: 'user', name: '' });
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse(calls[0][1].body as string).name).toBe('Mobile app');
    expect(JSON.parse(calls[1][1].body as string)).not.toHaveProperty('name');
  });

  it('updateKey forwards the name to rename (string) and null to clear it', async () => {
    (fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(new Response(JSON.stringify({ key_id: 'k' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ key_id: 'k' }), { status: 200 }));
    await updateKey('k', { name: 'Renamed' });
    await updateKey('k', { name: null });
    const calls = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse(calls[0][1].body as string).name).toBe('Renamed');
    expect(JSON.parse(calls[1][1].body as string).name).toBeNull();
  });

  it('createKey sends per-key rate limits when set (including 0 = unlimited)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ key_id: 'key_1', plaintext: 'x', prefix: 'p' }), {
        status: 201,
      }),
    );
    await createKey({ role: 'user', rate_limit_rpm: 60, rate_limit_tpm: 0 });
    const init = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const body = JSON.parse(init.body as string);
    expect(body.rate_limit_rpm).toBe(60);
    expect(body.rate_limit_tpm).toBe(0);
  });

  it('createKey omits rate limits when not provided (inherit system default)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ key_id: 'key_2', plaintext: 'x' }), { status: 201 }),
    );
    await createKey({ role: 'user' });
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body).not.toHaveProperty('rate_limit_rpm');
    expect(body).not.toHaveProperty('rate_limit_tpm');
  });

  it('updateKey PATCHes /admin/api/keys/:id with caps + rate limits (null clears)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ key_id: 'key_1' }), { status: 200 }),
    );
    await updateKey('key_1', {
      allowed_lanes: ['economy', 'balanced'],
      allow_custom_model: true,
      rate_limit_rpm: null,
      rate_limit_tpm: 100,
    });
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/keys/key_1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body.allowed_lanes).toEqual(['economy', 'balanced']);
    expect(body.allow_custom_model).toBe(true);
    expect(body.rate_limit_rpm).toBeNull(); // explicit null = clear
    expect(body.rate_limit_tpm).toBe(100);
  });

  it('updateKey forwards null to clear the allowed-lanes whitelist', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ key_id: 'key_1' }), { status: 200 }),
    );
    await updateKey('key_1', { allowed_lanes: null });
    const [, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.allowed_lanes).toBeNull();
  });

  it('updateKey rejects on a non-2xx response (404)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'key not found' }), { status: 404 }),
    );
    await expect(updateKey('nope', { rate_limit_rpm: 1 })).rejects.toThrow();
  });

  it('revokeKey DELETEs /admin/api/keys/:id and resolves to the revoked id', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ revoked: 'key_1' }), { status: 200 }),
    );

    const out = await revokeKey('key_1');

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/keys/key_1');
    expect(init.method).toBe('DELETE');
    expect(out.revoked).toBe('key_1');
  });

  it('createKey rejects on a non-2xx response (fail-closed, no half-minted plaintext)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid key request' }), { status: 400 }),
    );

    await expect(createKey({ role: 'user' })).rejects.toThrow();
  });

  it('revokeKey rejects when the id is unknown (404)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'key not found' }), { status: 404 }),
    );

    await expect(revokeKey('nope')).rejects.toThrow();
  });
});
