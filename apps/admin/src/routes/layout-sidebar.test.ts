import { createRawSnippet } from 'svelte';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Layout from './+layout.svelte';

const children = createRawSnippet(() => ({ render: () => '<p>Page content</p>' }));

describe('admin sidebar', () => {
  it('collapses to icon-only navigation and expands again', async () => {
    const { container } = render(Layout, { children });
    const sidebar = container.querySelector('aside');

    expect(sidebar).toHaveClass('md:w-64');
    expect(screen.getByText('LLM Gateway')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));

    expect(sidebar).toHaveClass('md:w-16');
    expect(screen.getByText('LLM Gateway').parentElement).toHaveClass('md:hidden');
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Expand' }));

    expect(sidebar).toHaveClass('md:w-64');
    expect(screen.getByText('LLM Gateway')).toBeInTheDocument();
  });
});
