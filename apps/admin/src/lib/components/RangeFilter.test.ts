import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import RangeFilter from './RangeFilter.svelte';

// Presentational + stateless: it renders the preset row, marks the active one, and
// reports clicks via onChange. i18n is untouched (the `t` store returns the English
// key when no dict is loaded, so 'All' renders as "All").

describe('RangeFilter', () => {
  it('renders all six presets in order', () => {
    render(RangeFilter, { props: { value: '24h', onChange: vi.fn() } });
    for (const key of ['1h', '6h', '24h', '7d', '30d', 'all']) {
      expect(screen.getByTestId(`range-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('range-all')).toHaveTextContent('All');
  });

  it('marks only the active preset as pressed', () => {
    render(RangeFilter, { props: { value: '7d', onChange: vi.fn() } });
    expect(screen.getByTestId('range-7d').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('range-24h').getAttribute('aria-pressed')).toBe('false');
  });

  it('calls onChange with the clicked preset key', async () => {
    const onChange = vi.fn();
    render(RangeFilter, { props: { value: 'all', onChange } });
    await fireEvent.click(screen.getByTestId('range-6h'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('6h');
  });
});
