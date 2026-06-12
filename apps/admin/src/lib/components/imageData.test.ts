import { describe, expect, it } from 'vitest';
import { imageDataUrl } from './imageData';

// imageDataUrl turns a captured string value into a renderable <img> source when
// the string is recognisably image bytes — WITHOUT needing the sibling
// `media_type` field (the JSON tree renders each scalar in isolation). It sniffs
// the base64 magic-byte prefix, and also passes through ready-made `data:image/…`
// URLs. Everything else returns null so ordinary text is never mistaken for an image.

// A 1×1 transparent PNG — its base64 starts with the canonical `iVBORw0KGgo` magic.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('imageDataUrl', () => {
  it('wraps a raw base64 PNG in a data: URL by sniffing its magic prefix', () => {
    expect(imageDataUrl(PNG_1PX)).toBe(`data:image/png;base64,${PNG_1PX}`);
  });

  it('detects JPEG and GIF base64 by their magic prefixes', () => {
    const jpeg = `/9j/4AAQSkZJRgABAQ${'A'.repeat(40)}`;
    const gif = `R0lGODlhAQABAIAAAA${'A'.repeat(40)}`;
    expect(imageDataUrl(jpeg)).toBe(`data:image/jpeg;base64,${jpeg}`);
    expect(imageDataUrl(gif)).toBe(`data:image/gif;base64,${gif}`);
  });

  it('passes a ready-made data:image URL through unchanged', () => {
    const url = `data:image/webp;base64,${'UklGRiQAAABXRUJQ'.padEnd(48, 'A')}`;
    expect(imageDataUrl(url)).toBe(url);
  });

  it('tolerates surrounding whitespace around a raw base64 image', () => {
    expect(imageDataUrl(`\n  ${PNG_1PX}\n`)).toBe(`data:image/png;base64,${PNG_1PX}`);
  });

  it('returns null for ordinary text, short strings, and non-strings', () => {
    expect(imageDataUrl('hello world, this is a normal sentence.')).toBeNull();
    expect(imageDataUrl('iVBORw0')).toBeNull(); // too short to be a real image
    expect(imageDataUrl('')).toBeNull();
    expect(imageDataUrl(42)).toBeNull();
    expect(imageDataUrl(null)).toBeNull();
    expect(imageDataUrl({ data: PNG_1PX })).toBeNull();
  });

  it('does not mistake a long non-base64 string (real newlines/spaces) for an image', () => {
    const prompt = `You are a helpful assistant.\n${'word '.repeat(200)}`;
    expect(imageDataUrl(prompt)).toBeNull();
  });
});
