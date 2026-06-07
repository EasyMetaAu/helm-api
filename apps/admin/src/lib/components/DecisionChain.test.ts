import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { RequestDetail } from '$lib/api/requests.js';
import DecisionChain from './DecisionChain.svelte';

// DecisionChain visualises, in order, the trail the backend recorded:
//   classifier output (incl. confidence + matched_dimensions)
//   -> eval (triggered / cache hit)
//   -> matched policy
//   -> lane candidate chain
//   -> provider attempts (incl. outcome / skip_reason / latency)
// CLAUDE.md Principle 5: the classification-stage decision (`decided_by`) and the
// execution-stage provider fallback are shown in SEPARATE sections.

function detail(overrides: Partial<RequestDetail> = {}): RequestDetail {
  return {
    trace_id: 'tr_1',
    ts: '',
    request_meta: {},
    payload_summary: 'payload withheld (redacted)',
    classifier_output: {
      task_type: 'coding',
      complexity: 'high',
      confidence: 0.87,
      decided_by: 'eval',
      rules_confidence: 0.05,
      matched_dimensions: ['has_code_fence', 'long_context'],
      constraints: { require_tools: true, require_json: false },
    },
    eval_triggered: true,
    eval_cache_hit: false,
    eval_model: 'gpt-4o-mini',
    eval_latency_ms: 1234,
    eval_fallback_reason: null,
    matched_policy: 'policy_coding_premium',
    lane_candidates: ['premium', 'balanced', 'economy'],
    provider_attempts: [
      {
        model: 'gpt-x',
        provider: 'openai',
        outcome: 'error',
        latency_ms: 120,
        error_class: 'upstream_error',
        error_detail: {
          upstream_status: 429,
          message: 'upstream returned 429',
          provider_raw: { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } },
        },
      },
      {
        model: 'claude-x',
        provider: 'anthropic',
        outcome: 'success',
        latency_ms: 340,
        error_detail: null,
      },
      {
        model: 'small-x',
        provider: 'local',
        outcome: 'skipped',
        skip_reason: 'capability_unsatisfiable',
        latency_ms: 0,
        error_detail: null,
      },
    ],
    response_meta: { model_alias: 'claude-x' },
    error: null,
    cost_breakdown: { routing_usd: 0, eval_usd: 0, completion_usd: 0.01, total_usd: 0.01 },
    ...overrides,
  };
}

