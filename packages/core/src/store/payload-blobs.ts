import { createHash } from "node:crypto";

// Content-addressed externalization of inline base64 images in a captured body.
//
// WHY: Claude Code (and any chat client) re-sends the ENTIRE conversation —
// including every image as base64 — on EVERY turn. A 1 MB image in a 10-turn
// thread is therefore stored ~10x verbatim, across many request_payloads rows
// (and twice within one row: client request_json AND upstream_request_json). On
// the production box this made the payload table 6-7 MB/row and the DB 14 GB.
//
// FIX: pull each base64 image out into a content-addressed blob (sha256 of the
// DECODED bytes), replacing the inline data with a sentinel. Identical images
// collapse to ONE stored blob regardless of how many turns/rows reference them.
// rehydrateImages() restores the exact original body, so the admin payload view
// and the request replay path (both read through getPayload) keep full fidelity.
//
// Pure + framework-free (core may not import Hono/SvelteKit). Recognizes the
// three wire shapes Helm ingests: Anthropic image source, OpenAI image_url
// `data:` URL, Gemini inlineData.

export interface PayloadBlob {
  sha256: string; // hex digest of the decoded bytes — the content address
  bytes: Uint8Array; // DECODED binary (base64's 1.33x overhead is shed here)
  mime: string | null; // media type, for the admin blob viewer / debugging
}

export interface ExternalizeResult {
  json: string; // body with image data replaced by sentinels (or verbatim if none)
  blobs: PayloadBlob[]; // de-duplicated by sha256
}

const SENTINEL_PREFIX = "helm-blob:sha256:";
// Only externalize base64 data above this many chars. A blob row + a read-time
// join isn't worth it for a 1 KB favicon; the 14 GB problem is all MB-scale.
const MIN_DATA_CHARS = 4096;

// OpenAI data URL with our sentinel swapped in for the base64 tail.
const DATA_URL_SENTINEL = /^(data:.*?;base64,)helm-blob:sha256:([0-9a-f]{64})$/;

