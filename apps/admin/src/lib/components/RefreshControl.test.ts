import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RefreshControl from './RefreshControl.svelte';

// Split refresh control: the left button refreshes now (calls `onRefresh`), the
// caret opens a menu that picks an auto-refresh cadence. These tests pin the two
// behaviours that carry real logic — the manual click and the timer-driven auto
// refresh (start on select, stop on Off) — plus the active-interval feedback.
// The dropdown markup itself is glue and only lightly asserted.

describe('RefreshControl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes onRefresh once when the Refresh button is clicked', async () => {
    const onRefresh = vi.fn();
    render(RefreshControl, { onRefresh });
    await fireEvent.click(screen.getByTestId('refresh-now'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('opens a menu listing Off and the auto-refresh intervals', async () => {
    render(RefreshControl, { onRefresh: vi.fn() });
    expect(screen.queryByTestId('refresh-menu')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    const menu = screen.getByTestId('refresh-menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByTestId('refresh-interval-off')).toBeInTheDocument();
    // A representative spread of the cadence options (seconds as the key).
    expect(screen.getByTestId('refresh-interval-5')).toHaveTextContent('5s');
    expect(screen.getByTestId('refresh-interval-60')).toHaveTextContent('1m');
    expect(screen.getByTestId('refresh-interval-86400')).toHaveTextContent('1d');
  });

  it('does not auto-refresh until an interval is selected', async () => {
    const onRefresh = vi.fn();
    render(RefreshControl, { onRefresh });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('selecting an interval refreshes on each tick (not immediately)', async () => {
    const onRefresh = vi.fn();
    render(RefreshControl, { onRefresh });
    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    await fireEvent.click(screen.getByTestId('refresh-interval-5'));
    // Selecting the cadence must not fire an immediate refresh.
    expect(onRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(onRefresh).toHaveBeenCalledTimes(2);
  });

  it('surfaces the active cadence and closes the menu after selecting', async () => {
    render(RefreshControl, { onRefresh: vi.fn() });
    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    await fireEvent.click(screen.getByTestId('refresh-interval-30'));
    expect(screen.queryByTestId('refresh-menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('refresh-active')).toHaveTextContent('30s');
  });

  it('selecting Off stops auto-refresh', async () => {
    const onRefresh = vi.fn();
    render(RefreshControl, { onRefresh });
    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    await fireEvent.click(screen.getByTestId('refresh-interval-5'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    await fireEvent.click(screen.getByTestId('refresh-interval-off'));
    expect(screen.queryByTestId('refresh-active')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onRefresh).toHaveBeenCalledTimes(1); // no further ticks
  });

  it('stops the timer when unmounted (no refresh after teardown)', async () => {
    const onRefresh = vi.fn();
    const { unmount } = render(RefreshControl, { onRefresh });
    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    await fireEvent.click(screen.getByTestId('refresh-interval-5'));
    unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onRefresh).not.toHaveBeenCalled();
  });

  // When a storageKey is supplied the chosen cadence survives navigation: it is
  // written to localStorage on every pick and restored (timer resumed) on mount,
  // so leaving for a detail page and coming back keeps auto-refresh running.
  describe('persistence (storageKey)', () => {
    const KEY = 'helm_admin_requests_refresh_interval';

    // jsdom's localStorage is non-functional under the opaque `about:blank`
    // origin this suite runs in (methods are undefined), so install a real
    // in-memory Storage on the global — same approach as github.test.ts.
    beforeEach(() => {
      const map = new Map<string, string>();
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        setItem: (k: string, v: string) => void map.set(k, String(v)),
        removeItem: (k: string) => void map.delete(k),
        clear: () => map.clear(),
        key: (i: number) => [...map.keys()][i] ?? null,
        get length() {
          return map.size;
        },
      } as Storage);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('persists the selected cadence to localStorage', async () => {
      render(RefreshControl, { onRefresh: vi.fn(), storageKey: KEY });
      await fireEvent.click(screen.getByTestId('refresh-toggle'));
      await fireEvent.click(screen.getByTestId('refresh-interval-30'));
      expect(localStorage.getItem(KEY)).toBe('30');
    });

    it('persists Off (0) when auto-refresh is turned off', async () => {
      render(RefreshControl, { onRefresh: vi.fn(), storageKey: KEY });
      await fireEvent.click(screen.getByTestId('refresh-toggle'));
      await fireEvent.click(screen.getByTestId('refresh-interval-30'));
      await fireEvent.click(screen.getByTestId('refresh-toggle'));
      await fireEvent.click(screen.getByTestId('refresh-interval-off'));
      expect(localStorage.getItem(KEY)).toBe('0');
    });

    it('restores the saved cadence on mount and resumes ticking', async () => {
      localStorage.setItem(KEY, '5');
      const onRefresh = vi.fn();
      render(RefreshControl, { onRefresh, storageKey: KEY });
      // Cadence reflected immediately, timer already running.
      expect(screen.getByTestId('refresh-active')).toHaveTextContent('5s');
      await vi.advanceTimersByTimeAsync(5000);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('ignores a corrupt / unknown stored value', async () => {
      localStorage.setItem(KEY, 'not-a-number');
      render(RefreshControl, { onRefresh: vi.fn(), storageKey: KEY });
      expect(screen.queryByTestId('refresh-active')).not.toBeInTheDocument();
    });

    it('does not persist when no storageKey is given', async () => {
      render(RefreshControl, { onRefresh: vi.fn() });
      await fireEvent.click(screen.getByTestId('refresh-toggle'));
      await fireEvent.click(screen.getByTestId('refresh-interval-30'));
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  });
});
