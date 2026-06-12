import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { TokenUsageView } from '$lib/api/requests.js';
import TokenUsage from './TokenUsage.svelte';

// TokenUsage is the full per-request token breakdown for the detail page (the
// token analogue of CostBreakdown). It renders the six recorded/derived figures;
// a null leaf shows '—' (not measured), distinct from a measured 0. i18n falls
// back to the English key in tests. Read-only — it only formats the mapper output.

function usage(overrides: Partial<TokenUsageView> = {}): TokenUsageView {
  return {
    input: 1200,
    output: 340,
    cached: 800,
    cacheCreation: 64,
    nonCached: 400,
    total: 1540,
    ...overrides,
  };
}

describe('TokenUsage', () => {
  it('renders every recorded/derived figure (formatted)', () => {
    render(TokenUsage, { usage: usage() });
    expect(screen.getByTestId('tokens-input')).toHaveTextContent('1.2K');
    expect(screen.getByTestId('tokens-output')).toHaveTextContent('340');
    expect(screen.getByTestId('tokens-cached')).toHaveTextContent('800');
    expect(screen.getByTestId('tokens-non-cached')).toHaveTextContent('400');
    expect(screen.getByTestId('tokens-cache-write')).toHaveTextContent('64');
    expect(screen.getByTestId('tokens-total')).toHaveTextContent('1.5K');
  });

  it('renders a null (unmeasured) leaf as — , keeping a measured 0 as "0"', () => {
    render(TokenUsage, { usage: usage({ cached: null, output: 0 }) });
    expect(screen.getByTestId('tokens-cached')).toHaveTextContent('—');
    expect(screen.getByTestId('tokens-output')).toHaveTextContent('0');
  });
});