function sha256hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Decode + record a base64 blob; return its sentinel, or null to leave the value
// untouched (already a sentinel, too small, or empty).
function stash(data: string, mime: string | null, blobs: Map<string, PayloadBlob>): string | null {
  if (data.startsWith(SENTINEL_PREFIX) || data.length < MIN_DATA_CHARS) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) return null;
  const sha = sha256hex(bytes);
  if (!blobs.has(sha)) blobs.set(sha, { sha256: sha, bytes, mime });
  return SENTINEL_PREFIX + sha;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function walkExternalize(node: unknown, blobs: Map<string, PayloadBlob>): unknown {
  if (Array.isArray(node)) return node.map((n) => walkExternalize(n, blobs));
  if (!isRecord(node)) return node;

  // Anthropic: { type:"image", source:{ type:"base64", media_type, data } }
  if (node.type === "image" && isRecord(node.source) && node.source.type === "base64") {
    const src = node.source;
    if (typeof src.data === "string") {
      const ref = stash(src.data, (src.media_type as string | undefined) ?? null, blobs);
      if (ref) return { ...node, source: { ...src, data: ref } };
    }
  }

  // OpenAI Chat:      { type:"image_url",   image_url:{ url:"data:<mime>;base64,<data>" } }
  // OpenAI Responses: { type:"input_image", image_url:"data:<mime>;base64,<data>" }  ← STRING
  // Also tolerate a bare-string image_url on a chat part. Pull the data: URL from
  // whichever shape, externalize it, and put the slimmed URL back in the SAME shape.
  if (node.type === "image_url" || node.type === "input_image") {
    const iu = node.image_url;
    const url =
      typeof iu === "string" ? iu : isRecord(iu) && typeof iu.url === "string" ? iu.url : null;
    if (url !== null) {
      const marker = ";base64,";
      const idx = url.indexOf(marker);
      if (idx >= 0) {
        const head = url.slice(0, idx + marker.length); // "data:<mime>;base64,"
        const data = url.slice(idx + marker.length);
        const mime = url.slice("data:".length, idx) || null;
        const ref = stash(data, mime, blobs);
        if (ref) {
          const newUrl = head + ref;
          // In the non-string branch `iu` is a record (url came from iu.url via isRecord).
          return typeof iu === "string"
            ? { ...node, image_url: newUrl }
            : { ...node, image_url: { ...(iu as Record<string, unknown>), url: newUrl } };
        }
      }
    }
  }

  // Gemini: { inlineData:{ mimeType, data } } (camel or snake)
  for (const key of ["inlineData", "inline_data"] as const) {
    const inl = node[key];
    if (isRecord(inl) && typeof inl.data === "string") {
      const mime = (inl.mimeType ?? inl.mime_type ?? null) as string | null;
      const ref = stash(inl.data, mime, blobs);
      if (ref) return { ...node, [key]: { ...inl, data: ref } };
    }
  }

  // OpenAI Images output: { b64_json:"<base64>" } (the /v1/images/generations data[]
  // items — also the IR image shape). A bare base64 string, no `data:` wrapper.
  if (typeof node.b64_json === "string") {
    const ref = stash(node.b64_json, null, blobs);
    if (ref) return { ...node, b64_json: ref };
  }

  // Gemini Interactions output block: { type:"image", mime_type, data:"<base64>" }
  // (POST /v1beta/interactions steps[].content[]). Distinct from the Anthropic
  // `type:"image"` block above, which carries the base64 under `source.data`.
  if (node.type === "image" && typeof node.data === "string") {
    const ref = stash(node.data, (node.mime_type as string | undefined) ?? null, blobs);
    if (ref) return { ...node, data: ref };
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = walkExternalize(v, blobs);
  return out;
}

export function externalizeImages(json: string): ExternalizeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { json, blobs: [] }; // non-JSON (or already-broken) body → store verbatim
  }
  const blobs = new Map<string, PayloadBlob>();
  const walked = walkExternalize(parsed, blobs);
  // Nothing externalized → return the ORIGINAL bytes verbatim (preserve fidelity
  // for bodies we didn't touch; avoids a needless re-serialization).
  if (blobs.size === 0) return { json, blobs: [] };
  return { json: JSON.stringify(walked), blobs: [...blobs.values()] };
}

function restoreString(s: string, fetchBlob: (sha: string) => Uint8Array | null): string {
  if (s.startsWith(SENTINEL_PREFIX)) {
    const bytes = fetchBlob(s.slice(SENTINEL_PREFIX.length));
    return bytes ? Buffer.from(bytes).toString("base64") : s; // fail-open: keep sentinel
  }
  const m = DATA_URL_SENTINEL.exec(s);
  if (m) {
    const bytes = fetchBlob(m[2] as string);
    return bytes ? `${m[1]}${Buffer.from(bytes).toString("base64")}` : s;
  }
  return s;
}

function walkRehydrate(node: unknown, fetchBlob: (sha: string) => Uint8Array | null): unknown {
  if (typeof node === "string") return restoreString(node, fetchBlob);
  if (Array.isArray(node)) return node.map((n) => walkRehydrate(n, fetchBlob));
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = walkRehydrate(v, fetchBlob);
  return out;
}

export function rehydrateImages(
  json: string,
  fetchBlob: (sha: string) => Uint8Array | null,
): string {
  if (!json.includes(SENTINEL_PREFIX)) return json; // fast path: nothing externalized
  // Only strings WE produced are guaranteed JSON. A captured response can be raw SSE
  // (not a JSON document) that merely contains the literal "helm-blob:sha256:" in model
  // text — parsing that throws. Fail open: return the original text untouched rather
  // than break getPayload / archive reads for that request.
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  return JSON.stringify(walkRehydrate(parsed, fetchBlob));
}
