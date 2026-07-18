import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeTps, computeTtfbMs, listRequests, toDetail, toListItem } from './requests.js';

// The API client maps the backend DecisionRecord -> the docs/07 UI contract. Since
// admin.requests-richfields the record carries the real telemetry fields
// (key_prefix, latency_total_ms, fallback_count, cost_breakdown{eval/completion}),
// so the client now reads them instead of placeholders. Principle 7: key_prefix is
// prefix-only, never the plaintext key; provider_raw stays redacted.

function rawRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    request_id: 'tr_1',
    trace_id: 'tr_1',
    requested_model: 'gpt-4o',
    reasoning_effort: 'high',
    key_prefix: 'helm_live_ab12',
    classifier: {
      task_type: 'coding',
      complexity: 'complex',
      confidence: 0.9,
      decided_by: 'eval',
      rules_confidence: 0.12,
      eval_cache_hit: false,
      eval_model: 'gpt-4o-mini',
      eval_latency_ms: 1234,
      constraints: { needs_tools: true },
      explanation: ['matched: code-block'],
    },
    policy: { matched_policy_id: 'p1', reason: 'matched' },
    lane: { selected_lane: 'coding', candidate_chain: ['coder_a', 'premium'] },
    provider_attempts: [
      {
        alias: 'coder_a',
        skipped: false,
        skip_reason: null,
        status: 'error',
        error_class: 'upstream_error',
        latency_ms: 120,
        cost_usd: null,
      },
      {
        alias: 'premium',
        provider_name: 'anthropic',
        provider_model: 'claude-x',
        skipped: false,
        skip_reason: null,
        status: 'ok',
        error_class: null,
        latency_ms: 340,
        cost_usd: 0.01,
      },
    ],
    final: {
      model_alias: 'premium',
      provider_model: 'claude-x',
      status: 'ok',
      error_reason: null,
    },
    serving_account: { provider_id: 'anthropic', account: 'claude-team-a' },
    latency_total_ms: 460,
    fallback_count: 1,
    cost_breakdown: { eval_usd: 0.0002, completion_usd: 0.01, total_usd: 0.0102 },
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 340,
      cached_tokens: 800,
      cache_creation_tokens: 64,
    },
    ...overrides,
  };
}

describe('toDetail', () => {
  it('surfaces body-free reasoning effort in redacted request metadata', () => {
    const detail = toDetail(rawRecord());
    expect(detail.reasoning_effort).toBe('high');
    expect(detail.request_meta).toEqual({
      requested_model: 'gpt-4o',
      reasoning_effort: 'high',
      policy_reason: 'matched',
    });
  });
});

