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

  it('does not preserve template whitespace in the Tree panel', () => {
    render(JsonViewer, { value: { input: [{ role: 'user', content: 'hi' }] } });
    const tree = screen.getByTestId('jsonviewer-tree');
    expect(tree.className).toContain('whitespace-normal');
    expect(tree.className).not.toContain('whitespace-pre-wrap');
  });

  it('reveals every nested node when Expand all is clicked', async () => {
    // Default depth opens to 2, so `c` (depth 3, under a closed depth-2 node) is
    // not in the DOM. Expand all must cascade through the lazily-rendered children.
    render(JsonViewer, { value: { a: { b: { c: 1 } } } });
    expect(screen.queryByText(/c:/)).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Expand all/i }));
    expect(screen.getByText(/c:/)).toBeInTheDocument();
  });

  it('folds descendants but keeps the root open on Collapse all', async () => {
    render(JsonViewer, { value: { a: { b: { c: 1 } } } });
    // expand everything first so the deep nodes are in the DOM
    await fireEvent.click(screen.getByRole('button', { name: /Expand all/i }));
    expect(screen.getByText(/c:/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Collapse all/i }));
    // the root stays open, so its direct children are still visible...
    expect(screen.getByText(/a:/)).toBeInTheDocument();
    // ...but everything below the root is folded away
    expect(screen.queryByText(/b:/)).not.toBeInTheDocument();
  });

  it('re-expands after a collapse all (broadcast nonce re-fires)', async () => {
    render(JsonViewer, { value: { a: { b: { c: 1 } } } });
    await fireEvent.click(screen.getByRole('button', { name: /Collapse all/i }));
    // root stays open (a visible) but its subtree is collapsed (b hidden)
    expect(screen.getByText(/a:/)).toBeInTheDocument();
    expect(screen.queryByText(/b:/)).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Expand all/i }));
    expect(screen.getByText(/c:/)).toBeInTheDocument();
  });

  it('hides the expand/collapse controls when there is no collapsible tree', () => {
    // a bare scalar string has no nested structure to expand
    render(JsonViewer, { value: 'just text' });
    expect(screen.queryByRole('button', { name: /Expand all/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Collapse all/i })).not.toBeInTheDocument();
  });

  it('only shows the expand/collapse controls on the Tree tab', async () => {
    render(JsonViewer, { value: { a: 1 } });
    expect(screen.getByRole('button', { name: /Expand all/i })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Raw/i }));
    expect(screen.queryByRole('button', { name: /Expand all/i })).not.toBeInTheDocument();
  });

  it('makes the panels vertically resizable by default', () => {
    render(JsonViewer, { value: { a: 1 } });
    expect(screen.getByTestId('jsonviewer-tree').className).toContain('resize-y');
  });

  it('always offers a fullscreen toggle, even for a bare scalar', () => {
    render(JsonViewer, { value: 'just text' });
    expect(screen.getByTestId('jsonviewer-fullscreen')).toBeInTheDocument();
  });

  it('toggles a fullscreen container on the root and fills it with the panel', async () => {
    render(JsonViewer, { value: { a: 1 }, testid: 'jv' });
    const root = screen.getByTestId('jv');
    expect(root.className).not.toContain('fixed');

    await fireEvent.click(screen.getByTestId('jsonviewer-fullscreen'));
    expect(root.className).toContain('fixed');
    expect(root.className).toContain('inset-0');
    // active panel grows to fill the screen instead of staying capped/resizable
    const tree = screen.getByTestId('jsonviewer-tree');
    expect(tree.className).toContain('flex-1');
    expect(tree.className).not.toContain('resize-y');

    await fireEvent.click(screen.getByTestId('jsonviewer-fullscreen'));
    expect(root.className).not.toContain('fixed');
  });

  it('exits fullscreen on Escape', async () => {
    render(JsonViewer, { value: { a: 1 }, testid: 'jv' });
    await fireEvent.click(screen.getByTestId('jsonviewer-fullscreen'));
    expect(screen.getByTestId('jv').className).toContain('fixed');
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('jv').className).not.toContain('fixed');
  });
});
