import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import ImagePreview from './ImagePreview.svelte';

// ImagePreview is the "see it as a picture" affordance for the JSON tree: a base64
// image field is otherwise an unreadable wall of characters. This opens a roomy
// modal that renders the decoded image via a data: URL, with zoom controls so the
// real pixels are inspectable. Read-only — never mutates the value. i18n falls back
// to the English key in tests, so we assert English.

const SRC =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function openModal(props: { src: string; label?: string }) {
  render(ImagePreview, props);
  await fireEvent.click(screen.getByTestId('image-preview-open'));
}

describe('ImagePreview', () => {
  it('renders a View image button and keeps the modal closed initially', () => {
    render(ImagePreview, { src: SRC });
    expect(screen.getByTestId('image-preview-open')).toBeInTheDocument();
    expect(screen.queryByTestId('image-preview-img')).not.toBeInTheDocument();
  });

  it('opens a modal whose body shows the decoded image at the data: URL', async () => {
    await openModal({ src: SRC });
    const img = screen.getByTestId('image-preview-img') as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe(SRC);
  });

  it('uses a wide modal panel and shows the label as the title', async () => {
    await openModal({ src: SRC, label: 'source.data' });
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-w-3xl');
    expect(dialog).toHaveAttribute('aria-label', 'source.data');
  });

  it('dismisses the modal via the Close button', async () => {
    await openModal({ src: SRC });
    expect(screen.getByTestId('image-preview-img')).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('image-preview-close'));
    expect(screen.queryByTestId('image-preview-img')).not.toBeInTheDocument();
  });

  it('shows the zoom controls and starts at 100%', async () => {
    await openModal({ src: SRC });
    expect(screen.getByTestId('image-preview-zoom-out')).toBeInTheDocument();
    expect(screen.getByTestId('image-preview-zoom-in')).toBeInTheDocument();
    expect(screen.getByTestId('image-preview-zoom-actual')).toBeInTheDocument();
    expect(screen.getByTestId('image-preview-zoom-fit')).toBeInTheDocument();
    expect(screen.getByTestId('image-preview-zoom-level').textContent).toBe('100%');
  });

  it('zooms in and out by a fixed step', async () => {
    await openModal({ src: SRC });
    const level = screen.getByTestId('image-preview-zoom-level');
    await fireEvent.click(screen.getByTestId('image-preview-zoom-in'));
    expect(level.textContent).toBe('125%');
    await fireEvent.click(screen.getByTestId('image-preview-zoom-out'));
    await fireEvent.click(screen.getByTestId('image-preview-zoom-out'));
    expect(level.textContent).toBe('80%');
  });

  it('resets to 100% when 1:1 (actual size) is clicked', async () => {
    await openModal({ src: SRC });
    const level = screen.getByTestId('image-preview-zoom-level');
    await fireEvent.click(screen.getByTestId('image-preview-zoom-in'));
    await fireEvent.click(screen.getByTestId('image-preview-zoom-in'));
    expect(level.textContent).not.toBe('100%');
    await fireEvent.click(screen.getByTestId('image-preview-zoom-actual'));
    expect(level.textContent).toBe('100%');
  });

  it('opens the image in a new window via window.open', async () => {
    const appended: HTMLImageElement[] = [];
    const fakeWin = {
      document: Object.assign(document.implementation.createHTMLDocument(''), {}),
    } as unknown as Window;
    // Track what gets appended so we can assert the data: URL is carried over.
    const origAppend = fakeWin.document.body.appendChild.bind(fakeWin.document.body);
    vi.spyOn(fakeWin.document.body, 'appendChild').mockImplementation((node) => {
      if (node instanceof HTMLImageElement) appended.push(node);
      return origAppend(node);
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin);

    await openModal({ src: SRC });
    await fireEvent.click(screen.getByTestId('image-preview-open-tab'));

    expect(openSpy).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(appended[0].src).toBe(SRC);
    openSpy.mockRestore();
  });
});
