import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { externalizeImages, type PayloadBlob, rehydrateImages } from "./payload-blobs.js";

// A >MIN_DATA_CHARS base64 string of deterministic bytes (so dedup/sha is stable).
function bigB64(seed: number, bytes = 6000): string {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 31 + seed) & 0xff;
  return buf.toString("base64");
}
const sha = (b64: string) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex");

// fetchBlob backed by the externalize output — the round-trip's "store".
function store(blobs: PayloadBlob[]): (s: string) => Uint8Array | null {
  const m = new Map(blobs.map((b) => [b.sha256, b.bytes]));
  return (s) => m.get(s) ?? null;
}

describe("externalizeImages / rehydrateImages", () => {
  it("Anthropic image: round-trips byte-exact, externalizes the data", () => {
    const data = bigB64(1);
    const original = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
          ],
        },
      ],
    });
    const { json, blobs } = externalizeImages(original);
    expect(json).not.toContain(data); // the big blob is gone from the row
    expect(json).toContain("helm-blob:sha256:");
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.sha256).toBe(sha(data));
    const restored = rehydrateImages(json, store(blobs));
    expect(JSON.parse(restored)).toEqual(JSON.parse(original)); // semantic identity
  });

  it("OpenAI image_url data URL: round-trips and keeps the mime", () => {
    const data = bigB64(2);
    const original = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } }],
        },
      ],
    });
    const { json, blobs } = externalizeImages(original);
    expect(json).not.toContain(data);
    expect(blobs).toHaveLength(1);
    const restored = rehydrateImages(json, store(blobs));
    expect(JSON.parse(restored)).toEqual(JSON.parse(original));
  });

  it("Gemini inlineData: round-trips", () => {
    const data = bigB64(3);
    const original = JSON.stringify({
      contents: [{ parts: [{ inlineData: { mimeType: "image/webp", data } }] }],
    });
    const { json, blobs } = externalizeImages(original);
    expect(json).not.toContain(data);
    expect(blobs).toHaveLength(1);
    expect(JSON.parse(rehydrateImages(json, store(blobs)))).toEqual(JSON.parse(original));
  });

  it("dedups identical images across turns into ONE blob", () => {
    const data = bigB64(4);
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data } };
    const original = JSON.stringify({
      messages: [
        { role: "user", content: [img] },
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
        { role: "user", content: [img] }, // SAME image re-sent (CC behaviour)
      ],
    });
    const { blobs } = externalizeImages(original);
    expect(blobs).toHaveLength(1); // collapsed
  });

  it("leaves small data and non-image base64 alone", () => {
    const small = Buffer.from("tiny").toString("base64");
    const original = JSON.stringify({
      a: { type: "image", source: { type: "base64", media_type: "image/png", data: small } },
      note: "some short text that happens to look=like base64==",
    });
    const { json, blobs } = externalizeImages(original);
    expect(blobs).toHaveLength(0);
    expect(json).toBe(original); // untouched, byte-exact
  });

  it("no images → returns the original bytes verbatim", () => {
    const original = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
    const { json, blobs } = externalizeImages(original);
    expect(blobs).toHaveLength(0);
    expect(json).toBe(original);
  });

  it("idempotent: externalizing an already-stripped body adds no new blobs", () => {
    const data = bigB64(5);
    const original = JSON.stringify({
      m: { type: "image", source: { type: "base64", media_type: "image/png", data } },
    });
    const first = externalizeImages(original);
    const second = externalizeImages(first.json);
    expect(second.blobs).toHaveLength(0);
    expect(second.json).toBe(first.json);
  });

  it("rehydrate is fail-open when a blob is missing (sentinel kept, no throw)", () => {
    const data = bigB64(6);
    const original = JSON.stringify({
      m: { type: "image", source: { type: "base64", media_type: "image/png", data } },
    });
    const { json } = externalizeImages(original);
    const restored = rehydrateImages(json, () => null); // blob store empty
    expect(restored).toContain("helm-blob:sha256:"); // left as-is, didn't crash
  });

  it("non-JSON body is stored verbatim", () => {
    const { json, blobs } = externalizeImages("not json at all");
    expect(json).toBe("not json at all");
    expect(blobs).toHaveLength(0);
  });

  it("OpenAI Responses input_image (string image_url): round-trips and externalizes", () => {
    const data = bigB64(7);
    const original = JSON.stringify({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: `data:image/png;base64,${data}` },
          ],
        },
      ],
    });
    const { json, blobs } = externalizeImages(original);
    expect(json).not.toContain(data);
    expect(blobs).toHaveLength(1);
    expect(JSON.parse(rehydrateImages(json, store(blobs)))).toEqual(JSON.parse(original));
  });

  it("chat image_url given as a bare string: round-trips and externalizes", () => {
    const data = bigB64(8);
    const original = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: `data:image/webp;base64,${data}` }],
        },
      ],
    });
    const { json, blobs } = externalizeImages(original);
    expect(json).not.toContain(data);
    expect(blobs).toHaveLength(1);
    expect(JSON.parse(rehydrateImages(json, store(blobs)))).toEqual(JSON.parse(original));
  });

  it("OpenAI Images output (data[].b64_json): externalizes + round-trips byte-exact", () => {
    const data = bigB64(20);
    const original = JSON.stringify({
      created: 0,
      data: [{ b64_json: data }],
      usage: { output_tokens: 196 },
    });
    const { json, blobs } = externalizeImages(original);
    expect(json).not.toContain(data); // the megabyte image is out of the payload text
    expect(json).toContain("helm-blob:sha256:");
    expect(blobs).toHaveLength(1);
    expect(JSON.parse(rehydrateImages(json, store(blobs)))).toEqual(JSON.parse(original));
  });

  it("Gemini Interactions image block ({type:image,data}): externalizes + round-trips", () => {
    const data = bigB64(21);
    const original = JSON.stringify({
      id: "int_1",
      steps: [
        {
          type: "model_output",
          status: "done",
          content: [
            { type: "text", text: "here you go" },
            { type: "image", mime_type: "image/png", data },
          ],
        },
      ],
    });
    const { json, blobs } = externalizeImages(original);
    expect(json).not.toContain(data);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.mime).toBe("image/png");
    expect(JSON.parse(rehydrateImages(json, store(blobs)))).toEqual(JSON.parse(original));
  });

  it("Grok Imagine image.url and reference_images[].url: externalizes + round-trips", () => {
    const image = bigB64(30);
    const reference = bigB64(31);
    const original = JSON.stringify({
      model: "grok-imagine-video",
      image: { url: `data:image/png;base64,${image}` },
      reference_images: [{ url: `data:image/jpeg;base64,${reference}` }],
    });
    const { json, blobs } = externalizeImages(original);
    expect(json).not.toContain(image);
    expect(json).not.toContain(reference);
    expect(blobs).toHaveLength(2);
    expect(JSON.parse(rehydrateImages(json, store(blobs)))).toEqual(JSON.parse(original));
  });

  it("strips query and fragment secrets from captured media URL fields", () => {
    const original = JSON.stringify({
      output: { upload_url: "https://s3.example/video.mp4?signature=secret#fragment" },
      video: { url: "https://cdn.example/video.mp4?token=secret" },
      image: { url: "https://cdn.example/frame.png?token=secret" },
    });
    const { json, blobs } = externalizeImages(original);
    expect(blobs).toHaveLength(0);
    expect(JSON.parse(json)).toEqual({
      output: { upload_url: "https://s3.example/video.mp4" },
      video: { url: "https://cdn.example/video.mp4" },
      image: { url: "https://cdn.example/frame.png" },
    });
  });

  it("rehydrate fails open on non-JSON text containing the sentinel literal", () => {
    // Raw SSE (not a JSON document) whose model text happens to include the literal.
    const sse = 'event: delta\ndata: {"t":"helm-blob:sha256:dead"}\n\n';
    expect(() => rehydrateImages(sse, () => null)).not.toThrow();
    expect(rehydrateImages(sse, () => null)).toBe(sse); // returned untouched
  });
});
