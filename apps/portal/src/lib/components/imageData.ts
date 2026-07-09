// Recognise an image hiding inside a captured payload string and turn it into a
// renderable `data:` URL. The JSON tree renders each scalar in ISOLATION — when it
// reaches `source.data` it no longer has the sibling `media_type` field — so we
// sniff the value itself: base64 magic-byte prefixes for the common formats, plus
// ready-made `data:image/…` URLs which pass through untouched. Anything else (plain
// text, JSON blobs, short tokens) returns null so ordinary strings are never
// mistaken for an image. Pure + framework-free → unit-testable.

// Base64 of each format's leading magic bytes. Base64 encodes 3 bytes → 4 chars on
// fixed boundaries, so a file that always begins with the same bytes always begins
// with the same base64 prefix.
const BASE64_MAGIC: ReadonlyArray<readonly [prefix: string, mime: string]> = [
  ["iVBORw0KGgo", "image/png"], // \x89PNG\r\n
  ["/9j/", "image/jpeg"], // JPEG SOI \xFF\xD8\xFF
  ["R0lGOD", "image/gif"], // "GIF8"
  ["UklGR", "image/webp"], // "RIFF" (WebP container)
  ["Qk", "image/bmp"], // "BM"
];

// A raw base64 image is always far longer than this; the floor rejects short tokens
// that merely happen to share a prefix (e.g. the literal "iVBORw0").
const MIN_BASE64_LEN = 32;

/**
 * Return a `data:` URL renderable in an <img>, or null if `value` is not an image.
 * Accepts a ready-made `data:image/…` URL (returned unchanged) or a bare base64
 * string whose magic prefix identifies a known image format.
 */
export function imageDataUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s.length < MIN_BASE64_LEN) return null;

  // Already a data URL — only images are renderable here.
  if (s.startsWith("data:")) return /^data:image\//i.test(s) ? s : null;

  for (const [prefix, mime] of BASE64_MAGIC) {
    if (s.startsWith(prefix)) return `data:${mime};base64,${s}`;
  }
  return null;
}

export interface CollectedImage {
  /** Renderable `data:` URL. */
  url: string;
  /** Dotted path to the field it was found at, e.g. `candidates.0…inlineData.data`. */
  path: string;
}

// A response with more inline images than this is pathological (or an attack); the
// gallery caps here so one body can never spawn thousands of <img> decodes.
const MAX_IMAGES = 24;
// Mirror JsonTree's render-depth guard so a very deep value can't blow the stack.
const MAX_WALK_DEPTH = 24;

/**
 * Walk a parsed payload (object/array/scalar) and collect every renderable image,
 * de-duplicated by URL and capped. Pure + framework-free → unit-testable. This is
 * what lets the body viewer surface generated images up front instead of leaving
 * them buried as a base64 wall deep in the JSON tree.
 */
export function collectImages(value: unknown): CollectedImage[] {
  const out: CollectedImage[] = [];
  const seen = new Set<string>();
  walk(value, "", out, seen, 0);
  return out;
}

function walk(
  value: unknown,
  path: string,
  out: CollectedImage[],
  seen: Set<string>,
  depth: number,
): void {
  if (out.length >= MAX_IMAGES || depth > MAX_WALK_DEPTH) return;

  if (typeof value === "string") {
    const url = imageDataUrl(value);
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ url, path: path || "image" });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && out.length < MAX_IMAGES; i++) {
      walk(value[i], path ? `${path}.${i}` : String(i), out, seen, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (out.length >= MAX_IMAGES) return;
      walk(v, path ? `${path}.${k}` : k, out, seen, depth + 1);
    }
  }
}