describe('toListItem', () => {
  it('keeps the unique storage request id separate from reusable client correlation', () => {
    const raw = rawRecord({ request_id: 'req_internal_1', trace_id: 'client_shared_trace' });
    const row = toListItem(raw);
    const detail = toDetail(raw);
    expect(row.request_id).toBe('req_internal_1');
    expect(row.trace_id).toBe('client_shared_trace');
    expect(detail.request_id).toBe('req_internal_1');
    expect(detail.trace_id).toBe('client_shared_trace');
  });

  it('rejects records without the internal request id instead of using the client trace as a key', () => {
    const raw = rawRecord({ request_id: undefined, trace_id: 'client_shared_trace' });
    expect(() => toListItem(raw)).toThrow(/request_id/i);
    expect(() => toDetail(raw)).toThrow(/request_id/i);
  });

  it('reads the real key_prefix (prefix only), latency total and fallback_count', () => {
    const row = toListItem(rawRecord());
    expect(row.key_prefix).toBe('helm_live_ab12');
    expect(row.latency_ms).toBe(460);
    expect(row.fallback_count).toBe(1);
    expect(row.cost_usd).toBeCloseTo(0.01);
    expect(row.decided_by).toBe('eval');
  });

  it('surfaces the served provider and final subscription account on list rows', () => {
    const row = toListItem(rawRecord());
    expect(row.served_provider).toBe('anthropic');
    expect(row.serving_account).toEqual({ provider_id: 'anthropic', account: 'claude-team-a' });

    const nonSubscription = toListItem(rawRecord({ serving_account: null }));
    expect(nonSubscription.served_provider).toBe('anthropic');
    expect(nonSubscription.serving_account).toBeNull();
  });

  it('falls back to "—" for key_prefix when the record carries none (never plaintext)', () => {
    const row = toListItem(rawRecord({ key_prefix: null }));
    expect(row.key_prefix).toBe('—');
  });

  it('reads the resolved key_name when present; null (with prefix kept) when absent/empty', () => {
    expect(toListItem(rawRecord({ key_name: 'Production backend' })).key_name).toBe(
      'Production backend',
    );
    // Prefix is still carried so the view can fall back to it.
    const named = toListItem(rawRecord({ key_name: 'Mobile app' }));
    expect(named.key_prefix).toBe('helm_live_ab12');
    // Unnamed key (or legacy record) → null, never an empty-string label.
    expect(toListItem(rawRecord()).key_name).toBeNull();
    expect(toListItem(rawRecord({ key_name: '' })).key_name).toBeNull();
  });

  it('maps the recorded created_at (epoch ms) to an ISO ts; legacy records stay empty', () => {
    const row = toListItem(rawRecord({ created_at: 1717155600000 }));
    expect(row.ts).toBe(new Date(1717155600000).toISOString());
    // No created_at on a legacy record → empty (never fabricated).
    expect(toListItem(rawRecord()).ts).toBe('');
  });

  it('maps the recorded token usage, deriving non-cached = prompt − cached and a prompt+completion total', () => {
    const row = toListItem(rawRecord());
    expect(row.usage.measurement).toBe('reported');
    expect(row.usage.input).toBe(1200);
    expect(row.usage.output).toBe(340);
    expect(row.usage.cached).toBe(800);
    expect(row.usage.cacheCreation).toBe(64);
    // non-cached = input − cached (clamped ≥ 0); total = input + output.
    expect(row.usage.nonCached).toBe(400);
    expect(row.usage.total).toBe(1540);
  });

  it('clamps non-cached to 0 when cached exceeds the reported prompt (never negative)', () => {
    const row = toListItem(rawRecord({ usage: { prompt_tokens: 500, cached_tokens: 800 } }));
    expect(row.usage.nonCached).toBe(0);
  });

  it('leaves every usage leaf null for a legacy record that carried no usage block', () => {
    const legacy = rawRecord();
    delete legacy.usage;
    const u = toListItem(legacy).usage;
    expect(u.input).toBeNull();
    expect(u.output).toBeNull();
    expect(u.cached).toBeNull();
    expect(u.cacheCreation).toBeNull();
    expect(u.nonCached).toBeNull();
    expect(u.total).toBeNull();
    expect(u.measurement).toBe('unknown');
  });

  it('preserves estimated-partial provenance and stream termination separately from final status', () => {
    const row = toListItem(
      rawRecord({
        stream_outcome: 'truncated',
        final: {
          model_alias: 'premium',
          provider_model: 'claude-x',
          status: 'error',
          error_reason: 'upstream_error',
        },
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 21,
          measurement: 'estimated_partial',
        },
      }),
    );
    expect(row.status).toBe('error');
    expect(row.stream_outcome).toBe('truncated');
    expect(row.usage.measurement).toBe('estimated_partial');
  });
});

