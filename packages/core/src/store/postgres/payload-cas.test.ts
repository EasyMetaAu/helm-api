import { afterEach, describe, expect, it } from "vitest";
import { createPgliteDb, type PgDb } from "./migrate.js";
import { PgTelemetryStore } from "./telemetry.js";

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

const dbs: PgDb[] = [];

afterEach(async () => {
  for (const db of dbs.splice(0)) await db.$close();
});

async function setup() {
  const db = await createPgliteDb();
  dbs.push(db);
  const store = new PgTelemetryStore(db);
  const blobCount = async () => {
    const r = (await db.execute(
      // biome-ignore lint/suspicious/noExplicitAny: raw count row shape
      "SELECT COUNT(*) AS c FROM payload_blobs" as any,
    )) as { rows?: Array<{ c: number | string }> } | Array<{ c: number | string }>;
    const rows = Array.isArray(r) ? r : (r.rows ?? []);
    return Number(rows[0]?.c ?? 0);
  };
  const rawRequestJson = async (id: string) => {
    const r = (await db.execute(
      // biome-ignore lint/suspicious/noExplicitAny: raw select row shape
      `SELECT request_json AS v FROM request_payloads WHERE request_id = '${id}'` as any,
    )) as { rows?: Array<{ v: string }> } | Array<{ v: string }>;
    const rows = Array.isArray(r) ? r : (r.rows ?? []);
    return rows[0]?.v ?? "";
  };
  return { db, store, blobCount, rawRequestJson };
}

describe("PgTelemetryStore — image CAS (Postgres, no manual gzip)", () => {
  it("externalizes the image off-row but getPayload rehydrates it byte-exact", async () => {
    const { store, blobCount, rawRequestJson } = await setup();
    const data = bigImageB64();
    const body = anthropicBody(data);
    await store.insertPayload({
      requestId: "r1",
      requestJson: body,
      responseJson: '{"ok":true}',
      createdAt: new Date(1000),
    });

    // The fat base64 is NOT stored in the payload row (it's externalized to a blob).
    // Postgres keeps the slimmed JSON as plain TEXT (TOAST auto-compresses) — no gzip.
    const raw = await rawRequestJson("r1");
    expect(raw.includes(data)).toBe(false);
    expect(raw).toContain("helm-blob:sha256:");
    expect(await blobCount()).toBe(1);

    // getPayload restores the verbatim original body (admin view + replay fidelity).
    const got = await store.getPayload("r1");
    expect(JSON.parse(got?.requestJson ?? "")).toEqual(JSON.parse(body));
    expect(got?.responseJson).toBe('{"ok":true}');
  });

  it("dedups the SAME image across request + upstream into ONE blob", async () => {
    const { store, blobCount } = await setup();
    const data = bigImageB64();
    const body = anthropicBody(data);
    await store.insertPayload({
      requestId: "r2",
      requestJson: body,
      responseJson: null,
      upstreamRequestJson: body, // same image re-appears in the upstream body
      createdAt: new Date(1000),
    });
    expect(await blobCount()).toBe(1); // collapsed across both columns

    // Round-trips both columns back to the verbatim originals.
    const got = await store.getPayload("r2");
    expect(JSON.parse(got?.requestJson ?? "")).toEqual(JSON.parse(body));
    expect(JSON.parse(got?.upstreamRequestJson ?? "")).toEqual(JSON.parse(body));
  });

  it("prune keeps a blob still referenced by a newer payload (created_at touched)", async () => {
    const { store, blobCount } = await setup();
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
    expect(await blobCount()).toBe(1);

    await store.prunePayloads(3000); // drops "old", keeps "new"
    expect(await store.getPayload("old")).toBeNull();
    expect(await blobCount()).toBe(1); // blob survived (touched to 5000)
    const got = await store.getPayload("new");
    expect(JSON.parse(got?.requestJson ?? "")).toEqual(JSON.parse(anthropicBody(data)));
  });

  it("prune drops a blob whose only payload aged out", async () => {
    const { store, blobCount } = await setup();
    await store.insertPayload({
      requestId: "lonely",
      requestJson: anthropicBody(bigImageB64()),
      responseJson: null,
      createdAt: new Date(1000),
    });
    expect(await blobCount()).toBe(1);
    await store.prunePayloads(3000);
    expect(await blobCount()).toBe(0); // no surviving reference → reclaimed
  });

  it("selectPayloadsOlderThan rehydrates the externalized image for the archive scan", async () => {
    const { store } = await setup();
    const data = bigImageB64();
    const body = anthropicBody(data);
    await store.insertPayload({
      requestId: "arch",
      requestJson: body,
      responseJson: null,
      upstreamRequestJson: body,
      createdAt: new Date(1000),
    });
    const rows = await store.selectPayloadsOlderThan(5000, 10);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.requestJson ?? "")).toEqual(JSON.parse(body));
    expect(JSON.parse(rows[0]?.upstreamRequestJson ?? "")).toEqual(JSON.parse(body));
  });
});
