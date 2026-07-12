import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectProviderDialog from './ConnectProviderDialog.svelte';

const oauth = vi.hoisted(() => ({
  pollDeviceCode: vi.fn(),
  startDeviceCode: vi.fn(),
}));

vi.mock('$lib/api/oauth.js', () => ({
  completeManualPaste: vi.fn(),
  pollDeviceCode: (...args: unknown[]) => oauth.pollDeviceCode(...args),
  startDeviceCode: (...args: unknown[]) => oauth.startDeviceCode(...args),
  startManualPaste: vi.fn(),
}));

const XAI = {
  id: 'xai',
  name: 'xAI / SuperGrok',
  flow: 'device_code' as const,
  accounts: [],
};

describe('ConnectProviderDialog device-code polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    oauth.pollDeviceCode.mockReset();
    oauth.startDeviceCode.mockReset();
    vi.spyOn(window, 'open').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses the server interval, adds five seconds on slow_down, and stops at expiry', async () => {
    oauth.startDeviceCode.mockResolvedValue({
      sessionId: 'xai-session',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.x.ai/activate',
      intervalMs: 7_000,
      expiresAt: 30_000,
    });
    oauth.pollDeviceCode.mockResolvedValueOnce({ status: 'slow_down' }).mockResolvedValue({
      status: 'pending',
    });
    render(ConnectProviderDialog, {
      providers: [XAI],
      onconnected: vi.fn(),
      onclose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(6_999);
    expect(oauth.pollDeviceCode).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(oauth.pollDeviceCode).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(11_999);
    expect(oauth.pollDeviceCode).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(oauth.pollDeviceCode).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(oauth.pollDeviceCode).toHaveBeenCalledTimes(2);
  });
});