describe('toDetail', () => {
  it('surfaces the identity/summary fields (key, requested+served model, lane, status, latency)', () => {
    const d = toDetail(rawRecord({ key_name: 'Production backend' }));
    expect(d.key_prefix).toBe('helm_live_ab12'); // prefix only — never plaintext
    expect(d.key_name).toBe('Production backend');
    expect(d.requested_model).toBe('gpt-4o');
    expect(d.final_model).toBe('premium'); // served model alias
    expect(d.served_provider).toBe('anthropic');
    expect(d.serving_account).toEqual({ provider_id: 'anthropic', account: 'claude-team-a' });
    expect(d.lane).toBe('coding');
    expect(d.status).toBe('ok');
    expect(d.latency_ms).toBe(460);
  });

  it('nulls the identity fields a legacy/unnamed record never carried (never fabricated)', () => {
    const d = toDetail(rawRecord({ key_prefix: null, key_name: '' }));
    expect(d.key_prefix).toBeNull();
    expect(d.key_name).toBeNull();
    // An error record maps status through (drives the summary badge).
    const errored = toDetail(
      rawRecord({
        final: { model_alias: null, status: 'error', error_reason: 'all_providers_failed' },
      }),
    );
    expect(errored.status).toBe('error');
    expect(errored.final_model).toBeNull();
  });

  it('maps the recorded cost_breakdown with eval cost separated from completion', () => {
    const d = toDetail(rawRecord());
    expect(d.cost_breakdown.eval_usd).toBeCloseTo(0.0002);
    expect(d.cost_breakdown.completion_usd).toBeCloseTo(0.01);
    expect(d.cost_breakdown.total_usd).toBeCloseTo(0.0102);
  });

  it('keeps unknown detail costs null instead of turning them into a free $0', () => {
    const d = toDetail(
      rawRecord({
        cost_breakdown: { eval_usd: null, completion_usd: null, total_usd: null },
        provider_attempts: [
          {
            alias: 'premium',
            status: 'ok',
            skipped: false,
            latency_ms: 340,
            cost_usd: null,
          },
        ],
      }),
    );
    expect(d.cost_breakdown.routing_usd).toBe(0);
    expect(d.cost_breakdown.eval_usd).toBeNull();
    expect(d.cost_breakdown.completion_usd).toBeNull();
    expect(d.cost_breakdown.total_usd).toBeNull();
  });

  it('maps stream outcome onto detail without widening the binary provider result', () => {
    const d = toDetail(
      rawRecord({
        stream_outcome: 'client_aborted',
        final: {
          model_alias: 'premium',
          provider_model: 'claude-x',
          status: 'error',
          error_reason: 'client_abort',
        },
      }),
    );
    expect(d.status).toBe('error');
    expect(d.stream_outcome).toBe('client_aborted');
  });

  it('surfaces the eval model, latency and decision source (decided_by) for an eval-decided request', () => {
    const d = toDetail(rawRecord());
    expect(d.classifier_output.decided_by).toBe('eval');
    expect(d.eval_triggered).toBe(true);
    expect(d.eval_model).toBe('gpt-4o-mini');
    expect(d.eval_latency_ms).toBe(1234);
    expect(d.eval_fallback_reason).toBeNull();
  });

  it('keeps the Layer-1 gate confidence separate from the eval verdict confidence', () => {
    const d = toDetail(rawRecord());
    // confidence (0.9) is the EVAL verdict; rules_confidence (0.12) is why it escalated.
    expect(d.classifier_output.confidence).toBeCloseTo(0.9);
    expect(d.classifier_output.rules_confidence).toBeCloseTo(0.12);
    // Legacy record without the field → null, never fabricated.
    const legacy = rawRecord();
    delete (legacy.classifier as Record<string, unknown>).rules_confidence;
    expect(toDetail(legacy).classifier_output.rules_confidence).toBeNull();
  });

  it('renders explanation OBJECT entries via their detail label (never "[object Object]")', () => {
    const raw = rawRecord();
    (raw.classifier as Record<string, unknown>).explanation = [
      'plain-string-dim',
      { source: 'dimension', detail: 'code_block', weight: 2 },
      { source: 'override', weight: 1 }, // no string detail -> dropped
      42, // junk -> dropped
    ];
    const d = toDetail(raw);
    expect(d.classifier_output.matched_dimensions).toEqual(['plain-string-dim', 'code_block']);
  });

  it('maps an eval that ran then failed open (fallback_reason + null verdict model state)', () => {
    const d = toDetail(
      rawRecord({
        classifier: {
          task_type: 'chat',
          complexity: 'standard',
          confidence: 0.2,
          decided_by: 'fallback',
          eval_cache_hit: false,
          eval_model: 'gpt-4o-mini',
          eval_latency_ms: 50,
          fallback_reason: 'eval_timeout',
          constraints: {},
          explanation: [],
        },
      }),
    );
    expect(d.classifier_output.decided_by).toBe('fallback');
    // eval ran (cache_hit recorded as false, not null) → still "triggered".
    expect(d.eval_triggered).toBe(true);
    expect(d.eval_model).toBe('gpt-4o-mini');
    expect(d.eval_fallback_reason).toBe('eval_timeout');
  });

  it('leaves eval fields null for a legacy record that never carried them', () => {
    const legacy = rawRecord();
    (legacy.classifier as Record<string, unknown>).decided_by = 'rules';
    delete (legacy.classifier as Record<string, unknown>).eval_model;
    delete (legacy.classifier as Record<string, unknown>).eval_latency_ms;
    delete (legacy.classifier as Record<string, unknown>).eval_cache_hit;
    const d = toDetail(legacy);
    expect(d.eval_model).toBeNull();
    expect(d.eval_latency_ms).toBeNull();
    expect(d.eval_triggered).toBe(false);
  });

  it('uses known attempt cost for a legacy record without inventing eval cost', () => {
    const legacy = rawRecord();
    delete legacy.cost_breakdown;
    const d = toDetail(legacy);
    // Completion derives from the summed attempts; eval remains unknown.
    expect(d.cost_breakdown.completion_usd).toBeCloseTo(0.01);
    expect(d.cost_breakdown.eval_usd).toBeNull();
    expect(d.cost_breakdown.total_usd).toBeCloseTo(0.01);
  });

  it('surfaces a failed attempt error_detail (status + message + raw body); null elsewhere', () => {
    const raw = rawRecord();
    // The first attempt failed at the upstream but the second served — so this
    // detail is the only record of WHY the first failed.
    (raw.provider_attempts as Array<Record<string, unknown>>)[0].error_detail = {
      upstream_status: 429,
      message: 'upstream returned 429',
      provider_raw: { error: { message: 'rate limit exceeded' } },
    };
    const d = toDetail(raw);
    expect(d.provider_attempts[0]?.error_detail).toEqual({
      upstream_status: 429,
      message: 'upstream returned 429',
      provider_raw: { error: { message: 'rate limit exceeded' } },
    });
    // The ok attempt carries no detail.
    expect(d.provider_attempts[1]?.error_detail ?? null).toBeNull();
    expect(d.provider_attempts[1]?.provider).toBe('anthropic');
    expect(d.provider_attempts[1]?.provider_model).toBe('claude-x');
    expect(d.provider_attempts[1]?.serving_account).toEqual({
      provider_id: 'anthropic',
      account: 'claude-team-a',
    });
  });

  it('maps a missing error_detail to null (legacy records)', () => {
    const d = toDetail(rawRecord());
    expect(d.provider_attempts[0]?.error_detail ?? null).toBeNull();
  });

  it('maps the recorded created_at (epoch ms) to an ISO ts; legacy records stay empty', () => {
    const d = toDetail(rawRecord({ created_at: 1717155600000 }));
    expect(d.ts).toBe(new Date(1717155600000).toISOString());
    // No created_at on a legacy record → empty (never fabricated), so the detail
    // header degrades to "time not recorded" rather than showing a wrong time.
    expect(toDetail(rawRecord()).ts).toBe('');
  });
});

