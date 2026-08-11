import { describe, expect, it } from "vitest";
import { encodePayloadText, PAYLOAD_TEXT_CHUNK_RAW_BYTES } from "../payload-codec.js";
import { createSqliteDb } from "./migrate.js";
import { SqliteTelemetryStore } from "./telemetry.js";

// A >4 KB base64 blob so externalization kicks in (deterministic bytes → stable sha).
function bigImageB64(seed = 7, bytes = 8000): string {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 17 + seed) & 0xff;
  return buf.toString("base64");
}

function anthropicBody(data: string): string {
  return JSON.stringify({
    model: "claude",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          { type: "image", source: { type: "base64", media_type: "image/png", data } },
        ],
      },
    ],
  });
}

function setup() {
  const db = createSqliteDb(":memory:");
  const store = new SqliteTelemetryStore(db);
  const blobCount = () =>
    (db.$sqlite.prepare("SELECT COUNT(*) AS c FROM payload_blobs").get() as { c: number }).c;
  const rawRequestJson = (id: string) =>
    (
      db.$sqlite
        .prepare("SELECT request_json AS v FROM request_payloads WHERE request_id = ?")
        .get(id) as { v: unknown }
    ).v;
  return { db, store, blobCount, rawRequestJson };
}

describe("SqliteTelemetryStore — image CAS + gzip", () => {
  it("externalizes the image off-row but getPayload rehydrates it byte-exact", async () => {
    const { store, blobCount, rawRequestJson } = setup();
    const data = bigImageB64();
    const body = anthropicBody(data);
    await store.insertPayload({
      requestId: "r1",
      requestJson: body,
      responseJson: '{"ok":true}',
      createdAt: new Date(1000),
    });

    // The fat base64 is NOT stored in the payload row (it's gzipped + externalized).
    const raw = rawRequestJson("r1");
    expect(Buffer.isBuffer(raw)).toBe(true); // gzip BLOB, not TEXT
    expect((raw as Buffer).includes(Buffer.from(data))).toBe(false);
    expect(blobCount()).toBe(1);

    // getPayload restores the verbatim original body (admin view + replay fidelity).
    const got = await store.getPayload("r1");
    expect(JSON.parse(got?.requestJson ?? "")).toEqual(JSON.parse(body));
    expect(got?.responseJson).toBe('{"ok":true}');
  });

  it("returns null for an oversized legacy gzip payload body", async () => {
    const { db, store } = setup();
    await store.insertPayload({
      requestId: "legacy-gzip-bomb",
      requestJson: "{}",
      responseJson: null,
      createdAt: new Date(1_000),
    });
    const bomb = encodePayloadText("x".repeat(PAYLOAD_TEXT_CHUNK_RAW_BYTES + 1));
    db.$sqlite
      .prepare("UPDATE request_payloads SET request_json = ? WHERE request_id = ?")
      .run(bomb, "legacy-gzip-bomb");

    await expect(store.getPayload("legacy-gzip-bomb")).resolves.toMatchObject({ requestJson: "" });
    db.$sqlite.close();
  });

  it("externalizes an image-GEN RESPONSE (data[].b64_json) off-row + rehydrates it for the admin view", async () => {
    const { store, blobCount } = setup();
    const data = bigImageB64(9);
    // The /v1/images/generations response shape — the generated image as b64_json.
    const responseJson = JSON.stringify({
      created: 0,
      data: [{ b64_json: data }],
      usage: { output_tokens: 196 },
    });
    await store.insertPayload({
      requestId: "img1",
      requestJson: '{"model":"gpt-image","prompt":"a cat"}',
      responseJson,
      createdAt: new Date(2000),
    });

    expect(blobCount()).toBe(1); // the megabyte image is off-row in payload_blobs
    // getPayload rehydrates the full image so collectImages() can render it in the admin.
    const got = await store.getPayload("img1");
    const resp = JSON.parse(got?.responseJson ?? "") as { data: Array<{ b64_json: string }> };
    expect(resp.data[0]?.b64_json).toBe(data); // byte-exact image restored
  });

  it("dedups the SAME image across request + upstream into ONE blob", async () => {
    const { store, blobCount } = setup();
    const data = bigImageB64();
    const body = anthropicBody(data);
    await store.insertPayload({
      requestId: "r2",
      requestJson: body,
      responseJson: null,
      upstreamRequestJson: body, // same image re-appears in the upstream body
      createdAt: new Date(1000),
    });
    expect(blobCount()).toBe(1); // collapsed across both columns
  });

  it("prune keeps a blob still referenced by a newer payload (created_at touched)", async () => {
    const { store, blobCount } = setup();
    const data = bigImageB64();
    await store.insertPayload({
      requestId: "old",
      requestJson: anthropicBody(data),
      responseJson: null,
      createdAt: new Date(1000),
    });
    await store.insertPayload({
      requestId: "new",
      requestJson: anthropicBody(data), // SAME image, later turn → touches blob.created_at
      responseJson: null,
      createdAt: new Date(5000),
    });
    expect(blobCount()).toBe(1);

    await store.prunePayloads(3000); // drops "old", keeps "new"
    expect(await store.getPayload("old")).toBeNull();
    expect(blobCount()).toBe(1); // blob survived (touched to 5000)
    const got = await store.getPayload("new");
    expect(JSON.parse(got?.requestJson ?? "")).toEqual(JSON.parse(anthropicBody(data)));
  });

  it("prune drops a blob whose only payload aged out", async () => {
    const { store, blobCount } = setup();
    await store.insertPayload({
      requestId: "lonely",
      requestJson: anthropicBody(bigImageB64()),
      responseJson: null,
      createdAt: new Date(1000),
    });
    expect(blobCount()).toBe(1);
    await store.prunePayloads(3000);
    expect(blobCount()).toBe(0); // no surviving reference → reclaimed
  });
});
