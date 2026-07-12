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

  it('uses a relative server TTL despite browser clock skew, slows down, then shows expiry', async () => {
    // The browser is far ahead of the gateway. An absolute expiresAt comparison would
    // incorrectly treat this fresh device code as already expired.
    vi.setSystemTime(1_000_000);
    oauth.startDeviceCode.mockResolvedValue({
      sessionId: 'xai-session',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.x.ai/activate',
      intervalMs: 7_000,
      expiresAt: 30_000,
      serverNowMs: 10_000,
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
    expect(screen.queryByText('Waiting for authorization…')).not.toBeInTheDocument();
    expect(screen.getByText('This device code has expired.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start again' })).toBeInTheDocument();
  });

  it('shows a denied terminal state and lets the operator restart', async () => {
    oauth.startDeviceCode.mockResolvedValue({
      sessionId: 'xai-session',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.x.ai/activate',
      intervalMs: 1_000,
      expiresAt: 70_000,
      serverNowMs: 10_000,
    });
    oauth.pollDeviceCode.mockRejectedValue(
      Object.assign(new Error('localized or changed message'), {
        code: 'device_authorization_denied',
      }),
    );
    render(ConnectProviderDialog, {
      providers: [XAI],
      onconnected: vi.fn(),
      onclose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(screen.queryByText('Waiting for authorization…')).not.toBeInTheDocument();
    expect(screen.getByText('Authorization was denied.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    expect(screen.getByRole('button', { name: 'Start sign-in' })).toBeInTheDocument();
  });

  it('shows a failed terminal state for an unexpected polling error', async () => {
    oauth.startDeviceCode.mockResolvedValue({
      sessionId: 'xai-session',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.x.ai/activate',
      intervalMs: 1_000,
      expiresAt: 70_000,
      serverNowMs: 10_000,
    });
    oauth.pollDeviceCode.mockRejectedValue(new Error('network down'));
    render(ConnectProviderDialog, {
      providers: [XAI],
      onconnected: vi.fn(),
      onclose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(screen.queryByText('Waiting for authorization…')).not.toBeInTheDocument();
    expect(screen.getByText('Authorization failed. Start again to retry.')).toBeInTheDocument();
  });
});