describe('true TPS + TTFB derivation', () => {
  // The fixture serves 340 completion tokens; with a 1700ms generation window that
  // is exactly 200 tok/s. latency_total_ms (460) is the streamed-response TTFB.
  it('derives tps = output ÷ generation window on a streamed record', () => {
    expect(computeTps(rawRecord({ generation_ms: 1700 }) as never)).toBeCloseTo(200);
    expect(toListItem(rawRecord({ generation_ms: 1700 })).tps).toBeCloseTo(200);
    const d = toDetail(rawRecord({ generation_ms: 1700 }));
    expect(d.tps).toBeCloseTo(200);
    expect(d.generation_ms).toBe(1700);
    expect(d.ttfb_ms).toBe(460); // == latency_total_ms (client-perceived TTFB)
  });

  it('is null (not measured) for a non-streaming record (no generation window)', () => {
    // The fixture has no generation_ms → non-streaming.
    expect(computeTps(rawRecord() as never)).toBeNull();
    expect(toListItem(rawRecord()).tps).toBeNull();
    const d = toDetail(rawRecord());
    expect(d.tps).toBeNull();
    expect(d.generation_ms).toBeNull();
    expect(d.ttfb_ms).toBeNull(); // TTFB only meaningful when a window was measured
  });

  it('guards divide-by-zero and missing counts (null, never Infinity/NaN)', () => {
    expect(computeTps(rawRecord({ generation_ms: 0 }) as never)).toBeNull();
    expect(computeTps(rawRecord({ generation_ms: -5 }) as never)).toBeNull();
    // Window present but no completion count → still not measurable.
    expect(
      computeTps(rawRecord({ generation_ms: 1000, usage: { prompt_tokens: 10 } }) as never),
    ).toBeNull();
    // TTFB needs a window; latency alone (non-streaming) does not qualify.
    expect(computeTtfbMs(rawRecord() as never)).toBeNull();
  });
});

