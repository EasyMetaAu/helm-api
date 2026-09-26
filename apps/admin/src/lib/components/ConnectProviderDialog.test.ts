import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConnectProviderDialog from './ConnectProviderDialog.svelte';

const oauth = vi.hoisted(() => ({
  completeManualPaste: vi.fn(),
  pollDeviceCode: vi.fn(),
  startDeviceCode: vi.fn(),
  startManualPaste: vi.fn(),
}));

vi.mock('$lib/api/oauth.js', () => ({
  completeManualPaste: (...args: unknown[]) => oauth.completeManualPaste(...args),
  pollDeviceCode: (...args: unknown[]) => oauth.pollDeviceCode(...args),
  startDeviceCode: (...args: unknown[]) => oauth.startDeviceCode(...args),
  startManualPaste: (...args: unknown[]) => oauth.startManualPaste(...args),
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
    oauth.startManualPaste.mockReset();
    oauth.completeManualPaste.mockReset();
    vi.spyOn(window, 'open').mockReturnValue(null);
  });

  it('starts the selected account flow immediately for reconnect', async () => {
    oauth.startManualPaste.mockResolvedValue({
      sessionId: 'reconnect-session',
      authorizeUrl: 'https://auth.example/reconnect',
    });
    const onclose = vi.fn();
    render(ConnectProviderDialog, {
      providers: [{ id: 'anthropic', name: 'Claude Max', flow: 'manual_paste', accounts: [] }],
      reconnect: { providerId: 'anthropic', account: 'work' },
      onconnected: vi.fn(),
      onclose,
    });

    await vi.waitFor(() =>
      expect(oauth.startManualPaste).toHaveBeenCalledWith('anthropic', undefined, 'work'),
    );
    await vi.waitFor(() =>
      expect(window.open).toHaveBeenCalledWith(
        'https://auth.example/reconnect',
        '_blank',
        'noopener',
      ),
    );
    expect(
      screen.getByText('A sign-in page opened in a new tab — approve access there.'),
    ).toBeInTheDocument();
    expect(onclose).not.toHaveBeenCalled();
  });

  it('keeps reconnect identity fixed after a failed start', async () => {
    oauth.startManualPaste.mockRejectedValue(new Error('offline'));
    render(ConnectProviderDialog, {
      providers: [{ id: 'anthropic', name: 'Claude Max', flow: 'manual_paste', accounts: [] }],
      reconnect: { providerId: 'anthropic', account: 'work' },
      onconnected: vi.fn(),
      onclose: vi.fn(),
    });
    await vi.waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('offline'));
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    expect(oauth.startManualPaste).toHaveBeenLastCalledWith('anthropic', undefined, 'work');
  });

  it('does not open a late sign-in response after cancellation', async () => {
    let resolveStart!: (value: { sessionId: string; authorizeUrl: string }) => void;
    oauth.startManualPaste.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );
    render(ConnectProviderDialog, {
      providers: [{ id: 'anthropic', name: 'Claude Max', flow: 'manual_paste', accounts: [] }],
      reconnect: { providerId: 'anthropic', account: 'work' },
      onconnected: vi.fn(),
      onclose: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    resolveStart({ sessionId: 'late', authorizeUrl: 'https://auth.example/late' });
    await vi.advanceTimersByTimeAsync(0);
    expect(window.open).not.toHaveBeenCalledWith('https://auth.example/late', '_blank', 'noopener');
  });

  it('completes device reconnect on the original account after approval', async () => {
    oauth.startDeviceCode.mockResolvedValue({
      sessionId: 'device-reconnect',
      userCode: 'ABCD',
      verificationUri: 'https://auth.example/device',
      intervalMs: 1000,
      expiresAt: 70000,
      serverNowMs: 10000,
    });
    oauth.pollDeviceCode.mockResolvedValue({ status: 'done' });
    const onconnected = vi.fn();
    render(ConnectProviderDialog, {
      providers: [XAI],
      reconnect: { providerId: 'xai', account: 'work' },
      onconnected,
      onclose: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(oauth.startDeviceCode).toHaveBeenCalledWith('xai', undefined, undefined, 'work');
    expect(oauth.pollDeviceCode).toHaveBeenCalledWith('xai', {
      sessionId: 'device-reconnect',
      account: 'work',
    });
    expect(onconnected).toHaveBeenCalledOnce();
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
