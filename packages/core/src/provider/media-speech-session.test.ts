import { describe, expect, it } from "vitest";
import { createBailianSpeechClient } from "./bailian-speech.js";
import type { SpeechSocket } from "./media-speech.js";
import { speechQueue } from "./media-speech-session.js";
import { createMiniMaxSpeechSession } from "./minimax-speech-session.js";

function socket() {
  const input = speechQueue<string | Uint8Array>(100, 10000, () => {});
  const sent: Record<string, unknown>[] = [];
  const transport: SpeechSocket = {
    messages: input,
    send: async (text) => {
      sent.push(JSON.parse(text));
    },
    close: () => input.end(),
  };
  return { input, sent, transport };
}
const config = {
  model: "qwen-audio-3.0-tts-flash",
  voice: "longanhuan_v3.6",
  response_format: "mp3" as const,
  sample_rate: 22050,
  speed: 1,
};
describe("speech sessions", () => {
  it("uses current Ali inference events, emits audio before task finish, rejects flush", async () => {
    const s = socket();
    const pending = createBailianSpeechClient(
      { config: { baseUrl: "https://example.test", apiKey: "test" } },
      { url: "wss://example.test/api-ws/v1/inference", connect: async () => s.transport },
    ).openSpeechSession(config);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.sent[0]).toMatchObject({
      header: { action: "run-task" },
      payload: { task: "tts", function: "SpeechSynthesizer", model: config.model },
    });
    const task = (s.sent[0]?.header as { task_id: string }).task_id;
    s.input.push(JSON.stringify({ header: { event: "task-started", task_id: task } }));
    const session = await pending;
    const iter = session.events[Symbol.asyncIterator]();
    expect((await iter.next()).value.type).toBe("started");
    await session.append("hello");
    s.input.push(new Uint8Array([1, 2]));
    expect((await iter.next()).value.type).toBe("audio");
    await expect(session.flush()).rejects.toThrow("unsupported");
    await session.finish();
    s.input.push(JSON.stringify({ header: { event: "task-finished", task_id: task } }));
    expect((await iter.next()).value.type).toBe("completed");
    expect((await iter.next()).done).toBe(true);
  });
  it("keeps MiniMax completion layers distinct and supports bidi controls", async () => {
    const s = socket();
    const pending = createMiniMaxSpeechSession(config, {
      url: "wss://example.test/ws/v1/t2a_v2_bidi",
      connect: async () => s.transport,
      headers: {},
      signal: new AbortController().signal,
      profile: "minimax-bidi",
    });
    s.input.push(JSON.stringify({ event: "connected_success" }));
    await new Promise((r) => setTimeout(r, 0));
    s.input.push(JSON.stringify({ event: "task_started" }));
    const session = await pending;
    const iter = session.events[Symbol.asyncIterator]();
    await iter.next();
    await session.append("Hi.");
    s.input.push(
      JSON.stringify({ event: "task_continued", data: { audio: "0102" }, is_final: false }),
    );
    expect((await iter.next()).value.type).toBe("audio");
    s.input.push(JSON.stringify({ event: "task_continued", is_final: true }));
    expect((await iter.next()).value.type).toBe("request_final");
    s.input.push(JSON.stringify({ event: "sentence_end" }));
    expect((await iter.next()).value.type).toBe("sentence_end");
    await session.flush();
    await session.cancel();
    await session.finish();
    expect(s.sent.slice(-3).map((x) => x.event)).toEqual([
      "task_flush",
      "task_cancel",
      "task_finish",
    ]);
    s.input.push(JSON.stringify({ event: "task_finished" }));
    expect((await iter.next()).value.type).toBe("completed");
  });
  it.each([
    false,
    true,
  ])("bounds 2205 retry and never replays acknowledged audio (%s)", async (acknowledged) => {
    const s = socket();
    const pending = createMiniMaxSpeechSession(config, {
      url: "wss://example.test/ws",
      connect: async () => s.transport,
      headers: {},
      signal: new AbortController().signal,
      profile: "minimax-bidi",
    });
    s.input.push(JSON.stringify({ event: "connected_success" }));
    s.input.push(JSON.stringify({ event: "task_started" }));
    const session = await pending;
    const iter = session.events[Symbol.asyncIterator]();
    await iter.next();
    await session.append("Hello.");
    if (acknowledged) {
      s.input.push(JSON.stringify({ event: "task_continued", data: { audio: "01" } }));
      await iter.next();
    }
    s.input.push(JSON.stringify({ event: "task_continued", base_resp: { status_code: 2205 } }));
    if (acknowledged) {
      await expect(iter.next()).rejects.toThrow("cannot safely");
      expect(s.sent.filter((x) => x.event === "task_continue")).toHaveLength(1);
    } else {
      await new Promise((r) => setTimeout(r, 230));
      expect(s.sent.filter((x) => x.event === "task_continue")).toHaveLength(2);
      s.input.push(JSON.stringify({ event: "task_finished" }));
      expect((await iter.next()).value.type).toBe("completed");
    }
    session.close();
  });
  it("holds newer text behind an identified 2205 retry", async () => {
    const s = socket();
    const pending = createMiniMaxSpeechSession(config, {
      url: "wss://example.test/ws",
      connect: async () => s.transport,
      headers: {},
      signal: new AbortController().signal,
      profile: "minimax-bidi",
    });
    s.input.push(JSON.stringify({ event: "connected_success" }));
    s.input.push(JSON.stringify({ event: "task_started" }));
    const session = await pending;
    await session.append("one");
    s.input.push(JSON.stringify({ base_resp: { status_code: 2205 } }));
    await new Promise((r) => setTimeout(r, 0));
    await session.append("two");
    expect(s.sent.filter((x) => x.event === "task_continue").map((x) => x.text)).toEqual([
      "one",
      "one",
      "two",
    ]);
    session.close();
  });
  it("rejects ambiguous 2205 without reconnecting or replaying", async () => {
    const s = socket();
    const pending = createMiniMaxSpeechSession(config, {
      url: "wss://example.test/ws",
      connect: async () => s.transport,
      headers: {},
      signal: new AbortController().signal,
      profile: "minimax-bidi",
    });
    s.input.push(JSON.stringify({ event: "connected_success" }));
    s.input.push(JSON.stringify({ event: "task_started" }));
    const session = await pending;
    const iter = session.events[Symbol.asyncIterator]();
    await iter.next();
    await session.append("one");
    await session.append("two");
    s.input.push(JSON.stringify({ base_resp: { status_code: 2205 } }));
    await expect(iter.next()).rejects.toThrow("cannot safely");
    expect(s.sent.filter((x) => x.event === "task_continue")).toHaveLength(2);
    expect(s.sent.filter((x) => x.event === "task_start")).toHaveLength(1);
  });
  it("emits billing once per request and preserves first-use voice charges", async () => {
    const s = socket();
    const pending = createMiniMaxSpeechSession(config, {
      url: "wss://example.test/ws",
      connect: async () => s.transport,
      headers: {},
      signal: new AbortController().signal,
      profile: "minimax-bidi",
    });
    s.input.push(JSON.stringify({ event: "connected_success" }));
    s.input.push(JSON.stringify({ event: "task_started" }));
    const session = await pending;
    const iter = session.events[Symbol.asyncIterator]();
    await iter.next();
    s.input.push(
      JSON.stringify({
        event: "task_continued",
        extra_info: { usage_characters: 3, usage_voice_count: 1 },
      }),
    );
    s.input.push(
      JSON.stringify({
        event: "task_continued",
        is_final: true,
        extra_info: { usage_characters: 5 },
      }),
    );
    expect((await iter.next()).value).toMatchObject({
      type: "usage",
      usage: { usage_characters: 5, usage_voice_count: 1 },
    });
    expect((await iter.next()).value.type).toBe("request_final");
    session.close();
  });
  it("limits unread event memory", async () => {
    let stopped = false;
    const queue = speechQueue<string>(1, 3, () => {
      stopped = true;
    });
    queue.push("abc");
    queue.push("d");
    expect(stopped).toBe(true);
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("backpressure");
  });
});
