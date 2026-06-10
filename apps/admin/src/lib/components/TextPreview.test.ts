import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TextPreview from './TextPreview.svelte';

// TextPreview is the "read it like text" affordance for the JSON tree: string
// values are shown JSON-escaped there (real newlines become the literal two
// chars `\n`), which is unreadable for system prompts. This opens a roomy modal
// rendering the DECODED text with real line breaks, plus a one-click copy.
// i18n falls back to the English key in tests (messages store empty), so we
// assert on English strings.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TextPreview', () => {
  it('renders a Preview button and keeps the modal closed initially', () => {
    render(TextPreview, { text: 'line one\nline two' });
    expect(screen.getByTestId('text-preview-open')).toBeInTheDocument();
    expect(screen.queryByTestId('text-preview-body')).not.toBeInTheDocument();
  });

  it('opens a modal whose body holds the DECODED multi-line text', async () => {
    render(TextPreview, { text: 'line one\nline two' });
    await fireEvent.click(screen.getByTestId('text-preview-open'));
    const body = screen.getByTestId('text-preview-body');
    // The raw string is rendered verbatim — a real newline, not the chars `\n`.
    expect(body.textContent).toBe('line one\nline two');
    expect(body.textContent).not.toContain('\\n');
    expect(body.className).toContain('whitespace-pre-wrap');
  });

  it('uses a wide modal panel for comfortable reading', async () => {
    render(TextPreview, { text: 'a\nb' });
    await fireEvent.click(screen.getByTestId('text-preview-open'));
    expect(screen.getByRole('dialog').className).toContain('max-w-3xl');
  });

  it('copies the raw text and flips the label to Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(TextPreview, { text: 'alpha\nbeta' });
    await fireEvent.click(screen.getByTestId('text-preview-open'));
    await fireEvent.click(screen.getByRole('button', { name: /Copy/i }));
    expect(writeText).toHaveBeenCalledWith('alpha\nbeta');
    expect(await screen.findByRole('button', { name: /Copied/i })).toBeInTheDocument();
  });

  it('dismisses the modal via the Close button', async () => {
    render(TextPreview, { text: 'x\ny' });
    await fireEvent.click(screen.getByTestId('text-preview-open'));
    expect(screen.getByTestId('text-preview-body')).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('text-preview-close'));
    expect(screen.queryByTestId('text-preview-body')).not.toBeInTheDocument();
  });

  it('shows the label as the modal title when provided', async () => {
    render(TextPreview, { text: 'a\nb', label: 'content' });
    await fireEvent.click(screen.getByTestId('text-preview-open'));
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'content');
  });
});
