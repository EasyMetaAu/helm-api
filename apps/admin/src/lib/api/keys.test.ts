import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyView } from './keys.js';
import { createKey, listKeys, revokeKey } from './keys.js';

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (DoD: no core
// import). These tests pin the client contract against a mocked fetch. The
// backend is the single source of truth: GET returns a redacted KeySummary[]
// (prefix only, no hash/plaintext), POST returns { key_id, plaintext } ONCE, and
// revoke is a soft DELETE that returns { revoked: id } — the UI marks the row
// disabled locally (轮转语义: generate-new + old disabled, never in-place rewrite).

function summaryRow(
  keyId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key_id: keyId,
    prefix: `helm_live_${keyId}`,
    role: 'user',
    max_lane: null,
    allowed_lanes: null,
    allow_custom_model: false,
    disabled: false,
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

  it('createKey POSTs caps to /admin/api/keys and returns the one-time plaintext', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ key_id: 'key_1', plaintext: 'helm_live_SECRET_ONCE' }), {
        status: 201,
      }),
    );

    const result = await createKey({
      role: 'user',
      max_lane: 'balanced',
      allow_custom_model: false,
    });

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/keys');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.role).toBe('user');
    expect(body.max_lane).toBe('balanced');
    expect(body.allow_custom_model).toBe(false);
    expect(result.key_id).toBe('key_1');
    expect(result.plaintext).toBe('helm_live_SECRET_ONCE');
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
