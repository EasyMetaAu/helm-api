import { describe, expect, it } from 'vitest';
import { toDetail, toListItem } from './requests.js';

// The API client maps the backend DecisionRecord -> the docs/07 UI contract. Since
// admin.requests-richfields the record carries the real telemetry fields
// (key_prefix, latency_total_ms, fallback_count, cost_breakdown{eval/completion}),
// so the client now reads them instead of placeholders. 原则7: key_prefix is
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
});

describe('toDetail', () => {
  it('maps the recorded cost_breakdown with eval cost separated from completion', () => {
    const d = toDetail(rawRecord());
    expect(d.cost_breakdown.eval_usd).toBeCloseTo(0.0002);
    expect(d.cost_breakdown.completion_usd).toBeCloseTo(0.01);
    expect(d.cost_breakdown.total_usd).toBeCloseTo(0.0102);
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
});
