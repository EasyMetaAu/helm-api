import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import RangeFilter from './RangeFilter.svelte';

// Presentational + stateless: it renders the calendar-day preset row, marks the
// active one, and reports clicks via onChange. i18n is untouched (the `t` store
// returns the English key when no dict is loaded, so 'Today'/'All' render as-is).

describe('RangeFilter', () => {
  it('renders the calendar-day presets in order', () => {
    render(RangeFilter, { props: { value: 'today', onChange: vi.fn() } });
    for (const key of ['today', 'yesterday', '7d', '30d', 'all']) {
      expect(screen.getByTestId(`range-${key}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('range-today')).toHaveTextContent('Today');
    expect(screen.getByTestId('range-all')).toHaveTextContent('All');
  });

  it('marks only the active preset as pressed', () => {
    render(RangeFilter, { props: { value: '7d', onChange: vi.fn() } });
    expect(screen.getByTestId('range-7d').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('range-today').getAttribute('aria-pressed')).toBe('false');
  });

  it('calls onChange with the clicked preset key', async () => {
    const onChange = vi.fn();
    render(RangeFilter, { props: { value: 'all', onChange } });
    await fireEvent.click(screen.getByTestId('range-yesterday'));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('yesterday');
  });
});