describe('listRequests', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubFetch(body: unknown): { url: () => string } {
    let captured = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        captured = input;
        return { ok: true, json: async () => body } as Response;
      }),
    );
    return { url: () => captured };
  }

  it('builds the querystring from filters + pagination (decidedBy -> decided_by)', async () => {
    const f = stubFetch({ items: [], total: 0, page: 2, pageSize: 25 });
    await listRequests({
      page: 2,
      pageSize: 25,
      status: 'error',
      decidedBy: 'eval',
      lane: 'premium',
      model: 'gpt-4o',
      keyId: 'key_abc',
      start: 1000,
      end: 2000,
    });
    const url = new URL(f.url(), 'http://x');
    expect(url.pathname).toBe('/admin/api/requests');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('25');
    expect(url.searchParams.get('status')).toBe('error');
    expect(url.searchParams.get('decided_by')).toBe('eval');
    expect(url.searchParams.get('lane')).toBe('premium');
    expect(url.searchParams.get('model')).toBe('gpt-4o');
    // keyId is serialized as key_id to match the backend schema (exact key scope).
    expect(url.searchParams.get('key_id')).toBe('key_abc');
    expect(url.searchParams.get('start')).toBe('1000');
    expect(url.searchParams.get('end')).toBe('2000');
  });

  it('omits unset params and hits the bare endpoint', async () => {
    const f = stubFetch({ items: [], total: 0, page: 1, pageSize: 50 });
    await listRequests();
    expect(f.url()).toBe('/admin/api/requests');
  });

  it('maps the envelope rows and passes the totals through', async () => {
    stubFetch({
      items: [rawRecord({ created_at: 1717155600000 })],
      total: 7,
      page: 3,
      pageSize: 2,
    });
    const res = await listRequests({ page: 3, pageSize: 2 });
    expect(res.total).toBe(7);
    expect(res.page).toBe(3);
    expect(res.pageSize).toBe(2);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.trace_id).toBe('tr_1');
  });
});
