import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RefreshControl from './RefreshControl.svelte';

const SHARED_KEY = 'helm_admin_refresh_interval';
const LEGACY_HOME_KEY = 'helm_admin_home_refresh_interval';

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

  it('pauses auto-refresh while the document is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const onRefresh = vi.fn();
    render(RefreshControl, { onRefresh });
    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    await fireEvent.click(screen.getByTestId('refresh-interval-5'));

    await vi.advanceTimersByTimeAsync(15_000);
    expect(onRefresh).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(onRefresh).toHaveBeenCalledOnce();
    visibility.mockRestore();
  });

  it('can keep manual refresh separate from cache-only auto refresh', async () => {
    const onRefresh = vi.fn();
    const onAutoRefresh = vi.fn();
    render(RefreshControl, { onRefresh, onAutoRefresh });

    await fireEvent.click(screen.getByTestId('refresh-now'));
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onAutoRefresh).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByTestId('refresh-toggle'));
    await fireEvent.click(screen.getByTestId('refresh-interval-5'));
    await vi.advanceTimersByTimeAsync(5000);

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(onAutoRefresh).toHaveBeenCalledOnce();
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

  // The chosen cadence is a single admin-wide preference. It is written to
  // localStorage on every pick, restored (timer resumed) on mount, and broadcast
  // to other mounted controls so home/requests/providers/memory never diverge.
  describe('shared persistence', () => {
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
      render(RefreshControl, { onRefresh: vi.fn() });
      await fireEvent.click(screen.getByTestId('refresh-toggle'));
      await fireEvent.click(screen.getByTestId('refresh-interval-30'));
      expect(localStorage.getItem(SHARED_KEY)).toBe('30');
    });

    it('persists Off (0) when auto-refresh is turned off', async () => {
      render(RefreshControl, { onRefresh: vi.fn() });
      await fireEvent.click(screen.getByTestId('refresh-toggle'));
      await fireEvent.click(screen.getByTestId('refresh-interval-30'));
      await fireEvent.click(screen.getByTestId('refresh-toggle'));
      await fireEvent.click(screen.getByTestId('refresh-interval-off'));
      expect(localStorage.getItem(SHARED_KEY)).toBe('0');
    });

    it('restores the saved cadence on mount and resumes ticking', async () => {
      localStorage.setItem(SHARED_KEY, '5');
      const onRefresh = vi.fn();
      render(RefreshControl, { onRefresh });
      // Cadence reflected immediately, timer already running.
      expect(screen.getByTestId('refresh-active')).toHaveTextContent('5s');
      await vi.advanceTimersByTimeAsync(5000);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('migrates a legacy page-specific cadence to the shared key', async () => {
      localStorage.setItem(LEGACY_HOME_KEY, '5');
      const onRefresh = vi.fn();
      render(RefreshControl, { onRefresh });
      expect(screen.getByTestId('refresh-active')).toHaveTextContent('5s');
      expect(localStorage.getItem(SHARED_KEY)).toBe('5');
      await vi.advanceTimersByTimeAsync(5000);
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('syncs all mounted controls when one cadence changes', async () => {
      const firstRefresh = vi.fn();
      const secondRefresh = vi.fn();
      const first = render(RefreshControl, { onRefresh: firstRefresh });
      const second = render(RefreshControl, { onRefresh: secondRefresh });
      const firstUi = within(first.container);
      const secondUi = within(second.container);

      await fireEvent.click(firstUi.getByTestId('refresh-toggle'));
      await fireEvent.click(firstUi.getByTestId('refresh-interval-5'));

      expect(firstUi.getByTestId('refresh-active')).toHaveTextContent('5s');
      expect(secondUi.getByTestId('refresh-active')).toHaveTextContent('5s');
      expect(localStorage.getItem(SHARED_KEY)).toBe('5');

      await vi.advanceTimersByTimeAsync(5000);
      expect(firstRefresh).toHaveBeenCalledTimes(1);
      expect(secondRefresh).toHaveBeenCalledTimes(1);
    });

    it('ignores a corrupt / unknown stored value', async () => {
      localStorage.setItem(SHARED_KEY, 'not-a-number');
      render(RefreshControl, { onRefresh: vi.fn() });
      expect(screen.queryByTestId('refresh-active')).not.toBeInTheDocument();
    });
  });
});
