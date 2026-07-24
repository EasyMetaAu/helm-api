import { describe, expect, it, vi } from "vitest";
import { createOpenAIClient } from "./openai.js";

const CONFIG = { baseUrl: "https://upstream.test/v1", apiKey: "sk-secret-key" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createOpenAIClient.imageGeneration", () => {
  it("POSTs to /images/generations with Bearer auth + verbatim body, returns the JSON", async () => {
    const upstream = { created: 0, data: [{ b64_json: "IMG" }], usage: { output_tokens: 196 } };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(upstream));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const req = { model: "openai/gpt-image-2", prompt: "a cat", size: "1024x1024" };

    const out = await client.imageGeneration?.(req);

    expect(out).toEqual(upstream);
    const [url, init] = fetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://upstream.test/v1/images/generations");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-secret-key");
    expect(JSON.parse(init.body as string)).toEqual(req);
  });

  it("surfaces captureUpstream with the exact wire body exactly once", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const captured: string[] = [];

    await client.imageGeneration?.(
      { model: "m", prompt: "p" },
      { captureUpstream: (b) => captured.push(b) },
    );

    expect(captured).toHaveLength(1);
    expect(JSON.parse(captured[0] as string)).toEqual({ model: "m", prompt: "p" });
  });

  it("throws UpstreamError on a non-2xx response, preserving the upstream status", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ error: { message: "bad" } }, 400));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await expect(client.imageGeneration?.({ model: "m", prompt: "p" })).rejects.toMatchObject({
      name: "UpstreamError",
      errorClass: "upstream_error",
      upstreamStatus: 400,
    });
  });
});

describe("createOpenAIClient.imageEdit", () => {
  it("forwards the Codex JSON edit body to /images/edits", async () => {
    const upstream = { created: 0, data: [{ b64_json: "EDITED" }] };
    const fetch = vi.fn().mockResolvedValue(jsonResponse(upstream));
    const client = createOpenAIClient({ config: CONFIG, fetch });
    const body = {
      model: "gpt-image-2",
      prompt: "add a red hat",
      images: [{ image_url: "data:image/png;base64,AAA=" }],
    };

    const out = await client.imageEdit?.({ kind: "json", body });

    expect(out).toEqual(upstream);
    const [url, init] = fetch.mock.calls[0] as [
      string,
      RequestInit & { headers: Record<string, string> },
    ];
    expect(url).toBe("https://upstream.test/v1/images/edits");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(body);
  });

  it("rebuilds a repeatable multipart edit with binary files", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    const client = createOpenAIClient({ config: CONFIG, fetch });

    await client.imageEdit?.({
      kind: "multipart",
      fields: [
        { name: "model", value: "gpt-image-2" },
        { name: "prompt", value: "add snow" },
        {
          name: "image[]",
          value: new Uint8Array([1, 2, 3]),
          filename: "source.png",
          contentType: "image/png",
        },
      ],
    });

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://upstream.test/v1/images/edits");
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("prompt")).toBe("add snow");
    const image = form.get("image[]") as File;
    expect(image.name).toBe("source.png");
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
