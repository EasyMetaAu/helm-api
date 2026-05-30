import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifierConfig } from './classifier.js';
import { getClassifier, saveClassifier } from './classifier.js';

// The admin UI talks to the gateway ONLY over /admin/api/* HTTP (DoD: no core
// import). The server's GET/PUT round-trips the FULL classifier config
// (ClassifierConfigSchema). These tests pin the client contract against a mocked
// fetch: getClassifier projects the server shape into the read-only UI view;
// saveClassifier merges the small patch (eval.enabled / rules.confidence_threshold)
// onto the current server config and PUTs the whole object back.

function serverConfig(): Record<string, unknown> {
  return {
    rules: {
      enabled: true,
      confidence_threshold: 0.45,
      sigmoid_k: 8,
      tier_boundaries: { standard: -0.1, complex: 0.08, reasoning: 0.35 },
      dimensions: {
        code_density: { weight: 0.3, keywords: ['function', 'class'] },
        verbosity: { weight: -0.2, keywords: [] },
      },
      task_keywords: {},
      tool_prefixes: {},
      task_activation: {},
      overrides: {
        heartbeat_tokens: ['HEARTBEAT_OK'],
        formal_logic_keywords: [],
        tools_floor: 'standard',
        long_context_token_threshold: 50000,
        long_context_floor: 'complex',
        short_message_max_chars: 50,
      },
      momentum: {
        enabled: true,
        ttl_sec: 1800,
        history_size: 5,
        short_message_max_chars: 30,
        disable_above_chars: 100,
        max_history_weight: 0.6,
      },
    },
    eval: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      temperature: 0,
      max_tokens: 256,
      timeout_ms: 300,
      outer_timeout_ms: 250,
      on_failure: 'balanced',
      cache: { enabled: true, key: 'content_hash', ttl_sec: 300, max_entries: 5000 },
    },
  };
}

describe('classifier api client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getClassifier GETs /admin/api/classifier and projects the read-only UI view', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify(serverConfig()), { status: 200 }),
    );

    const cfg: ClassifierConfig = await getClassifier();

    expect(fetch).toHaveBeenCalledWith('/admin/api/classifier', expect.objectContaining({}));
    expect(cfg.rules.enabled).toBe(true);
    expect(cfg.rules.confidence_threshold).toBe(0.45);
    // dimensions projected from the server's record into an ordered array.
    const names = cfg.rules.dimensions.map((d) => d.name);
    expect(names).toContain('code_density');
    expect(names).toContain('verbosity');
    const code = cfg.rules.dimensions.find((d) => d.name === 'code_density');
    expect(code?.weight).toBe(0.3);
    expect(code?.direction).toBe('up');
    const verbose = cfg.rules.dimensions.find((d) => d.name === 'verbosity');
    expect(verbose?.direction).toBe('down');
    expect(cfg.rules.boundaries).toEqual({ standard: -0.1, complex: 0.08, reasoning: 0.35 });
    expect(cfg.eval.enabled).toBe(false);
    expect(cfg.eval.model).toBe('deepseek/deepseek-v4-flash');
    expect(cfg.eval.temperature).toBe(0);
    expect(cfg.eval.on_failure).toBe('balanced');
    expect(cfg.eval.cache.ttl_sec).toBe(300);
  });

  it('saveClassifier merges the patch onto the current config and PUTs the full object', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    // First call: GET current config. Second call: PUT echo.
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(serverConfig()), { status: 200 }))
      .mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(new Response(init.body as string, { status: 200 })),
      );

    await saveClassifier({ eval_enabled: true, confidence_threshold: 0.6 });

    // last call is the PUT
    const putCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === 'PUT');
    expect(putCall).toBeDefined();
    const [url, init] = putCall as [string, RequestInit];
    expect(url).toBe('/admin/api/classifier');
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string);
    expect(body.eval.enabled).toBe(true);
    expect(body.rules.confidence_threshold).toBe(0.6);
    // untouched read-only data is preserved on the round-trip (no field drop).
    expect(body.eval.on_failure).toBe('balanced');
    expect(body.rules.dimensions.code_density.weight).toBe(0.3);
  });

  it('saveClassifier rejects when the PUT returns a non-2xx (fail-closed)', async () => {
    const fetchMock = fetch as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(serverConfig()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'invalid classifier config' }), { status: 400 }),
      );

    await expect(saveClassifier({ confidence_threshold: 1.5 })).rejects.toThrow();
  });
});
