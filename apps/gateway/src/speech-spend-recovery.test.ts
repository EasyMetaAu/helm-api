import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  createBailianSpeechClient,
  createDoubaoSpeechClient,
  createMiniMaxSpeechClient,
  createSpeechAccounting,
  type SpeechClient,
  SqliteBudgetStore,
  type SqliteDb,
} from "@helm/core";
import type { MediaPricing, MediaSpendRecord } from "@helm/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { AppEnv } from "./app.js";
import { mountAudioTtsWebSocket } from "./audio-tts-websocket.js";
import { type AudioSpeechRouteDeps, registerAudioSpeechRoute } from "./routes/audio-speech.js";

// Resolve core's existing SQLite dependencies without adding them to gateway.
const requireCore = createRequire(createRequire(import.meta.url).resolve("@helm/core"));
const Database = requireCore("better-sqlite3") as new (path: string) => SqliteDb["$sqlite"];
const { drizzle } = requireCore("drizzle-orm/better-sqlite3") as {
  drizzle(raw: SqliteDb["$sqlite"]): SqliteDb;
};

// Only these budget tables are needed; no historical migrations or cross-table SQL.
function fixture(client: SpeechClient, model: string) {
  const raw = new Database(":memory:");
  raw.exec(`CREATE TABLE usage_budget_buckets (key_id TEXT NOT NULL, dim TEXT NOT NULL, tokens REAL NOT NULL, last_refill_ms INTEGER NOT NULL, PRIMARY KEY(key_id,dim));
CREATE TABLE weekly_budget_usage (key_id TEXT NOT NULL, dim TEXT NOT NULL, period_start_ms INTEGER NOT NULL, used REAL NOT NULL, PRIMARY KEY(key_id,dim,period_start_ms));
CREATE TABLE media_spend_records (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, record_json TEXT NOT NULL);`);
  const store = new SqliteBudgetStore(
    Object.assign(drizzle(raw), { $sqlite: raw, $vecLoaded: false }),
  );
  const accounting = createSpeechAccounting(store, {
    defaultWindowSeconds: 86400,
    defaultDegradeLane: "economy",
  });
  const pricing: MediaPricing = {
    currency: "USD",
    providerModel: model,
    region: "test",
    basis: "official_list_price",
    verifiedOn: "2026-11-12",
    source: "https://example.test/contract",
    notes: [],
    billing: { maxCharactersPerInputCodepoint: 1 },
    rates: [
      { direction: "output", unit: "million_billable_characters", price: 100, conditions: {} },
    ],
  };
  let resolveSettlement!: (record: MediaSpendRecord) => void;
  const settled = new Promise<MediaSpendRecord>((resolve) => {
    resolveSettlement = resolve;
  });
  const originalSettle = accounting.settle.bind(accounting);
  vi.spyOn(accounting, "settle").mockImplementation(async (...args) => {
    const result = await originalSettle(...args);
    if (result) resolveSettlement(result);
    return result;
  });
  const deps: AudioSpeechRouteDeps = {
    accounting,
    auth: {
      resolve: async () => ({
        keyId: "key",
        accountId: "account",
        caps: {
          budget: {
            requests: null,
            tokens: null,
            spendUsd: 10,
            windowSeconds: null,
            weeklyAnchor: "1970-01-01T00:00:00Z",
            behavior: "reject",
            degradeLane: null,
          },
        },
      }),
    },
    budgetGate: {
      check: async () => ({
        overBudget: false,
        limitedBy: null,
        behavior: "reject",
        degradeLane: null,
      }),
    },
    concurrencyGate: { acquire: async () => ({ ok: true, release: async () => {} }) },
    resolve: () => ({
      client,
      model,
      alias: `test/${model}`,
      lane: "speech",
      customModel: false,
      pricing,
    }),
  };
  return { raw, store, deps, settled };
}
async function expectBudget(
  f: ReturnType<typeof fixture>,
  record: MediaSpendRecord,
  unbilled: boolean,
) {
  expect(record.reservedUsd).toBeGreaterThan(0);
  expect(record.state).toBe(unbilled ? "settled" : "outcome_unknown");
  expect(record.costUsd).toBe(unbilled ? 0 : null);
  expect((await f.store.getMediaSpend(record.id, "key"))?.state).toBe(record.state);
  expect((await f.store.peek("key", "usd", 10, 86400000, Date.now(), 0)).remaining).toBeCloseTo(
    unbilled ? 10 : 10 - record.reservedUsd,
    8,
  );
}

