import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { toDetail } from '$lib/api/requests.js';
import RoutingSummary from './RoutingSummary.svelte';

const base = () =>
  toDetail({
    request_id: 'req-1',
    lane: { selected_lane: 'balanced' },
    final: { status: 'ok', model_alias: 'model-b' },
    stream_outcome: 'completed',
    provider_attempts: [
      { alias: 'model-a', status: 'error', error_class: 'rate_limited' },
      { alias: 'model-b', status: 'ok' },
    ],
  });

describe('RoutingSummary', () => {
  it('explains the exact organization restriction and names the affected key', () => {
    const detail = toDetail({
      request_id: 'restricted',
      serving_account: {
        provider_id: 'openai',
        account: 'key@generation',
        kind: 'api_key',
        label: 'OpenAI work · ••••1234',
      },
      final: { status: 'error', error_reason: 'invalid_request' },
      provider_attempts: [
        {
          alias: 'openai/m',
          status: 'error',
          error_detail: {
            upstream_status: 400,
            provider_raw: { error: { code: 'codex_byok_restricted_by_api_credit_promo' } },
          },
        },
      ],
    });
    render(RoutingSummary, { detail });
    expect(
      screen.getByText('OpenAI blocked Codex usage for OpenAI work · ••••1234.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/OpenAI treated this request as Codex BYOK/)).toBeInTheDocument();
    expect(screen.getByText(/does not show which request detail triggered/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'OpenAI organization billing' })).toHaveAttribute(
      'href',
      'https://platform.openai.com/settings/organization/billing/overview',
    );
  });

  it('explains completed fallback using recorded attempts', () => {
    render(RoutingSummary, { detail: base() });
    expect(
      screen.getByText('An earlier attempt failed; model-b completed the response.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Rate limited')).toBeInTheDocument();
  });
  it.each(['failed', 'incomplete', 'truncated'] as const)(
    'does not present %s streams as completed',
    (stream_outcome) => {
      render(RoutingSummary, { detail: { ...base(), stream_outcome } });
      expect(
        screen.getByText('The response did not complete. Check the execution details below.'),
      ).toBeInTheDocument();
      expect(screen.queryByText(/completed the response/)).not.toBeInTheDocument();
    },
  );
  it('distinguishes a client disconnect from provider failure', () => {
    render(RoutingSummary, { detail: { ...base(), stream_outcome: 'client_aborted' } });
    expect(
      screen.getByText('The client disconnected before the response completed.'),
    ).toBeInTheDocument();
  });
  it('does not invent a reason or completed stream for old records', () => {
    render(RoutingSummary, { detail: toDetail({ request_id: 'old' }) });
    expect(screen.getByText('No completion evidence was recorded.')).toBeInTheDocument();
    expect(screen.queryByText(/completed the response/)).not.toBeInTheDocument();
  });
  it('reports a successful non-streaming record without claiming stream completion', () => {
    render(RoutingSummary, { detail: { ...base(), stream_outcome: null } });
    expect(
      screen.getByText('The request succeeded; stream completion was not recorded.'),
    ).toBeInTheDocument();
  });
  it('keeps classification fallback separate from execution fallback', () => {
    const detail = base();
    detail.provider_attempts = detail.provider_attempts.slice(1);
    detail.classifier_output.decided_by = 'fallback';
    render(RoutingSummary, { detail });
    expect(
      screen.getByText('Classification used the fallback lane: balanced.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/earlier attempt failed/)).not.toBeInTheDocument();
  });
  it('explains pinned continuation without suggesting a different provider', () => {
    render(RoutingSummary, {
      detail: { ...base(), policy_reason: 'stateful Responses continuation' },
    });
    expect(
      screen.getByText('This conversation must continue with the provider holding its state.'),
    ).toBeInTheDocument();
  });
  it.each([
    ['sticky_hit', 'Account team-a was kept for this conversation.'],
    ['hash_assign', 'Account team-a was assigned by session distribution.'],
    ['lru', 'Account team-a was selected by least recent use.'],
    ['strategy', 'Account team-a was selected by Speed first.'],
  ] as const)('explains account selection %s from the stored snapshot', (reason, expected) => {
    const detail = base();
    detail.serving_account = {
      provider_id: 'anthropic',
      account: 'team-a',
      selection: {
        strategy: 'fastest',
        reason,
        captured_at_ms: 1,
        omitted_candidates: 0,
        candidates: [],
      },
    };
    render(RoutingSummary, { detail });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
