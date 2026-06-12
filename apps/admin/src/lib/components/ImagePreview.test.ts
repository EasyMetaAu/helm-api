import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import ImagePreview from './ImagePreview.svelte';

// ImagePreview is the "see it as a picture" affordance for the JSON tree: a base64
// image field is otherwise an unreadable wall of characters. This opens a roomy
// modal that renders the decoded image via a data: URL. Read-only — never mutates
// the value. i18n falls back to the English key in tests, so we assert English.

const SRC =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('ImagePreview', () => {
  it('renders a View image button and keeps the modal closed initially', () => {
    render(ImagePreview, { src: SRC });
    expect(screen.getByTestId('image-preview-open')).toBeInTheDocument();
    expect(screen.queryByTestId('image-preview-img')).not.toBeInTheDocument();
  });

  it('opens a modal whose body shows the decoded image at the data: URL', async () => {
    render(ImagePreview, { src: SRC });
    await fireEvent.click(screen.getByTestId('image-preview-open'));
    const img = screen.getByTestId('image-preview-img') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(SRC);
  });

  it('uses a wide modal panel and shows the label as the title', async () => {
    render(ImagePreview, { src: SRC, label: 'source.data' });
    await fireEvent.click(screen.getByTestId('image-preview-open'));
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-w-3xl');
    expect(dialog).toHaveAttribute('aria-label', 'source.data');
  });

  it('dismisses the modal via the Close button', async () => {
    render(ImagePreview, { src: SRC });
    await fireEvent.click(screen.getByTestId('image-preview-open'));
    expect(screen.getByTestId('image-preview-img')).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('image-preview-close'));
    expect(screen.queryByTestId('image-preview-img')).not.toBeInTheDocument();
  });
});
