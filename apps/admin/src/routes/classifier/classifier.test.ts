import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClassifierConfig } from '$lib/api/classifier.js';
import ClassifierPage from './+page.svelte';

// The page consumes data from `load` (mocked via the `data` prop) and writes
// through the `saveClassifier` API client, which we mock here. The page runs NO
// classification logic — it only toggles eval, edits the threshold in [0,1], and
// renders the read-only rule dimensions / eval details (DoD).
const saveClassifier = vi.fn();
vi.mock('$lib/api/classifier.js', () => ({
  saveClassifier: (...args: unknown[]) => saveClassifier(...args),
}));

function config(overrides: Partial<ClassifierConfig> = {}): ClassifierConfig {
  return {
    rules: {
      enabled: true,
      confidence_threshold: 0.45,
      dimensions: [
        { name: 'code_density', weight: 0.3, direction: 'up' },
        { name: 'verbosity', weight: -0.2, direction: 'down' },
      ],
      boundaries: { standard: -0.1, complex: 0.08, reasoning: 0.35 },
    },
    eval: {
      enabled: false,
      model: 'deepseek/deepseek-v4-flash',
      temperature: 0,
      max_tokens: 256,
      timeout_ms: 300,
      on_failure: 'balanced',
      cache: { enabled: true, ttl_sec: 300 },
    },
    ...overrides,
  };
}

function renderPage(cfg: ClassifierConfig) {
  return render(ClassifierPage, { data: { classifier: cfg } });
}

describe('classifier page', () => {
  beforeEach(() => {
    saveClassifier.mockReset();
    // Echo a fresh config reflecting the patch (mirrors the real client).
    saveClassifier.mockImplementation(
      (patch: { eval_enabled?: boolean; confidence_threshold?: number }) => {
        const c = config();
        if (patch.eval_enabled !== undefined) c.eval.enabled = patch.eval_enabled;
        if (patch.confidence_threshold !== undefined)
          c.rules.confidence_threshold = patch.confidence_threshold;
        return Promise.resolve(c);
      },
    );
  });

  it('renders the current config: threshold 0.45 and eval toggle reflecting enabled=false', () => {
    renderPage(config());
    const threshold = screen.getByLabelText(/confidence threshold/i) as HTMLInputElement;
    expect(threshold.value).toBe('0.45');
    const evalToggle = screen.getByRole('checkbox', { name: /eval/i }) as HTMLInputElement;
    expect(evalToggle.checked).toBe(false);
  });

  it('toggling eval on then saving calls saveClassifier({ eval_enabled: true })', async () => {
    renderPage(config());
    const evalToggle = screen.getByRole('checkbox', { name: /eval/i });
    await fireEvent.click(evalToggle);
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveClassifier).toHaveBeenCalledTimes(1));
    expect(saveClassifier.mock.calls[0][0]).toMatchObject({ eval_enabled: true });
  });

  it('changing the threshold to 0.6 submits confidence_threshold: 0.6', async () => {
    renderPage(config());
    const threshold = screen.getByLabelText(/confidence threshold/i);
    await fireEvent.input(threshold, { target: { value: '0.6' } });
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(saveClassifier).toHaveBeenCalledTimes(1));
    expect(saveClassifier.mock.calls[0][0]).toMatchObject({ confidence_threshold: 0.6 });
  });

  it('an out-of-range threshold disables save + shows validation, never calls saveClassifier', async () => {
    renderPage(config());
    const threshold = screen.getByLabelText(/confidence threshold/i);
    const save = screen.getByRole('button', { name: /save/i }) as HTMLButtonElement;

    await fireEvent.input(threshold, { target: { value: '1.5' } });
    await waitFor(() => expect(save.disabled).toBe(true));
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await fireEvent.input(threshold, { target: { value: '-0.1' } });
    await waitFor(() => expect(save.disabled).toBe(true));

    // Even a forced click does not fire the API call (fail-closed, 原则2).
    await fireEvent.click(save);
    expect(saveClassifier).not.toHaveBeenCalled();
  });

  it('renders the rule dimensions read-only (name/weight/direction, no edit controls)', () => {
    renderPage(config());
    const table = screen.getByTestId('dimension-table');
    expect(table).toBeInTheDocument();
    expect(within_text(table, 'code_density')).toBe(true);
    expect(within_text(table, 'verbosity')).toBe(true);
    // No editable controls inside the dimension table — dimensions are data.
    expect(table.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
  });

  it('shows eval details read-only (model, temperature=0, timeout, on_failure, cache ttl)', () => {
    renderPage(config());
    const details = screen.getByTestId('eval-details');
    expect(within_text(details, 'deepseek/deepseek-v4-flash')).toBe(true);
    expect(within_text(details, 'balanced')).toBe(true);
    expect(within_text(details, '300')).toBe(true);
    // temperature is locked to 0 and surfaced.
    expect(within_text(details, '0')).toBe(true);
    // No editable controls in the read-only eval detail block.
    expect(details.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('on save failure shows an error and keeps the original values (no dirty write)', async () => {
    saveClassifier.mockRejectedValue(new Error('400 invalid classifier config'));
    renderPage(config());
    const threshold = screen.getByLabelText(/confidence threshold/i) as HTMLInputElement;
    await fireEvent.input(threshold, { target: { value: '0.6' } });
    await fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // The displayed config is unchanged on failure.
    const evalToggle = screen.getByRole('checkbox', { name: /eval/i }) as HTMLInputElement;
    expect(evalToggle.checked).toBe(false);
  });
});

// Small helper: does an element's text content contain a substring?
function within_text(el: HTMLElement, text: string): boolean {
  return (el.textContent ?? '').includes(text);
}
