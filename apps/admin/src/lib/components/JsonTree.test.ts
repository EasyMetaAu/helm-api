import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import JsonTree from './JsonTree.svelte';

// JsonTree is the recursive node of the collapsible JSON viewer (ported from
// llm-router's vanilla-JS detail view). It renders one value with an optional key
// label: scalars inline, objects/arrays as native <details> open to DEFAULT_DEPTH=2,
// children lazily rendered on open and paginated at VISIBLE_LIMIT=200. Long strings
// (>512 chars) clip with an Expand toggle. i18n falls back to the English key in
// tests (messages store is empty), so we assert on English strings.

describe('JsonTree', () => {
  it('renders a scalar with its key label and JSON-quoted string value', () => {
    render(JsonTree, { value: 'hello', name: 'greeting' });
    expect(screen.getByText(/greeting/)).toBeInTheDocument();
    // strings are shown JSON-quoted
    expect(screen.getByText('"hello"')).toBeInTheDocument();
  });

  it('shows Object(n) / Array(n) entry counts in the summary', () => {
    render(JsonTree, { value: { a: 1, b: 2, c: 3 } });
    expect(screen.getByText(/Object\(3\)/)).toBeInTheDocument();
  });

  it('labels array entries by index and shows their values', () => {
    render(JsonTree, { value: ['x', 'y'] });
    expect(screen.getByText(/Array\(2\)/)).toBeInTheDocument();
    expect(screen.getByText('"x"')).toBeInTheDocument();
    expect(screen.getByText('"y"')).toBeInTheDocument();
  });

  it('opens to depth 2 by default and collapses deeper levels (lazy)', () => {
    // depth0 root (open) -> a depth1 (open) -> b depth2 (closed) -> c not rendered
    render(JsonTree, { value: { a: { b: { c: 1 } } } });
    expect(screen.getByText(/a:/)).toBeInTheDocument();
    expect(screen.getByText(/b:/)).toBeInTheDocument();
    // c lives under a depth-2 closed node, so it is not in the DOM yet
    expect(screen.queryByText(/c:/)).not.toBeInTheDocument();
  });

  it('clips a long string and reveals the full text via the Expand toggle', async () => {
    const long = `${'a'.repeat(520)}NEEDLE`;
    render(JsonTree, { value: long, name: 'blob' });
    // clipped form ends with an ellipsis and hides the tail marker
    expect(screen.queryByText(/NEEDLE/)).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: /Expand/i }));
    expect(screen.getByText(/NEEDLE/)).toBeInTheDocument();
  });

  it('allows long scalar strings to wrap instead of forcing horizontal scroll', async () => {
    const long = `${'a'.repeat(520)}NEEDLE`;
    render(JsonTree, { value: long, name: 'blob' });
    await fireEvent.click(screen.getByRole('button', { name: /Expand/i }));
    const scalar = screen.getByText(/NEEDLE/);
    expect(scalar.className).toContain('whitespace-pre-wrap');
    expect(scalar.className).toContain('[overflow-wrap:anywhere]');
  });

  it('offers a Preview affordance for a multi-line string (even when short)', () => {
    render(JsonTree, { value: 'first line\nsecond line', name: 'content' });
    // Short enough that there is no inline Expand toggle, but multi-line — so the
    // roomy decoded Preview is what makes it readable.
    expect(screen.queryByRole('button', { name: /Expand/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('text-preview-open')).toBeInTheDocument();
  });

  it('does not offer Preview for a plain short single-line string', () => {
    render(JsonTree, { value: 'hello', name: 'greeting' });
    expect(screen.queryByTestId('text-preview-open')).not.toBeInTheDocument();
  });

  it('paginates large arrays at 200 entries with a "show remaining" control', async () => {
    const big = Array.from({ length: 250 }, (_, i) => i);
    render(JsonTree, { value: big });
    // root node + 200 rendered children
    expect(screen.getAllByTestId('json-node')).toHaveLength(201);
    const more = screen.getByRole('button', { name: /Show remaining 50 items/ });
    await fireEvent.click(more);
    expect(screen.getAllByTestId('json-node')).toHaveLength(251);
    expect(screen.queryByRole('button', { name: /Show remaining/ })).not.toBeInTheDocument();
  });
});
