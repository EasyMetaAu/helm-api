import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import JsonViewer from './JsonViewer.svelte';

// JsonViewer wraps JsonTree with three tabs — Tree (default) / Formatted / Raw —
// mirroring llm-router's per-panel viewer. It normalizes a `value` that may be a
// parsed object/array OR a raw string (captured request/response bodies are
// `unknown`): a JSON string is parsed; a non-JSON string is shown verbatim.
// i18n falls back to the English key in tests.

describe('JsonViewer', () => {
  it('defaults to the Tree tab and hides Formatted/Raw panels', () => {
    render(JsonViewer, { value: { model: 'auto', max_tokens: 64 } });
    expect(screen.getByTestId('jsonviewer-tree')).toBeVisible();
    expect(screen.getByTestId('jsonviewer-formatted')).not.toBeVisible();
    expect(screen.getByTestId('jsonviewer-raw')).not.toBeVisible();
    // tree content is present
    expect(screen.getByText(/model:/)).toBeInTheDocument();
  });

  it('switches to the Formatted tab showing indented JSON', async () => {
    render(JsonViewer, { value: { ok: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Formatted/i }));
    const formatted = screen.getByTestId('jsonviewer-formatted');
    expect(formatted).toBeVisible();
    expect(formatted.textContent).toContain('{\n  "ok": true\n}');
  });

  it('switches to the Raw tab', async () => {
    render(JsonViewer, { value: { ok: true } });
    await fireEvent.click(screen.getByRole('button', { name: /Raw/i }));
    expect(screen.getByTestId('jsonviewer-raw')).toBeVisible();
    expect(screen.getByTestId('jsonviewer-tree')).not.toBeVisible();
  });

  it('parses a JSON string value into the tree', () => {
    render(JsonViewer, { value: '{"ok":true}' });
    expect(screen.getByText(/ok:/)).toBeInTheDocument();
  });

  it('shows a non-JSON string verbatim instead of failing', async () => {
    render(JsonViewer, { value: 'event: ping\ndata: {' });
    // tree renders the unpar-seable string as a scalar leaf
    expect(screen.getByTestId('jsonviewer-tree')).toHaveTextContent('event: ping');
    await fireEvent.click(screen.getByRole('button', { name: /Raw/i }));
    expect(screen.getByTestId('jsonviewer-raw')).toHaveTextContent('event: ping');
  });

  it('renders placeholders for empty / null values', () => {
    expect(render(JsonViewer, { value: {} }).getByText('(empty object)')).toBeInTheDocument();
    expect(render(JsonViewer, { value: [] }).getByText('(empty array)')).toBeInTheDocument();
    expect(render(JsonViewer, { value: null }).getByText('(null)')).toBeInTheDocument();
  });

  it('passes a testid through to its root for e2e selectors', () => {
    render(JsonViewer, { value: { ok: true }, testid: 'request-body' });
    expect(screen.getByTestId('request-body')).toBeInTheDocument();
  });

  it('wraps formatted/raw JSON panels without horizontal scrolling', async () => {
    render(JsonViewer, { value: { prompt: 'x'.repeat(1200) } });

    await fireEvent.click(screen.getByRole('button', { name: /Formatted/i }));
    const formatted = screen.getByTestId('jsonviewer-formatted');
    expect(formatted.className).toContain('overflow-x-hidden');
    expect(formatted.className).toContain('whitespace-pre-wrap');
    expect(formatted.className).toContain('[overflow-wrap:anywhere]');

    await fireEvent.click(screen.getByRole('button', { name: /Raw/i }));
    const raw = screen.getByTestId('jsonviewer-raw');
    expect(raw.className).toContain('overflow-x-hidden');
    expect(raw.className).toContain('whitespace-pre-wrap');
    expect(raw.className).toContain('[overflow-wrap:anywhere]');
  });
});
