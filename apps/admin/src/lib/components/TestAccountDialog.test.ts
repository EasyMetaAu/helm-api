import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import TestAccountDialog from './TestAccountDialog.svelte';

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

vi.mock('$lib/api/oauth.js', () => ({
  streamAccountTest: async function* () {
    yield {
      type: 'error',
      error: `codex responses stream error: ${'x'.repeat(200)}`,
    };
  },
}));

describe('TestAccountDialog', () => {
  it('wraps long upstream errors inside the modal', async () => {
    render(TestAccountDialog, {
      provider: 'openai-codex',
      providerName: 'ChatGPT Plus/Pro (Codex)',
      account: 'account@example.com',
      models: ['gpt-5.6-sol'],
      onclose: vi.fn(),
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Run test' }));

    expect(await screen.findByRole('alert')).toHaveClass('[overflow-wrap:anywhere]');
  });
});
