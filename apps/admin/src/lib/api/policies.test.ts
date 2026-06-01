import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from './policies.js';
import { listPolicies, savePolicies, TASK_TYPE_OPTIONS } from './policies.js';

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (DoD: no core
// import). These tests pin the client contract against a mocked fetch. The wire
// shape is a bare ordered Policy[]; the server validates the whole set and the
// order IS the match priority (first-match), so the client must preserve it.

describe('task_type dropdown contract', () => {
  // The dropdown options are hardcoded in this client (admin must NOT import
  // @helm/shared, Principle 1), so they can silently drift from the gateway's canonical
  // TaskTypeSchema (@helm/shared classifier/eval-output.schema.ts). This guard
  // pins the FULL set: a config policy whose task_type has no matching <option>
  // renders the <select> blank (e.g. `security` policies showed empty). Keep this
  // list in lockstep with TaskTypeSchema; the gateway is the source of truth.
  it('offers every canonical TaskType (must match the server enum)', () => {
    expect([...TASK_TYPE_OPTIONS].sort()).toEqual(
      [
        'chat',
        'coding',
        'data',
        'extraction',
        'math',
        'security',
        'tool_use',
        'vision',
        'web',
        'writing',
      ].sort(),
    );
  });

  it('includes `security` (regression: policy #8 security_complex_to_premium rendered blank)', () => {
    expect(TASK_TYPE_OPTIONS).toContain('security');
  });
});

describe('policies api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listPolicies GETs /admin/api/policies and returns the ordered array', async () => {
    const rows: Policy[] = [
      { match: { task_type: 'coding' }, use_lane: 'coding' },
      { match: { complexity: 'complex' }, max_lane: 'premium' },
      { match: {}, use_lane: 'balanced' },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );

    const policies = await listPolicies();

    expect(fetch).toHaveBeenCalledWith('/admin/api/policies', expect.objectContaining({}));
    expect(policies).toHaveLength(3);
    expect(policies[0].match.task_type).toBe('coding');
    expect(policies[0].use_lane).toBe('coding');
    expect(policies[2].match).toEqual({}); // empty match = catch-all
  });

  it('savePolicies PUTs /admin/api/policies with the ordered list as the body', async () => {
    const list: Policy[] = [
      { match: { user_id: 'u1' }, use_lane: 'premium' },
      { match: { needs_json: true }, max_lane: 'balanced' },
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(list), { status: 200 }),
    );

    await savePolicies(list);

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/policies');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    // order preserved (= priority)
    expect(body[0].match.user_id).toBe('u1');
    expect(body[1].match.needs_json).toBe(true);
  });

  it('savePolicies drops the action field NOT chosen (use_lane/max_lane mutually exclusive)', async () => {
    // A policy carrying both must be normalized; the client never sends both.
    const list: Policy[] = [{ match: {}, use_lane: 'balanced', max_lane: 'premium' }];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(list), { status: 200 }),
    );

    await savePolicies(list);
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    const sent = body[0];
    // exactly one action present
    const hasUse = sent.use_lane != null;
    const hasMax = sent.max_lane != null;
    expect(hasUse !== hasMax).toBe(true);
  });

  it('savePolicies rejects when the server returns a non-2xx (fail-closed)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid policies' }), { status: 400 }),
    );
    await expect(savePolicies([{ match: {}, use_lane: 'balanced' }])).rejects.toThrow();
  });
});