describe('DecisionChain', () => {
  it('renders classifier output with confidence and matched dimensions', () => {
    render(DecisionChain, { detail: detail() });
    const cls = screen.getByTestId('chain-classifier');
    expect(within(cls).getByText(/coding/)).toBeInTheDocument();
    expect(within(cls).getByText(/high/)).toBeInTheDocument();
    expect(within(cls).getByText(/0\.87/)).toBeInTheDocument();
    expect(within(cls).getByText(/has_code_fence/)).toBeInTheDocument();
    expect(within(cls).getByText(/long_context/)).toBeInTheDocument();
  });

  it('shows eval triggered + cache-hit state distinctly from execution fallback', () => {
    render(DecisionChain, { detail: detail() });
    const evalSec = screen.getByTestId('chain-eval');
    expect(within(evalSec).getByText(/triggered/i)).toBeInTheDocument();
    expect(within(evalSec).getByText(/miss/i)).toBeInTheDocument();
  });

  it('shows WHICH model ran eval, its latency, and the eval verdict it produced', () => {
    render(DecisionChain, { detail: detail() });
    const evalSec = screen.getByTestId('chain-eval');
    // The eval model name + latency answer "which model evaluated, how long".
    expect(within(evalSec).getByText('gpt-4o-mini')).toBeInTheDocument();
    expect(within(evalSec).getByText(/1234ms/)).toBeInTheDocument();
    // The eval verdict is restated here, attributed, so it is not mistaken for rules.
    const verdict = within(evalSec).getByTestId('eval-verdict');
    expect(verdict).toHaveTextContent('coding');
    expect(verdict).toHaveTextContent('high');
    expect(verdict).toHaveTextContent('0.87');
  });

  it('attributes the classifier verdict to its decision source (eval vs rules)', () => {
    render(DecisionChain, { detail: detail() });
    expect(screen.getByTestId('chain-decided-by')).toHaveTextContent(/eval/i);
    // A rules-decided request attributes to Layer-1 rules instead.
    render(DecisionChain, {
      detail: detail({
        classifier_output: {
          task_type: 'chat',
          complexity: 'low',
          confidence: 0.95,
          decided_by: 'rules',
          rules_confidence: 0.95,
          matched_dimensions: [],
          constraints: {},
        },
        eval_triggered: false,
        eval_model: null,
        eval_latency_ms: null,
      }),
    });
    expect(screen.getAllByTestId('chain-decided-by')[1]).toHaveTextContent(/rules/i);
    // No escalation line on a rules-decided request (the confidence IS Layer-1's).
    expect(screen.queryAllByTestId('rules-escalation')).toHaveLength(1); // only the eval-decided render
  });

  it('explains WHY eval ran: shows the low Layer-1 gate confidence next to the eval verdict', () => {
    render(DecisionChain, { detail: detail() });
    const cls = screen.getByTestId('chain-classifier');
    const esc = within(cls).getByTestId('rules-escalation');
    // The 0.87 above is the EVAL model's confidence; Layer-1's was 0.05 — the
    // line must surface the gate value so they cannot be conflated.
    expect(esc).toHaveTextContent('0.05');
    expect(esc).toHaveTextContent(/uncertain/i);
  });

  it('legacy eval-decided record (no rules_confidence) still gets the qualitative escalation line', () => {
    render(DecisionChain, {
      detail: detail({
        classifier_output: {
          task_type: 'coding',
          complexity: 'high',
          confidence: 0.87,
          decided_by: 'eval',
          rules_confidence: null,
          matched_dimensions: [],
          constraints: {},
        },
      }),
    });
    const esc = screen.getByTestId('rules-escalation');
    expect(esc).toHaveTextContent(/uncertain/i);
    expect(esc).not.toHaveTextContent(/\d\.\d\d/); // no fabricated number
  });

  it('explains the eval_disabled fallback in the eval section (uncertain + eval off -> balanced)', () => {
    render(DecisionChain, {
      detail: detail({
        classifier_output: {
          task_type: 'chat',
          complexity: 'standard',
          confidence: 0.2,
          decided_by: 'fallback',
          rules_confidence: 0.2,
          matched_dimensions: [],
          constraints: {},
        },
        eval_triggered: false,
        eval_cache_hit: null,
        eval_model: null,
        eval_latency_ms: null,
        eval_fallback_reason: 'eval_disabled',
      }),
    });
    const evalSec = screen.getByTestId('chain-eval');
    expect(within(evalSec).getByText(/not triggered/i)).toBeInTheDocument();
    expect(within(evalSec).getByTestId('eval-disabled-note')).toHaveTextContent(/disabled/i);
  });

  it('explains an eval that ran then failed open (reason + balanced fallback)', () => {
    render(DecisionChain, {
      detail: detail({
        classifier_output: {
          task_type: 'chat',
          complexity: 'standard',
          confidence: 0.2,
          decided_by: 'fallback',
          rules_confidence: 0.2,
          matched_dimensions: [],
          constraints: {},
        },
        eval_triggered: true,
        eval_cache_hit: false,
        eval_model: 'gpt-4o-mini',
        eval_latency_ms: 50,
        eval_fallback_reason: 'eval_timeout',
      }),
    });
    const evalSec = screen.getByTestId('chain-eval');
    const failed = within(evalSec).getByTestId('eval-failed');
    expect(failed).toHaveTextContent(/timed out/i);
    expect(failed).toHaveTextContent(/balanced/i);
    // No verdict line on the failed-open path (eval produced no verdict).
    expect(within(evalSec).queryByTestId('eval-verdict')).toBeNull();
  });

  it('renders the matched policy', () => {
    render(DecisionChain, { detail: detail() });
    expect(screen.getByTestId('chain-policy')).toHaveTextContent('policy_coding_premium');
  });

  it('renders the lane candidate chain in order', () => {
    render(DecisionChain, { detail: detail() });
    const lanes = screen.getByTestId('chain-lanes');
    const items = within(lanes).getAllByTestId('lane-candidate');
    expect(items.map((n) => n.textContent?.trim())).toEqual(['premium', 'balanced', 'economy']);
  });

  it('renders each provider attempt with outcome, skip_reason and latency', () => {
    render(DecisionChain, { detail: detail() });
    const attempts = screen.getByTestId('chain-attempts');
    const rows = within(attempts).getAllByTestId('attempt-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/error/i);
    expect(rows[0]).toHaveTextContent('120');
    expect(rows[1]).toHaveTextContent(/success/i);
    expect(rows[2]).toHaveTextContent(/skipped/i);
    expect(rows[2]).toHaveTextContent('capability_unsatisfiable');
  });

  it('exposes a failed attempt error_detail (upstream status + message + raw body) as an expandable panel', () => {
    render(DecisionChain, { detail: detail() });
    const attempts = screen.getByTestId('chain-attempts');
    const rows = within(attempts).getAllByTestId('attempt-row');
    // The first attempt failed — its detail is the only record of WHY.
    const detailEl = within(rows[0]).getByTestId('attempt-error-detail');
    expect(detailEl).toBeInTheDocument();
    expect(detailEl).toHaveTextContent('429');
    expect(detailEl).toHaveTextContent('upstream returned 429');
    // The redacted raw upstream body is shown (already key-scrubbed by backend).
    expect(detailEl).toHaveTextContent('rate limit exceeded');
    // A successful attempt has no detail panel.
    expect(within(rows[1]).queryByTestId('attempt-error-detail')).toBeNull();
  });

  it('keeps classification-stage and execution-stage fallback in separate sections (Principle 5)', () => {
    render(DecisionChain, { detail: detail() });
    // Two clearly distinct regions exist; the classifier section is not the
    // attempts section.
    expect(screen.getByTestId('chain-classifier')).toBeInTheDocument();
    expect(screen.getByTestId('chain-attempts')).toBeInTheDocument();
    expect(screen.getByTestId('chain-classifier')).not.toBe(screen.getByTestId('chain-attempts'));
  });
});
