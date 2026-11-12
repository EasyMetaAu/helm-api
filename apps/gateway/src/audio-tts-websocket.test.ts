import { once } from "node:events";
import { createServer } from "node:http";
import type { SpeechEvent, SpeechSession } from "@helm/core";
import { speechQueue } from "@helm/core";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { mountAudioTtsWebSocket } from "./audio-tts-websocket.js";

describe("speech websocket boundary", () => {
  it("authenticates upgrade, holds lease until terminal and releases once", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const release = vi.fn();
    const events = speechQueue<SpeechEvent>(32, 1024, () => {});
    const session: SpeechSession = {
      events,
      capabilities: { flush: false, cancel: false },
      append: vi.fn(async () => {}),
      flush: async () => {},
      cancel: async () => {},
      finish: vi.fn(async () => {}),
      close: () => events.end(),
    };
    const mount = mountAudioTtsWebSocket({
      server,
      deps: {
        auth: {
          resolve: async (token) => (token === "key" ? { keyId: "k", accountId: "a" } : null),
        },
        resolve: () => ({
          lane: "speech-fast",
          alias: "mm/speech",
          model: "speech-2.8-hd",
          customModel: false,
          client: {
            ttsSpeech: async () => ({ audio: new Uint8Array(), contentType: "audio/mpeg" }),
            openSpeechSession: async () => session,
          },
        }),
        concurrencyGate: { acquire: async () => ({ ok: true, release }) },
      },
    });
    const denied = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/tts`);
    denied.on("error", () => {});
    const status = await new Promise<number>((resolve) =>
      denied.on("unexpected-response", (_req, res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        denied.terminate();
      }),
    );
    expect(status).toBe(401);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/tts`, {
      headers: { Authorization: "Bearer key" },
    });
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "start", request: { model: "speech-fast", voice: "voice" } }));
    await new Promise((r) => setTimeout(r, 10));
    expect(release).not.toHaveBeenCalled();
    const message = once(ws, "message");
    events.push({ type: "started", sequence: 0, format: "mp3", sampleRate: 32000 });
    await message;
    const timestamp = once(ws, "message");
    events.push({
      type: "timestamp",
      sequence: 1,
      timestamp: { text: "Hi", startMs: 20, endMs: 100 },
    });
    expect(JSON.parse(String((await timestamp)[0]))).toMatchObject({
      type: "timestamp",
      timestamp: { startMs: 20, endMs: 100 },
    });
    const closed = once(ws, "close");
    events.push({ type: "completed", sequence: 1 });
    events.end();
    await closed;
    expect(release).toHaveBeenCalledTimes(1);
    await mount.close();
    await new Promise<void>((r) => server.close(() => r()));
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("speech websocket termination", () => {
  it.each([
    "disconnect",
    "oversized",
    "unsupported",
  ])("cleans up %s without a second lease release", async (mode) => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const release = vi.fn();
    const close = vi.fn();
    const flush = vi.fn();
    const cancel = vi.fn();
    const events = speechQueue<SpeechEvent>(32, 1024, () => {});
    events.push({ type: "started", sequence: 0, format: "mp3", sampleRate: 32000 });
    const mount = mountAudioTtsWebSocket({
      server,
      deps: {
        auth: { resolve: async () => ({ keyId: "k", accountId: "a" }) },
        concurrencyGate: { acquire: async () => ({ ok: true, release }) },
        resolve: () => ({
          model: "m",
          alias: "p/m",
          lane: "speech",
          customModel: false,
          client: {
            ttsSpeech: async () => ({ audio: new Uint8Array(), contentType: "audio/mpeg" }),
            openSpeechSession: async () => ({
              events,
              capabilities: { flush: false, cancel: false },
              append: async () => {},
              finish: async () => {},
              flush,
              cancel,
              close: () => {
                close();
                events.end();
              },
            }),
          },
        }),
      },
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/audio/tts`);
    await once(ws, "open");
    const started = once(ws, "message");
    ws.send(JSON.stringify({ type: "start", request: { model: "speech", voice: "voice" } }));
    await started;
    if (mode === "unsupported") {
      const reply = once(ws, "message");
      ws.send(JSON.stringify({ type: "flush" }));
      const [data] = await reply;
      expect(JSON.parse(data.toString()).code).toBe("unsupported_command");
      expect(flush).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    }
    const closed = once(ws, "close");
    if (mode === "oversized") ws.send("x".repeat(65 * 1024));
    else ws.close();
    await closed;
    await new Promise((r) => setTimeout(r, 0));
    expect(release).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    await mount.close();
    await new Promise<void>((r) => server.close(() => r()));
    expect(release).toHaveBeenCalledTimes(1);
  });
});

it("reserves a declared WS text bound and rejects an append beyond it before upstream", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const append = vi.fn(async () => {}),
    reserve = vi.fn(async () => ({
      id: "op",
      keyId: "k",
      alias: "mm/speech",
      providerModel: "speech-2.8-hd",
      state: "reserved" as const,
      reservedUsd: 0.1,
      costUsd: null,
      capacity: 1,
      windowMs: 86400000,
      admittedAtMs: 0,
      anchorMs: null,
      usage: null,
    }));
  const events = speechQueue<SpeechEvent>(32, 1024, () => {});
  const mount = mountAudioTtsWebSocket({
    server,
    deps: {
      auth: {
        resolve: async () => ({
          keyId: "k",
          accountId: "a",
          caps: {
            budget: {
              requests: null,
              tokens: null,
              spendUsd: 1,
              windowSeconds: null,
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
      accounting: {
        reserve,
        settle: async (r) => ({ ...r, state: "outcome_unknown" }),
        get: async () => null,
      },
      resolve: () => ({
        model: "speech-2.8-hd",
        alias: "mm/speech",
        lane: "speech",
        customModel: false,
        client: {
          ttsSpeech: async () => ({ audio: new Uint8Array(), contentType: "audio/mpeg" }),
          openSpeechSession: async () => ({
            events,
            append,
            finish: async () => {},
            cancel: async () => {},
            flush: async () => {},
            close: () => events.end(),
            capabilities: { flush: false, cancel: false },
          }),
        },
      }),
    },
  });
  const ws = new WebSocket(
    `ws://127.0.0.1:${(server.address() as { port: number }).port}/v1/audio/tts`,
    { headers: { Authorization: "Bearer key" } },
  );
  try {
    await once(ws, "open");
    const message = once(ws, "message");
    ws.send(
      JSON.stringify({
        type: "start",
        request: { model: "speech", voice: "voice", max_input_characters: 3 },
      }),
    );
    expect(JSON.parse(String((await message)[0]))).toMatchObject({
      type: "accounting",
      operationId: "op",
    });
    const failure = once(ws, "message");
    ws.send(JSON.stringify({ type: "append", text: "four" }));
    expect(JSON.parse(String((await failure)[0]))).toMatchObject({
      type: "error",
      code: "input_limit_exceeded",
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(append).not.toHaveBeenCalled();
  } finally {
    ws.terminate();
    await mount.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
