import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiKeyView } from '$lib/api/keys.js';
import EditKeyDialog from './EditKeyDialog.svelte';
const updateKey = vi.fn();
vi.mock('$lib/api/keys.js', () => ({ updateKey: (...args: unknown[]) => updateKey(...args) }));
const key: ApiKeyView = {
  key_id: 'key',
  prefix: 'helm_test',
  role: 'user',
  name: 'Test',
  allowed_lanes: null,
  allow_custom_model: true,
  blocked_models: null,
  allow_fast_mode: false,
  disabled: false,
  client_policy: { allowed_clients: ['codex_app'] },
  rate_limit_rpm: null,
  rate_limit_tpm: null,
  budget_requests: null,
  budget_tokens: null,
  budget_spend_usd: null,
  budget_window_seconds: null,
  over_budget_behavior: 'degrade',
  degrade_lane: null,
  concurrency_limit: null,
  memory_mode: 'off',
  memory_project_id: null,
  memory_thread_source: 'auto',
  request_content_mode: null,
  max_reasoning_effort: null,
};
describe('EditKeyDialog client policy', () => {
  beforeEach(() => {
    updateKey.mockReset();
    updateKey.mockResolvedValue(undefined);
  });
  it('shows an invalid policy as denied and lets the administrator repair it', async () => {
    render(EditKeyDialog, {
      key: { ...key, client_policy: { allowed_clients: [] } },
      lanes: ['balanced'],
      onsaved: vi.fn(),
      onclose: vi.fn(),
    });
    expect(
      screen.getByText('No clients allowed. Select a client or disable the restriction.'),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateKey).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByLabelText('Codex App'));
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateKey).toHaveBeenCalledWith(
        'key',
        expect.objectContaining({ client_policy: { allowed_clients: ['codex_app'] } }),
      ),
    );
  });
  it('preserves the existing policy on an unrelated edit', async () => {
    render(EditKeyDialog, { key, lanes: ['balanced'], onsaved: vi.fn(), onclose: vi.fn() });
    expect(screen.getByLabelText('Restrict clients')).toBeChecked();
    expect(screen.getByLabelText('Codex App')).toBeChecked();
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateKey).toHaveBeenCalledWith(
        'key',
        expect.objectContaining({
          client_policy: { allowed_clients: ['codex_app'] },
          allow_custom_model: true,
          blocked_models: null,
        }),
      ),
    );
  });
  it('rejects an empty selection and clears the policy only when disabled', async () => {
    render(EditKeyDialog, { key, lanes: ['balanced'], onsaved: vi.fn(), onclose: vi.fn() });
    await fireEvent.click(screen.getByLabelText('Codex App'));
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(updateKey).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByLabelText('Restrict clients'));
    await fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(updateKey).toHaveBeenCalledWith(
        'key',
        expect.objectContaining({ client_policy: null }),
      ),
    );
  });
});