async function disconnectingUpstream() {
  const received = vi.fn();
  const server = createServer((request) => {
    request.resume();
    request.on("end", () => {
      received();
      request.socket.destroy();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("speech spend recovery", () => {
  it.each([
    "local validation",
    "explicit rejection",
    "dispatch disconnect",
  ] as const)("HTTP streaming: %s", async (mode) => {
    const upstream = mode === "dispatch disconnect" ? await disconnectingUpstream() : null;
    const fetch = upstream
      ? vi.fn(globalThis.fetch)
      : vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const client = createMiniMaxSpeechClient({
      config: { baseUrl: upstream?.baseUrl ?? "https://speech.example.test", apiKey: "test" },
      fetch,
    });
    const f = fixture(client, "speech-2.8-hd");
    const app = new Hono<AppEnv>();
    registerAudioSpeechRoute(app, f.deps);
    try {
      const response = await app.request("/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: "Bearer test" },
        body: JSON.stringify({
          model: "speech",
          voice: "voice",
          input: "Hello",
          stream: true,
          sample_rate: mode === "local validation" ? 48000 : 32000,
        }),
      });
      expect(response.status).toBe(mode === "local validation" ? 422 : 502);
      expect(fetch).toHaveBeenCalledTimes(mode === "local validation" ? 0 : 1);
      if (upstream) expect(upstream.received).toHaveBeenCalledTimes(1);
      await expectBudget(f, await f.settled, mode !== "dispatch disconnect");
    } finally {
      f.raw.close();
      await upstream?.close();
    }
  });

  it.each([
    "Bailian validation",
    "Doubao close before finish",
    "Doubao explicit rejection",
    "Doubao dispatch disconnect",
  ] as const)("WebSocket: %s", async (mode) => {
    const upstream = mode === "Doubao dispatch disconnect" ? await disconnectingUpstream() : null;
    const fetch = upstream
      ? vi.fn(globalThis.fetch)
      : vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    const connect = vi.fn().mockRejectedValue(new Error("unexpected connect"));
    const client =
      mode === "Bailian validation"
        ? createBailianSpeechClient(
            { config: { baseUrl: "https://speech.example.test", apiKey: "test" } },
            { url: "wss://speech.example.test", connect },
          )
        : createDoubaoSpeechClient({
            config: { baseUrl: upstream?.baseUrl ?? "https://speech.example.test", apiKey: "test" },
            fetch,
          });
    let resolveAppend!: () => void;
    const appended = new Promise<void>((resolve) => {
      resolveAppend = resolve;
    });
    const open = client.openSpeechSession?.bind(client);
    if (!open) throw new Error("session required");
    client.openSpeechSession = async (...args) => {
      const session = await open(...args);
      const append = session.append.bind(session);
      session.append = async (text) => {
        await append(text);
        resolveAppend();
      };
      return session;
    };
    const f = fixture(
      client,
      mode === "Bailian validation" ? "cosyvoice-v3-flash" : "seed-tts-2.0",
    );
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const mount = mountAudioTtsWebSocket({ server, deps: f.deps });
    const ws = new WebSocket(
      `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/audio/tts`,
      { headers: { Authorization: "Bearer test" } },
    );
    const closed = once(ws, "close");
    try {
      await once(ws, "open");
      const messages: Record<string, unknown>[] = [];
      ws.on("message", (data) => messages.push(JSON.parse(String(data))));
      ws.send(
        JSON.stringify({
          type: "start",
          request: {
            model: "speech",
            voice: "voice",
            response_format: mode === "Bailian validation" ? "opus" : "mp3",
            max_input_characters: 10000,
          },
        }),
      );
      if (mode !== "Bailian validation") {
        ws.send(JSON.stringify({ type: "append", text: "Hello" }));
        await appended;
        if (mode === "Doubao close before finish") ws.close();
        else ws.send(JSON.stringify({ type: "finish" }));
      }
      const record = await f.settled;
      await closed;
      expect(messages.some((m) => m.type === "accounting")).toBe(true);
      expect(connect).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(
        mode === "Doubao explicit rejection" || mode === "Doubao dispatch disconnect" ? 1 : 0,
      );
      if (upstream) expect(upstream.received).toHaveBeenCalledTimes(1);
      await expectBudget(f, record, mode !== "Doubao dispatch disconnect");
    } finally {
      ws.terminate();
      await mount.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      f.raw.close();
      await upstream?.close();
    }
  });
});
