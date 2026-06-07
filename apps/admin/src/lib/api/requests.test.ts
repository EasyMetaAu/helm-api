import { afterEach, describe, expect, it, vi } from 'vitest';
import { listRequests, toDetail, toListItem } from './requests.js';

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
    key_prefix: 'helm_live_ab12',
    classifier: {
      task_type: 'coding',
      complexity: 'complex',
      confidence: 0.9,
      decided_by: 'eval',
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
    latency_total_ms: 460,
    fallback_count: 1,
    cost_breakdown: { eval_usd: 0.0002, completion_usd: 0.01, total_usd: 0.0102 },
    ...overrides,
  };
}

describe('toListItem', () => {
  it('reads the real key_prefix (prefix only), latency total and fallback_count', () => {
    const row = toListItem(rawRecord());
    expect(row.key_prefix).toBe('helm_live_ab12');
    expect(row.latency_ms).toBe(460);
    expect(row.fallback_count).toBe(1);
    expect(row.cost_usd).toBeCloseTo(0.01);
    expect(row.decided_by).toBe('eval');
  });

  it('falls back to "—" for key_prefix when the record carries none (never plaintext)', () => {
    const row = toListItem(rawRecord({ key_prefix: null }));
    expect(row.key_prefix).toBe('—');
  });

  it('maps the recorded created_at (epoch ms) to an ISO ts; legacy records stay empty', () => {
    const row = toListItem(rawRecord({ created_at: 1717155600000 }));
    expect(row.ts).toBe(new Date(1717155600000).toISOString());
    // No created_at on a legacy record → empty (never fabricated).
    expect(toListItem(rawRecord()).ts).toBe('');
  });
});

describe('toDetail', () => {
  it('maps the recorded cost_breakdown with eval cost separated from completion', () => {
    const d = toDetail(rawRecord());
    expect(d.cost_breakdown.eval_usd).toBeCloseTo(0.0002);
    expect(d.cost_breakdown.completion_usd).toBeCloseTo(0.01);
    expect(d.cost_breakdown.total_usd).toBeCloseTo(0.0102);
  });

  it('surfaces the eval model, latency and decision source (decided_by) for an eval-decided request', () => {
    const d = toDetail(rawRecord());
    expect(d.classifier_output.decided_by).toBe('eval');
    expect(d.eval_triggered).toBe(true);
    expect(d.eval_model).toBe('gpt-4o-mini');
    expect(d.eval_latency_ms).toBe(1234);
    expect(d.eval_fallback_reason).toBeNull();
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

  it('defaults cost parts to 0 when the record has no cost_breakdown (legacy record)', () => {
    const legacy = rawRecord();
    delete legacy.cost_breakdown;
    const d = toDetail(legacy);
    // completion derived from the summed attempts; eval unknown -> 0 (visible).
    expect(d.cost_breakdown.completion_usd).toBeCloseTo(0.01);
    expect(d.cost_breakdown.eval_usd).toBe(0);
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
    expect(url.searchParams.get('start')).toBe('1000');
    expect(url.searchParams.get('end')).toBe('2000');
  });

  it('omits unset params and hits the bare endpoint', async () => {
    const f = stubFetch({ items: [], total: 0, page: 1, pageSize: 50 });
    await listRequests();
    expect(f.url()).toBe('/admin/api/requests');
  });

  it('maps the envelope rows and passes the totals through', async () => {
    stubFetch({ items: [rawRecord({ created_at: 1717155600000 })], total: 7, page: 3, pageSize: 2 });
    const res = await listRequests({ page: 3, pageSize: 2 });
    expect(res.total).toBe(7);
    expect(res.page).toBe(3);
    expect(res.pageSize).toBe(2);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]?.trace_id).toBe('tr_1');
  });
});
