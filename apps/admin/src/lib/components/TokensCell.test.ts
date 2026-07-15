import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { TokenUsageView } from '$lib/api/requests.js';
import TokensCell from './TokensCell.svelte';

// TokensCell is the compact per-request token cell for the list views. It renders
// the recorded usage as two headline numbers (↑ input / ↓ output) + a cached
// sub-line, and collapses to a single '—' when nothing was measured. i18n falls
// back to the English key in tests, so we assert English. Read-only — it only
// formats the figures the mapper produced.

function usage(overrides: Partial<TokenUsageView> = {}): TokenUsageView {
  return {
    measurement: 'reported',
    input: 1200,
    output: 340,
    cached: 800,
    cacheCreation: 64,
    nonCached: 400,
    total: 1540,
    ...overrides,
  };
}

describe('TokensCell', () => {
  it('renders the input/output headline (formatted) and the cached sub-line', () => {
    render(TokensCell, { usage: usage() });
    expect(screen.getByTestId('tokens-input')).toHaveTextContent('↑ 1.2K');
    expect(screen.getByTestId('tokens-output')).toHaveTextContent('↓ 340');
    expect(screen.getByTestId('tokens-cached')).toHaveTextContent('800');
  });

  it('exposes the full breakdown (incl. non-cached) on the hover title', () => {
    render(TokensCell, { usage: usage() });
    const tip = screen.getByTestId('tokens-cell').getAttribute('title') ?? '';
    expect(tip).toContain('1.2K'); // input
    expect(tip).toContain('340'); // output
    expect(tip).toContain('800'); // cached
    expect(tip).toContain('400'); // non-cached
  });

  it('collapses to a single — when no token usage was measured (every leaf null)', () => {
    render(TokensCell, {
      usage: usage({
        input: null,
        output: null,
        cached: null,
        cacheCreation: null,
        nonCached: null,
        total: null,
      }),
    });
    expect(screen.getByTestId('tokens-cell')).toHaveTextContent('—');
    expect(screen.queryByTestId('tokens-input')).not.toBeInTheDocument();
  });

  it('renders a measured 0 as "0" (distinct from the unmeasured —)', () => {
    render(TokensCell, { usage: usage({ output: 0 }) });
    expect(screen.getByTestId('tokens-output')).toHaveTextContent('↓ 0');
  });

  it('marks estimated counts from a partial stream instead of presenting them as exact', () => {
    render(TokensCell, { usage: usage({ measurement: 'estimated_partial' }) });
    expect(screen.getByTestId('usage-measurement')).toHaveTextContent(/estimated/i);
    expect(screen.getByTestId('tokens-cell')).toHaveAttribute(
      'title',
      expect.stringMatching(/partial stream/i),
    );
  });
});
