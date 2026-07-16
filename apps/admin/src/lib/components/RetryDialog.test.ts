import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import RetryDialog from './RetryDialog.svelte';

// The replay endpoint runs the WHOLE upstream call server-side before returning
// the new trace id — a long completion means the dialog waits 30s+. These tests
// pin the waiting-state contract: visible live progress (ticking elapsed counter
// + explanatory note) so the wait never reads as a hang, a Cancel that actually
// aborts the in-flight replay (the fetch signal propagates to the gateway, which
// aborts the upstream run), and a locked body so the operator can't desync the
// editor from what was sent.

const replayRequest = vi.fn();
vi.mock('$lib/api/requests.js', () => ({
  replayRequest: (...args: unknown[]) => replayRequest(...args),
}));

const BODY = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

function setup() {
  const onclose = vi.fn();
  render(RetryDialog, { requestId: 'req_orig', initialRequest: BODY, onclose });
  return { onclose };
}

function sendButton(): HTMLElement {
  return screen.getByTestId('retry-send');
}

// A replay that stays pending until the test resolves/rejects it explicitly.
function pendingReplay() {
  let resolve!: (v: { trace_id: string }) => void;
  let reject!: (e: unknown) => void;
  replayRequest.mockImplementation(
    (_trace: string, _body: unknown, signal?: AbortSignal) =>
      new Promise<{ trace_id: string }>((res, rej) => {
        resolve = res;
        reject = rej;
        // Mirror fetch: an aborted signal rejects with a DOMException AbortError.
        signal?.addEventListener('abort', () =>
          rej(new DOMException('The operation was aborted.', 'AbortError')),
        );
      }),
  );
  return { resolve: () => resolve({ trace_id: 'tr_new' }), reject: (e: unknown) => reject(e) };
}

describe('RetryDialog sending state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    replayRequest.mockReset();
    vi.mocked(goto).mockReset();
    vi.mocked(goto).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a ticking elapsed counter and a progress note while the replay is in flight', async () => {
    pendingReplay();
    setup();
    await fireEvent.click(sendButton());

    // The explanatory note is announced (aria-live) so the wait is self-describing.
    const note = screen.getByTestId('retry-progress');
    expect(note).toBeInTheDocument();

    // The counter ticks: 0ms -> 3s proves the UI is alive, not frozen.
    expect(sendButton().textContent).toContain('0ms');
    vi.advanceTimersByTime(3000);
    await tick();
    expect(sendButton().textContent).toContain('3s');

    vi.advanceTimersByTime(57_000);
    await tick();
    expect(sendButton().textContent).toContain('1min');
  });

  it('locks the body editor while sending and unlocks it on failure', async () => {
    const replay = pendingReplay();
    setup();
    const editor = screen.getByTestId('retry-body') as HTMLTextAreaElement;
    await fireEvent.click(sendButton());
    expect(editor).toHaveAttribute('readonly');

    replay.reject(new Error('upstream exploded'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('upstream exploded'));
    expect(editor).not.toHaveAttribute('readonly');
  });

  it('keeps Cancel enabled while sending; clicking it aborts the replay and restores editing', async () => {
    pendingReplay();
    const { onclose } = setup();
    await fireEvent.click(sendButton());

    const cancel = screen.getByTestId('retry-cancel');
    expect(cancel).toBeEnabled();
    await fireEvent.click(cancel);

    // The fetch signal must have been aborted (the gateway aborts the upstream run).
    const signal = replayRequest.mock.calls[0][2] as AbortSignal;
    expect(signal.aborted).toBe(true);

    // Abort is the operator's own action: NO error alert, dialog stays open for
    // another edit/send, body unlocked.
    await waitFor(() => expect(screen.getByTestId('retry-body')).not.toHaveAttribute('readonly'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onclose).not.toHaveBeenCalled();

    // A second click of Cancel (now idle) closes the dialog as before.
    await fireEvent.click(screen.getByTestId('retry-cancel'));
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('navigates to the new trace on success', async () => {
    const replay = pendingReplay();
    setup();
    await fireEvent.click(sendButton());
    replay.resolve();
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/requests/tr_new'));
  });

  it('surfaces invalid JSON immediately without calling the API', async () => {
    setup();
    const editor = screen.getByTestId('retry-body');
    await fireEvent.input(editor, { target: { value: '{ not json' } });
    await fireEvent.click(sendButton());
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(replayRequest).not.toHaveBeenCalled();
  });
});
