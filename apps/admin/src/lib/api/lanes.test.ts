import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Lane } from './lanes.js';
import { listLanes, saveLane, saveLanes } from './lanes.js';

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (DoD: no core
// import). These tests pin the client contract against a mocked fetch.

function laneRow(name: string, overrides: Partial<Lane> = {}): Record<string, unknown> {
  return {
    name,
    purpose: `${name} purpose`,
    primary: `${name}_primary`,
    fallback: [],
    constraints: { require_tools: false, require_json: false },
    ...overrides,
  };
}

describe('lanes api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listLanes GETs /admin/api/lanes and returns the lane array', async () => {
    const rows = [laneRow('economy'), laneRow('balanced'), laneRow('premium')];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );

    const lanes = await listLanes();

    expect(fetch).toHaveBeenCalledWith('/admin/api/lanes', expect.objectContaining({}));
    expect(lanes.map((l) => l.name)).toEqual(['economy', 'balanced', 'premium']);
    expect(lanes[0].constraints.require_tools).toBe(false);
  });

  it('saveLane PUTs /admin/api/lanes/:name with the lane body (no name field)', async () => {
    const lane: Lane = {
      name: 'coding',
      purpose: 'coding',
      primary: 'best_code_model',
      fallback: ['premium'],
      constraints: { require_tools: true, require_json: false, max_latency_ms: null },
    };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ primary: 'best_code_model' }), { status: 200 }),
    );

    await saveLane('coding', lane);

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/lanes/coding');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(body.primary).toBe('best_code_model');
    expect(body.name).toBeUndefined(); // strictObject on the server: name must NOT be sent
    expect(body.fallback).toEqual(['premium']);
  });

  it('saveLanes PUTs the complete lane map in one request', async () => {
    const lanes = [
      laneRow('balanced'),
      laneRow('coding', { fallback: ['balanced'] }),
    ] as unknown as Lane[];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(lanes), { status: 200 }),
    );

    await saveLanes(lanes);

    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('/admin/api/lanes');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(Object.keys(body)).toEqual(['balanced', 'coding']);
    expect(body.coding.name).toBeUndefined();
    expect(body.coding.fallback).toEqual(['balanced']);
  });

  it('saveLane rejects when the server returns a non-2xx (fail-closed)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid lane' }), { status: 400 }),
    );
    const lane: Lane = {
      name: 'balanced',
      primary: 'x',
      fallback: [],
      constraints: { require_tools: false, require_json: false, max_latency_ms: null },
    };

    await expect(saveLane('balanced', lane)).rejects.toThrow();
  });

  it('reads a valid reasoning_effort from GET and ignores an unknown value', async () => {
    const rows = [
      laneRow('balanced', { reasoning_effort: 'xhigh' } as Partial<Lane>),
      laneRow('economy', { reasoning_effort: 'ultra' } as unknown as Partial<Lane>),
      laneRow('premium'),
    ];
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(rows), { status: 200 }),
    );
    const lanes = await listLanes();
    expect(lanes[0].reasoning_effort).toBe('xhigh');
    expect(lanes[1].reasoning_effort).toBeUndefined(); // unknown value dropped
    expect(lanes[2].reasoning_effort).toBeUndefined(); // absent stays unforced
  });

  it('saveLane sends reasoning_effort when set and omits it when unforced', async () => {
    const ok = () => new Response(JSON.stringify({ primary: 'x' }), { status: 200 });
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    const base: Lane = {
      name: 'coding',
      primary: 'x',
      fallback: [],
      constraints: { require_tools: false, require_json: false, max_latency_ms: null },
    };
    // Fresh Response per call (a Response body can only be read once).
    fetchMock.mockResolvedValueOnce(ok());
    await saveLane('coding', { ...base, reasoning_effort: 'max' });
    const forced = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(forced.reasoning_effort).toBe('max');

    fetchMock.mockResolvedValueOnce(ok());
    await saveLane('coding', base); // no reasoning_effort
    const unforced = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(unforced.reasoning_effort).toBeUndefined();
  });
});
